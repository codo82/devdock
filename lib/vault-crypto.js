// Cifratura dei segreti (password dei database, segreti delle estensioni) con una master password.
// scrypt ricava la chiave principale; HKDF-SHA256 ne ricava due sottochiavi
// indipendenti: encKey cifra (AES-256-GCM, IV casuale per valore), verifyKey serve
// solo alla verifica. In config.json si salva SHA-256(verifyKey), mai una chiave.
const crypto = require('crypto');

const VERSION = 1;
const KDF_DEFAULTS = { alg: 'scrypt', N: 131072, r: 8, p: 1 }; // ~128 MB di memoria per derivazione
const MIN_PASSWORD = 10;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const b64 = buf => Buffer.from(buf).toString('base64');
const unb64 = str => Buffer.from(str, 'base64');

function scrypt(password, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(key));
  });
}

async function deriveKeys(password, kdf) {
  const master = await scrypt(String(password).normalize('NFC'), unb64(kdf.salt), kdf);
  const sub = info => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
  return { encKey: sub('devdock-vault-enc'), verifyKey: sub('devdock-vault-verify') };
}

const verifierOf = verifyKey => b64(crypto.createHash('sha256').update(verifyKey).digest());

function checkPassword(password) {
  if (typeof password !== 'string' || [...password].length < MIN_PASSWORD) {
    // key/params: il server lo trasforma in un errore con codice traducibile
    throw Object.assign(new Error(`password_short`), { key: 'password_short', params: { min: MIN_PASSWORD } });
  }
}

// Nuovo vault: { record da salvare in config.json, encKey da tenere in memoria }
async function createVault(password, kdfOptions = {}) {
  checkPassword(password);
  const kdf = { ...KDF_DEFAULTS, ...kdfOptions, salt: b64(crypto.randomBytes(16)) };
  const { encKey, verifyKey } = await deriveKeys(password, kdf);
  return { record: { version: VERSION, kdf, verifier: verifierOf(verifyKey) }, encKey };
}

// encKey se la password è giusta, altrimenti null (confronto a tempo costante)
async function openVault(record, password) {
  if (typeof password !== 'string' || !password) return null;
  const { encKey, verifyKey } = await deriveKeys(password, record.kdf);
  const expected = unb64(record.verifier);
  const actual = unb64(verifierOf(verifyKey));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual) ? encKey : null;
}

function encrypt(encKey, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return { iv: b64(iv), tag: b64(cipher.getAuthTag()), data: b64(data) };
}

// Lancia un errore se il valore è stato alterato o cifrato con un'altra chiave
function decrypt(encKey, box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, unb64(box.iv));
  decipher.setAuthTag(unb64(box.tag));
  return Buffer.concat([decipher.update(unb64(box.data)), decipher.final()]).toString('utf8');
}

// Forma del blocco "vault" in config.json (null = non ancora creato)
function validateRecord(record) {
  if (record === null) return;
  const ok = record && record.version === VERSION && record.kdf?.alg === 'scrypt'
    && [record.kdf.N, record.kdf.r, record.kdf.p].every(Number.isInteger)
    && typeof record.kdf.salt === 'string' && B64_RE.test(record.kdf.salt)
    && typeof record.verifier === 'string' && B64_RE.test(record.verifier);
  if (!ok) throw Object.assign(new Error('vault_record_invalid'), { key: 'vault_record_invalid', params: {} });
}

const isBox = v => v && typeof v === 'object' && ['iv', 'tag', 'data'].every(k => typeof v[k] === 'string' && B64_RE.test(v[k]));

module.exports = { createVault, openVault, encrypt, decrypt, validateRecord, isBox, checkPassword, MIN_PASSWORD };
