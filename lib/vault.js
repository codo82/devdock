// Vault della master password, del core: sezione "vault" di config.json (solo il
// verificatore e i parametri di derivazione, mai una chiave), chiave di cifratura solo in
// memoria, blocco per inattività, protezione dai tentativi ripetuti. Le estensioni cifrano
// i loro segreti con ctx.vault e si registrano per la ri-cifratura e il reset.
const crypto = require('./vault-crypto');
const { registerSection, loadConfig, saveConfig } = require('./config');
const { coreError } = require('./errors');

const DEFAULT_LOCK_MINUTES = 30;

let allowSwitch = false; // vero solo durante il cambio della master password e il reset
const record = () => loadConfig().vault;

registerSection('vault', {
  owner: 'core', empty: null,
  // Import in modalità unione: lo stesso vault (stesso verificatore) o nessuno attuale
  merge(current, incoming) {
    if (current && incoming && current.verifier !== incoming.verifier) throw coreError.config('vault_other_password');
    return current ?? incoming;
  },
  validate(value) {
    try { crypto.validateRecord(value); } catch (e) { throw coreError.config(e.key || 'vault_record_invalid'); }
    // Un'altra master password renderebbe illeggibili i segreti salvati: si cambia solo con
    // change() (che ri-cifra tutto) o da un import che li converte (es. connessioni database)
    const current = loadConfig().vault;
    if (current && value && current.verifier !== value.verifier && !allowSwitch) throw coreError.config('vault_other_password');
    if (value && value.lockAfterMinutes != null
        && !(Number.isInteger(value.lockAfterMinutes) && value.lockAfterMinutes >= 1 && value.lockAfterMinutes <= 1440)) {
      throw coreError.config('vault_lock_minutes');
    }
  },
});

// ---- sessione: la chiave vive solo in memoria ----

const session = { key: null, lastUse: 0 };
const consumers = []; // { owner, owned: Set(sezioni), rekey(reencrypt), reset(), lock() }
const lockAfterMs = () => (record()?.lockAfterMinutes ?? DEFAULT_LOCK_MINUTES) * 60000;

function lock() {
  const wasOpen = !!session.key;
  session.key = null;
  if (wasOpen) for (const c of consumers) { try { c.lock?.(); } catch (e) { console.error(`[vault] ${c.owner}:`, e.message); } }
}

// Chiave se il vault è sbloccato e non scaduto per inattività
function currentKey() {
  if (session.key && Date.now() - session.lastUse > lockAfterMs()) lock();
  if (session.key) session.lastUse = Date.now();
  return session.key;
}

function open(key) {
  session.key = key;
  session.lastUse = Date.now();
}

function state() {
  if (!record()) return 'uninitialized';
  return currentKey() ? 'unlocked' : 'locked';
}

// Dal terzo errore attesa doppia ogni volta (max 30 s)
const throttle = { failures: 0, retryAt: 0 };
function registerFailure() {
  throttle.failures++;
  const delay = throttle.failures < 3 ? 0 : Math.min(1000 * 2 ** (throttle.failures - 3), 30000);
  throttle.retryAt = Date.now() + delay;
}
function checkThrottle() {
  const wait = Math.ceil((throttle.retryAt - Date.now()) / 1000);
  if (wait > 0) throw coreError(429, 'too_many_attempts', { seconds: wait }, { retryAfter: wait });
}

const libError = e => (e?.key ? coreError(400, e.key, e.params) : e); // errori di vault-crypto

function requireKey() {
  const key = currentKey();
  if (!key) throw coreError(423, record() ? 'vault_locked' : 'vault_missing');
  return key;
}

// ---- operazioni ----

function status() {
  return {
    state: state(),
    lockAfterMinutes: record()?.lockAfterMinutes ?? DEFAULT_LOCK_MINUTES,
    minLength: crypto.MIN_PASSWORD,
    retryAfter: Math.max(0, Math.ceil((throttle.retryAt - Date.now()) / 1000)),
  };
}

async function init(password) {
  if (record()) throw coreError(409, 'vault_exists');
  let created;
  try { created = await crypto.createVault(password); } catch (e) { throw libError(e); }
  const cfg = loadConfig();
  cfg.vault = created.record;
  saveConfig(cfg);
  open(created.encKey);
  return { ok: true, state: 'unlocked' };
}

