// Vault della master password del core: creazione, sblocco, tentativi ripetuti, timeout,
// cambio della password con la ri-cifratura dei segreti delle estensioni, reset
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer, tmpDir, writeExtension, manifest } = require('../lib/testkit');
const vaultLib = require('../lib/vault-crypto');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Estensione di prova che salva segreti cifrati con ctx.vault nella sua sezione "secrets"
function secretExtension() {
  const root = tmpDir('devdock-vault-ext-');
  writeExtension(root, 'secret', {
    'setting.json': manifest('secret', {
      config: ['secrets'],
      export: [{ id: 'all', label: 'Secrets', sections: ['secrets', 'vault'] }],
      backend: { module: 'server.js', routes: [
        { method: 'POST', path: '/secrets', handler: 'save' },
        { method: 'GET', path: '/secrets/:name', handler: 'read' },
      ] },
    }),
    'server.js': `module.exports = ctx => {
      const list = () => ctx.config.get('secrets');
      ctx.vault.register({
        rekey: (reencrypt, cfg) => ({ sections: { secrets: cfg.secrets.map(s => ({ ...s, box: reencrypt(s.box) })) }, count: cfg.secrets.length }),
        reset: cfg => ({ secrets: [] }),
      });
      return {
        config: { secrets: { empty: [], validate(v, cfg) { if (v.length && !cfg.vault) throw new ctx.lib.config.ConfigError('segreti senza vault'); } } },
        handlers: {
          save(req, res) { ctx.config.set('secrets', [...list(), { name: req.body.name, box: ctx.vault.encrypt(req.body.value) }]); res.json({ ok: true }); },
          read(req, res) { const s = list().find(x => x.name === req.params.name); res.json({ value: ctx.vault.decrypt(s.box) }); },
        },
      };
    };`,
  });
  return root;
}

let srv;
before(async () => { srv = await startServer({ projects: [] }, { extensions: secretExtension() }); });
after(() => srv.stop());

const status = async () => (await srv.request('GET', '/api/core/vault')).json;

test('creazione, blocco, sblocco e tentativi ripetuti', async () => {
  const status = async () => (await srv.request('GET', '/api/core/vault')).json;
  assert.equal((await status()).state, 'uninitialized');

  let r = await srv.request('POST', '/api/core/vault/init', { body: { password: 'corta' } });
  assert.equal(r.status, 400);
  r = await srv.request('POST', '/api/core/vault/init', { body: { password: 'master-password-1' } });
  assert.deepEqual(r.json, { ok: true, state: 'unlocked' });
  assert.equal((await srv.request('POST', '/api/core/vault/init', { body: { password: 'master-password-1' } })).status, 409);

  const record = srv.readConfig().vault;
  assert.deepEqual(Object.keys(record).sort(), ['kdf', 'verifier', 'version']);
  assert.equal(record.kdf.alg, 'scrypt');
  assert.doesNotMatch(fs.readFileSync(srv.configPath, 'utf8'), /master-password-1/);

  await srv.request('POST', '/api/core/vault/lock', { body: {} });
  assert.equal((await status()).state, 'locked');

  // dal terzo errore scatta l'attesa (1s)
  for (let i = 0; i < 3; i++) {
    assert.equal((await srv.request('POST', '/api/core/vault/unlock', { body: { password: 'sbagliata-' + i } })).status, 401);
  }
  r = await srv.request('POST', '/api/core/vault/unlock', { body: { password: 'master-password-1' } });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers['retry-after']) >= 1);
  await sleep(1100);
  r = await srv.request('POST', '/api/core/vault/unlock', { body: { password: 'master-password-1' } });
  assert.equal(r.status, 200);
  assert.equal((await status()).state, 'unlocked');
});


test('le estensioni cifrano con ctx.vault: 423 con il vault bloccato, segreti mai in chiaro', async () => {
  let r = await srv.request('POST', '/api/ext/secret/secrets', { body: { name: 'api', value: 'segreto-123' } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await srv.request('GET', '/api/ext/secret/secrets/api')).json.value, 'segreto-123');
  assert.doesNotMatch(fs.readFileSync(srv.configPath, 'utf8'), /segreto-123/);
  await srv.request('POST', '/api/core/vault/lock', { body: {} });
  r = await srv.request('GET', '/api/ext/secret/secrets/api');
  assert.deepEqual([r.status, r.json.code], [423, 'core.vault_locked']);
  await srv.request('POST', '/api/core/vault/unlock', { body: { password: 'master-password-1' } });
  // la casella di export dell'estensione può includere il blocco vault del core
  const ext = (await srv.request('GET', '/api/core/extensions')).json.find(e => e.code === 'secret');
  assert.deepEqual(ext.export[0].sections, ['secrets', 'vault']);
});

test('cambio della master password: segreti ri-cifrati insieme al vault; reset: cancellati', async () => {
  let r = await srv.request('POST', '/api/core/vault/change', { body: { oldPassword: 'errata-errata', newPassword: 'nuova-master-2' } });
  assert.deepEqual([r.status, r.json.code], [401, 'core.wrong_current_password']);
  await sleep(1100);
  r = await srv.request('POST', '/api/core/vault/change', { body: { oldPassword: 'master-password-1', newPassword: 'nuova-master-2' } });
  assert.deepEqual(r.json, { ok: true, reencrypted: 1 });
  const cfg = srv.readConfig();
  const key = await vaultLib.openVault(cfg.vault, 'nuova-master-2');
  assert.equal(vaultLib.decrypt(key, cfg.secrets[0].box), 'segreto-123');
  assert.equal((await srv.request('GET', '/api/ext/secret/secrets/api')).json.value, 'segreto-123');
  // un import con un altro vault è rifiutato (i segreti diventerebbero illeggibili)
  const other = (await vaultLib.createVault('altra-master-xyz')).record;
  r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'replace', config: { vault: other } } });
  assert.equal(r.json.code, 'core.vault_other_password');
  r = await srv.request('POST', '/api/core/vault/reset', { body: { confirm: 'RESET' } });
  assert.equal(r.json.state, 'uninitialized');
  assert.deepEqual([srv.readConfig().vault, srv.readConfig().secrets], [null, []]);
});

test('timeout di inattività configurabile e validato', async () => {
  await srv.request('POST', '/api/core/vault/init', { body: { password: 'master-password-3' } });
  assert.equal((await srv.request('POST', '/api/core/vault/settings', { body: { lockAfterMinutes: 0 } })).status, 400);
  const r = await srv.request('POST', '/api/core/vault/settings', { body: { lockAfterMinutes: 15 } });
  assert.equal(r.json.lockAfterMinutes, 15);
  assert.equal((await srv.request('GET', '/api/core/vault')).json.lockAfterMinutes, 15);
  // il cambio di password conserva l'impostazione
  await srv.request('POST', '/api/core/vault/change', { body: { oldPassword: 'master-password-3', newPassword: 'master-password-4' } });
  assert.equal(srv.readConfig().vault.lockAfterMinutes, 15);
});

