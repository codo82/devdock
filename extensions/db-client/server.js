// Database: connessioni MySQL/MariaDB (sezione "dbConnections"), password cifrate
// con una master password (sezione "vault"), query con timeout e limite di righe.
const mysql = require('mysql2/promise');
const vaultLib = require('./vault');

const DEFAULT_LOCK_MINUTES = 30;

module.exports = function createDbClient(ctx) {
  const { ConfigError } = ctx.lib.config;

  const vault = () => ctx.config.get('vault');
  const connections = () => ctx.config.get('dbConnections');

  // ---- sessione del vault: la chiave vive solo in memoria ----

  const session = { key: null, lastUse: 0 };
  const lockAfterMs = () => (vault()?.lockAfterMinutes ?? DEFAULT_LOCK_MINUTES) * 60000;

  function lock() { session.key = null; }

  // Chiave di cifratura se il vault è sbloccato e non scaduto per inattività
  function currentKey() {
    if (session.key && Date.now() - session.lastUse > lockAfterMs()) lock();
    if (session.key) session.lastUse = Date.now();
    return session.key;
  }

  function vaultState() {
    if (!vault()) return 'uninitialized';
    return currentKey() ? 'unlocked' : 'locked';
  }

  // Protezione dai tentativi ripetuti: dal terzo errore attesa doppia ogni volta (max 30s)
  const throttle = { failures: 0, retryAt: 0 };
  function registerFailure() {
    throttle.failures++;
    const delay = throttle.failures < 3 ? 0 : Math.min(1000 * 2 ** (throttle.failures - 3), 30000);
    throttle.retryAt = Date.now() + delay;
  }

  // Password in chiaro di una connessione (solo lato server, al momento di connettersi)
  function decryptPassword(conn) {
    if (!conn.password) return '';
    const key = currentKey();
    if (!key) throw Object.assign(new Error('Vault bloccato: inserisci la master password'), { status: 423 });
    return vaultLib.decrypt(key, conn.password);
  }

  // ---- regole delle sezioni di config ----

  const config = {
    vault: {
      empty: null,
      validate(record) {
        try { vaultLib.validateRecord(record); } catch (e) { throw new ConfigError(e.message); }
        if (record && record.lockAfterMinutes != null
            && !(Number.isInteger(record.lockAfterMinutes) && record.lockAfterMinutes >= 1 && record.lockAfterMinutes <= 1440)) {
          throw new ConfigError('vault: lockAfterMinutes deve essere tra 1 e 1440');
        }
      },
    },
    dbConnections: {
      empty: [], idField: 'id',
      validate(list, cfg) {
        if (!Array.isArray(list)) throw new ConfigError('Config non valida: "dbConnections" deve essere una lista');
        for (const c of list) {
          if (c.password != null && !vaultLib.isBox(c.password)) throw new ConfigError(`connessione "${c?.id}": password non cifrata`);
          if (c.password != null && !cfg.vault) throw new ConfigError(`connessione "${c?.id}": password cifrata senza vault`);
        }
      },
    },
  };

  const vaultError = (res, status, error) => res.status(status).json({ error });

  return {
    config,

    handlers: {
      info(req, res) {
        res.json({ driver: 'mysql2', version: require('mysql2/package.json').version, ready: typeof mysql.createPool === 'function' });
      },

      // ---- vault ----

      vaultStatus(req, res) {
        res.json({
          state: vaultState(),
          lockAfterMinutes: vault()?.lockAfterMinutes ?? DEFAULT_LOCK_MINUTES,
          minLength: vaultLib.MIN_PASSWORD,
          retryAfter: Math.max(0, Math.ceil((throttle.retryAt - Date.now()) / 1000)),
        });
      },

      async vaultInit(req, res) {
        if (vault()) return vaultError(res, 409, 'La master password è già stata creata');
        let created;
        try { created = await vaultLib.createVault(req.body.password); }
        catch (e) { return vaultError(res, 400, e.message); }
        ctx.config.set('vault', created.record);
        session.key = created.encKey;
        session.lastUse = Date.now();
        res.json({ ok: true, state: 'unlocked' });
      },

      async vaultUnlock(req, res) {
        const record = vault();
        if (!record) return vaultError(res, 409, 'Master password non ancora creata');
        const wait = Math.ceil((throttle.retryAt - Date.now()) / 1000);
        if (wait > 0) {
          res.setHeader('Retry-After', String(wait));
          return vaultError(res, 429, `Troppi tentativi: riprova tra ${wait}s`);
        }
        const key = await vaultLib.openVault(record, req.body.password);
        if (!key) {
          registerFailure();
          return vaultError(res, 401, 'Master password errata');
        }
        throttle.failures = 0;
        throttle.retryAt = 0;
        session.key = key;
        session.lastUse = Date.now();
        res.json({ ok: true, state: 'unlocked' });
      },

      vaultLock(req, res) {
        lock();
        res.json({ ok: true, state: vault() ? 'locked' : 'uninitialized' });
      },

      // Nuova master password: tutte le password vengono ri-cifrate e salvate insieme al vault
      async vaultChange(req, res) {
        const record = vault();
        if (!record) return vaultError(res, 409, 'Master password non ancora creata');
        const oldKey = await vaultLib.openVault(record, req.body.oldPassword);
        if (!oldKey) { registerFailure(); return vaultError(res, 401, 'Master password attuale errata'); }
        let created;
        try { created = await vaultLib.createVault(req.body.newPassword); }
        catch (e) { return vaultError(res, 400, e.message); }
        const reencrypted = connections().map(c => c.password
          ? { ...c, password: vaultLib.encrypt(created.encKey, vaultLib.decrypt(oldKey, c.password)) }
          : c);
        const lockAfterMinutes = record.lockAfterMinutes;
        ctx.config.update({
          vault: lockAfterMinutes ? { ...created.record, lockAfterMinutes } : created.record,
          dbConnections: reencrypted,
        });
        session.key = created.encKey;
        session.lastUse = Date.now();
        res.json({ ok: true, reencrypted: reencrypted.filter(c => c.password).length });
      },

      // Password dimenticata: si cancellano vault e password salvate (le connessioni restano)
      vaultReset(req, res) {
        if (req.body.confirm !== 'RESET') return vaultError(res, 400, 'Conferma mancante');
        const cleared = connections().map(c => ({ ...c, password: null }));
        ctx.config.update({ dbConnections: cleared, vault: null });
        lock();
        res.json({ ok: true, state: 'uninitialized' });
      },

      vaultSettings(req, res) {
        const record = vault();
        if (!record) return vaultError(res, 409, 'Master password non ancora creata');
        const minutes = Number(req.body.lockAfterMinutes);
        ctx.config.set('vault', { ...record, lockAfterMinutes: minutes });
        res.json({ ok: true, lockAfterMinutes: minutes });
      },
    },

    services: { decryptPassword },
  };
};
