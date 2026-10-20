const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.stop());

test('estensione db-client caricata con mysql2 dalla workspace', async () => {
  const ext = (await srv.request('GET', '/api/core/extensions')).json.find(e => e.code === 'db-client');
  assert.equal(ext.state, 'ok');
  assert.deepEqual(ext.export.map(x => x.sections), [['dbConnections', 'vault']]);
  const info = (await srv.request('GET', '/api/ext/db-client/info')).json;
  assert.equal(info.driver, 'mysql2');
  assert.equal(info.ready, true);
});

const fs = require('fs');
const vaultLib = require('../extensions/db-client/vault');
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('vault: creazione, blocco, sblocco e tentativi ripetuti', async () => {
  const status = async () => (await srv.request('GET', '/api/ext/db-client/vault')).json;
  assert.equal((await status()).state, 'uninitialized');

  let r = await srv.request('POST', '/api/ext/db-client/vault/init', { body: { password: 'corta' } });
  assert.equal(r.status, 400);
  r = await srv.request('POST', '/api/ext/db-client/vault/init', { body: { password: 'master-password-1' } });
  assert.deepEqual(r.json, { ok: true, state: 'unlocked' });
  assert.equal((await srv.request('POST', '/api/ext/db-client/vault/init', { body: { password: 'master-password-1' } })).status, 409);

  const record = srv.readConfig().vault;
  assert.deepEqual(Object.keys(record).sort(), ['kdf', 'verifier', 'version']);
  assert.equal(record.kdf.alg, 'scrypt');
  assert.doesNotMatch(fs.readFileSync(srv.configPath, 'utf8'), /master-password-1/);

  await srv.request('POST', '/api/ext/db-client/vault/lock', { body: {} });
  assert.equal((await status()).state, 'locked');

  // dal terzo errore scatta l'attesa (1s)
  for (let i = 0; i < 3; i++) {
    assert.equal((await srv.request('POST', '/api/ext/db-client/vault/unlock', { body: { password: 'sbagliata-' + i } })).status, 401);
  }
  r = await srv.request('POST', '/api/ext/db-client/vault/unlock', { body: { password: 'master-password-1' } });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers['retry-after']) >= 1);
  await sleep(1100);
  r = await srv.request('POST', '/api/ext/db-client/vault/unlock', { body: { password: 'master-password-1' } });
  assert.equal(r.status, 200);
  assert.equal((await status()).state, 'unlocked');
});

test('vault: cambio della master password ri-cifra tutte le password; reset le cancella', async () => {
  // una connessione con password cifrata con la chiave attuale
  const cfg = srv.readConfig();
  const key = await vaultLib.openVault(cfg.vault, 'master-password-1');
  cfg.dbConnections = [
    { id: 'db1', label: 'DB 1', password: vaultLib.encrypt(key, 'segreto-db-1') },
    { id: 'db2', label: 'DB 2', password: null },
  ];
  fs.writeFileSync(srv.configPath, JSON.stringify(cfg));

  let r = await srv.request('POST', '/api/ext/db-client/vault/change', { body: { oldPassword: 'errata-errata', newPassword: 'nuova-master-2' } });
  assert.equal(r.status, 401);
  await sleep(1100); // attesa dovuta al tentativo errato precedente
  r = await srv.request('POST', '/api/ext/db-client/vault/change', { body: { oldPassword: 'master-password-1', newPassword: 'nuova-master-2' } });
  assert.deepEqual(r.json, { ok: true, reencrypted: 1 });

  const after = srv.readConfig();
  assert.equal(await vaultLib.openVault(after.vault, 'master-password-1'), null);
  const newKey = await vaultLib.openVault(after.vault, 'nuova-master-2');
  assert.equal(vaultLib.decrypt(newKey, after.dbConnections[0].password), 'segreto-db-1');
  assert.doesNotMatch(fs.readFileSync(srv.configPath, 'utf8'), /segreto-db-1|nuova-master-2/);

  assert.equal((await srv.request('POST', '/api/ext/db-client/vault/reset', { body: {} })).status, 400);
  r = await srv.request('POST', '/api/ext/db-client/vault/reset', { body: { confirm: 'RESET' } });
  assert.equal(r.json.state, 'uninitialized');
  const reset = srv.readConfig();
  assert.equal(reset.vault, null);
  assert.deepEqual(reset.dbConnections.map(c => c.password), [null, null]);
});

test('vault: timeout di inattività configurabile e validato', async () => {
  await srv.request('POST', '/api/ext/db-client/vault/init', { body: { password: 'master-password-3' } });
  assert.equal((await srv.request('POST', '/api/ext/db-client/vault/settings', { body: { lockAfterMinutes: 0 } })).status, 400);
  const r = await srv.request('POST', '/api/ext/db-client/vault/settings', { body: { lockAfterMinutes: 15 } });
  assert.equal(r.json.lockAfterMinutes, 15);
  assert.equal((await srv.request('GET', '/api/ext/db-client/vault')).json.lockAfterMinutes, 15);
  // il cambio di password conserva l'impostazione
  await srv.request('POST', '/api/ext/db-client/vault/change', { body: { oldPassword: 'master-password-3', newPassword: 'master-password-4' } });
  assert.equal(srv.readConfig().vault.lockAfterMinutes, 15);
});
