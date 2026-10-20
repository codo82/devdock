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
    { id: 'db1', label: 'DB 1', type: 'mysql', host: 'db.local', port: 3306, user: 'u', password: vaultLib.encrypt(key, 'segreto-db-1') },
    { id: 'db2', label: 'DB 2', type: 'mysql', host: 'db.local', port: 3306, user: 'u', password: null },
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

// ---- connessioni (con un MySQL usa e getta, se mysqld è installato) ----
const { startMysql } = require('./mysql');
const path = require('path');
const { tmpDir } = require('./helpers');

test('connessioni: CRUD, password mai esposte, prova di connessione', async t => {
  const mysqlDb = await startMysql();
  if (!mysqlDb) return t.skip('mysqld non installato');
  const s = await startServer({ groups: [], servers: [{ key: 'bastion', label: 'Bastion', port: 46010, remote: 'db:3306', alias: 'devdock-test.invalid' }], projects: [] });
  try {
    const api = (m, p, body) => s.request(m, `/api/ext/db-client${p}`, { body: body ?? (m === 'POST' || m === 'PUT' ? {} : undefined) });
    const conn = { id: 'locale', label: 'MySQL locale', host: '127.0.0.1', port: mysqlDb.port, database: 'app', user: 'devdock', password: 'devdock-pass' };

    // senza vault non si salvano password
    assert.equal((await api('POST', '/connections', conn)).status, 423);
    await api('POST', '/vault/init', { password: 'master-password-db' });

    for (const bad of [{ ...conn, id: 'x y' }, { ...conn, id: 'h', host: 'a b' }, { ...conn, id: 'p', port: 70000 }, { ...conn, id: 'd', database: 'a`b' }, { ...conn, id: 't', tunnel: 'inesistente' }]) {
      assert.equal((await api('POST', '/connections', bad)).status, 400, JSON.stringify(bad));
    }
    let r = await api('POST', '/connections', conn);
    assert.equal(r.status, 200);
    assert.equal(r.json.connection.hasPassword, true);
    assert.equal(r.json.connection.password, undefined);
    assert.equal((await api('POST', '/connections', conn)).status, 409);
    assert.doesNotMatch(fs.readFileSync(s.configPath, 'utf8'), /devdock-pass/);

    const list = (await api('GET', '/connections')).json;
    assert.equal(list.tunnelsAvailable, true);
    assert.deepEqual(Object.keys(list.connections[0]).sort(), ['database', 'hasPassword', 'host', 'id', 'label', 'port', 'readOnly', 'type', 'user']);

    r = await api('POST', '/connections/locale/test');
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.version, /^\d+\./);
    assert.equal(r.json.db, 'app');

    // modifica senza password: quella salvata resta
    r = await api('PUT', '/connections/locale', { label: 'Rinominata', password: '' });
    assert.equal(r.json.connection.label, 'Rinominata');
    assert.equal((await api('POST', '/connections/locale/test')).status, 200);

    // password sbagliata → errore del server MySQL
    await api('PUT', '/connections/locale', { password: 'sbagliata' });
    r = await api('POST', '/connections/locale/test');
    assert.equal(r.status, 502);
    assert.match(r.json.error, /Access denied/);

    // vault bloccato → 423
    await api('PUT', '/connections/locale', { password: 'devdock-pass' });
    await api('POST', '/vault/lock');
    assert.equal((await api('POST', '/connections/locale/test')).status, 423);
    await api('POST', '/vault/unlock', { password: 'master-password-db' });

    // via tunnel: il tunnel viene avviato, ssh fallisce subito sull'host .invalid
    r = await api('POST', '/connections', { id: 'via-tunnel', label: 'Via tunnel', tunnel: 'bastion', user: 'devdock' });
    assert.equal(r.status, 200);
    assert.equal(r.json.connection.host, undefined);
    r = await api('POST', '/connections/via-tunnel/test');
    assert.equal(r.status, 502);
    assert.match(r.json.error, /Tunnel "Bastion" non pronto/);

    assert.equal((await api('DELETE', '/connections/via-tunnel')).status, 200);
    assert.deepEqual((await api('GET', '/connections')).json.connections.map(c => c.id), ['locale']);
  } finally {
    await s.stop();
    await mysqlDb.stop();
  }
});

test('connessioni via tunnel non disponibili se l\'estensione tunnels non è attiva', async () => {
  // cartella estensioni con il solo db-client
  const dir = tmpDir('devdock-ext-db-');
  fs.symlinkSync(path.join(__dirname, '..', 'extensions', 'db-client'), path.join(dir, 'db-client'));
  const s = await startServer(undefined, { env: { DEVDOCK_EXTENSIONS_DIR: dir } });
  try {
    const ext = (await s.request('GET', '/api/core/extensions')).json.find(e => e.code === 'db-client');
    assert.equal(ext.state, 'warning');
    await s.request('POST', '/api/ext/db-client/vault/init', { body: { password: 'master-password-db' } });
    assert.equal((await s.request('GET', '/api/ext/db-client/connections')).json.tunnelsAvailable, false);
    const r = await s.request('POST', '/api/ext/db-client/connections', { body: { id: 'x', label: 'X', tunnel: 'qualsiasi', user: 'u' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Tunnels SSH non attiva/);
  } finally {
    await s.stop();
  }
});