async function unlock(password) {
  const rec = record();
  if (!rec) throw coreError(409, 'vault_missing');
  checkThrottle();
  const key = await crypto.openVault(rec, password);
  if (!key) { registerFailure(); throw coreError(401, 'wrong_password'); }
  throttle.failures = 0;
  throttle.retryAt = 0;
  open(key);
  return { ok: true, state: 'unlocked' };
}

// Nuova master password: il vault e i segreti ri-cifrati di tutte le estensioni registrate
// vengono salvati con un'unica scrittura di config.json
async function change(oldPassword, newPassword) {
  const rec = record();
  if (!rec) throw coreError(409, 'vault_missing');
  checkThrottle();
  const oldKey = await crypto.openVault(rec, oldPassword);
  if (!oldKey) { registerFailure(); throw coreError(401, 'wrong_current_password'); }
  let created;
  try { created = await crypto.createVault(newPassword); } catch (e) { throw libError(e); }
  const reencrypt = box => crypto.encrypt(created.encKey, crypto.decrypt(oldKey, box));
  const cfg = loadConfig();
  let count = 0;
  for (const c of consumers) {
    const out = c.rekey?.(reencrypt, cfg) || {};
    for (const [key, value] of Object.entries(out.sections || {})) {
      if (!c.owned.has(key)) throw new Error(`[vault] ${c.owner} non può scrivere la sezione ${key}`);
      cfg[key] = value;
    }
    count += out.count || 0;
  }
  cfg.vault = rec.lockAfterMinutes ? { ...created.record, lockAfterMinutes: rec.lockAfterMinutes } : created.record;
  allowSwitch = true;
  try { saveConfig(cfg); } finally { allowSwitch = false; }
  open(created.encKey);
  return { ok: true, reencrypted: count };
}

// Password dimenticata: vault e segreti cancellati (in un'unica scrittura); il resto resta
function reset(confirm) {
  if (confirm !== 'RESET') throw coreError(400, 'confirm_missing');
  const cfg = loadConfig();
  for (const c of consumers) {
    for (const [key, value] of Object.entries(c.reset?.(cfg) || {})) {
      if (!c.owned.has(key)) throw new Error(`[vault] ${c.owner} non può scrivere la sezione ${key}`);
      cfg[key] = value;
    }
  }
  cfg.vault = null;
  allowSwitch = true;
  try { saveConfig(cfg); } finally { allowSwitch = false; }
  lock();
  return { ok: true, state: 'uninitialized' };
}

function settings(lockAfterMinutes) {
  const rec = record();
  if (!rec) throw coreError(409, 'vault_missing');
  const cfg = loadConfig();
  cfg.vault = { ...rec, lockAfterMinutes: Number(lockAfterMinutes) };
  saveConfig(cfg);
  return { ok: true, lockAfterMinutes: cfg.vault.lockAfterMinutes };
}

// ---- servizio per le estensioni (ctx.vault) ----

// owner: codice dell'estensione; owned: le sue sezioni di config (le sole che può riscrivere)
function forExtension(owner, owned) {
  return {
    state,
    isBox: crypto.isBox,
    // blocco "vault" valido (es. di un file da importare)
    isRecord(value) { try { crypto.validateRecord(value); return !!value; } catch { return false; } },
    encrypt(plaintext) { return crypto.encrypt(requireKey(), plaintext); },
    decrypt(box) {
      const key = requireKey();
      try { return crypto.decrypt(key, box); } catch { throw coreError(400, 'secret_unreadable'); }
    },
    // Segreti cifrati con un altro vault (file importato): { decrypt(box) } o null se la
    // password è sbagliata (conta come tentativo fallito)
    async openForeign(foreignRecord, password) {
      try { crypto.validateRecord(foreignRecord); } catch { return null; }
      if (!foreignRecord) return null;
      checkThrottle();
      const key = await crypto.openVault(foreignRecord, password);
      if (!key) { registerFailure(); return null; }
      return { decrypt: box => crypto.decrypt(key, box) };
    },
    // { rekey(reencrypt, cfg) → { sections: { chiave: valore }, count }, reset(cfg) → { chiave: valore }, lock() }
    register(consumer) {
      const entry = { owner, owned: new Set(owned), ...consumer };
      const i = consumers.findIndex(c => c.owner === owner);
      if (i >= 0) consumers[i] = entry; else consumers.push(entry); // ricaricata: sostituisce la precedente
    },
    unregister() {
      const i = consumers.findIndex(c => c.owner === owner);
      if (i >= 0) consumers.splice(i, 1);
    },
  };
}

module.exports = { status, init, unlock, lock, change, reset, settings, state, forExtension, DEFAULT_LOCK_MINUTES };
