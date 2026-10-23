// Estensioni installate (cartella fuori dal repository, DEVDOCK_HOME/extensions) accanto alle
// incluse: caricate entrambe, codice duplicato segnalato come errore, cartelle di servizio ignorate
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir, writeExtension, manifest } = require('../lib/testkit');

const api = code => `module.exports = () => ({ handlers: { hello: (req, res) => res.json({ from: '${code}' }) } });`;
const withRoute = (code, extra = {}) => manifest(code, { backend: { module: 'server.js', routes: [{ method: 'GET', path: '/hello', handler: 'hello' }] }, ...extra });

let srv;
before(async () => {
  const builtin = tmpDir('devdock-builtin-');
  writeExtension(builtin, 'base', { 'setting.json': withRoute('base'), 'server.js': api('base incluso') });
  const elsewhere = tmpDir('devdock-installed-');
  const extra = writeExtension(elsewhere, 'extra', { 'setting.json': withRoute('extra', { dependencies: [{ code: 'base', required: true }] }), 'server.js': api('extra installata') });
  const dup = writeExtension(tmpDir('devdock-dup-'), 'base', { 'setting.json': withRoute('base'), 'server.js': api('base installata') });
  srv = await startServer({ projects: [] }, { extensions: builtin, install: [extra, dup] });
  // cartella di servizio (staging, backup) nella cartella delle installate: ignorata
  fs.mkdirSync(path.join(srv.home, 'extensions', '.staging'));
});
after(() => srv?.stop());

test('incluse e installate caricate insieme, con la loro provenienza', async () => {
  const list = (await srv.request('GET', '/api/core/extensions')).json;
  const extra = list.find(e => e.code === 'extra');
  assert.deepEqual([extra.state, extra.source], ['ok', 'installed']);
  assert.deepEqual((await srv.request('GET', '/api/ext/extra/hello')).json, { from: 'extra installata' });
});

test('stesso codice in entrambe: vince l\'inclusa, l\'altra è segnalata come errore', async () => {
  const list = (await srv.request('GET', '/api/core/extensions')).json.filter(e => e.code === 'base');
  assert.equal(list.length, 2);
  const builtin = list.find(e => e.source === 'builtin');
  const installed = list.find(e => e.source === 'installed');
  assert.equal(builtin.state, 'ok');
  assert.equal(installed.state, 'disabled');
  assert.match(installed.error, /codice "base" già usato dall'estensione in/);
  assert.deepEqual((await srv.request('GET', '/api/ext/base/hello')).json, { from: 'base incluso' });
});
