// Ordine delle tab (sezione "layout" del core): API, validazione, codici sconosciuti scartati,
// ripristino dell'ordine dei manifest, import
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv?.stop());

const call = (m, p, body) => srv.request(m, `/api/core${p}`, body !== undefined ? { body } : {});

test('ordine predefinito: lista vuota', async () => {
  assert.deepEqual((await call('GET', '/layout')).json, { tabs: [] });
});

test('salvataggio: duplicati e codici sconosciuti o non di tab scartati', async () => {
  const r = await call('PUT', '/layout/tabs', { tabs: ['git', 'nope', 'npm', 'git', 'pm2', 'mock-server'] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { tabs: ['git', 'npm', 'mock-server'] }); // pm2 è un pulsante dell'header
  assert.deepEqual(srv.readConfig().layout, { tabs: ['git', 'npm', 'mock-server'] });
  assert.deepEqual((await call('GET', '/layout')).json.tabs, ['git', 'npm', 'mock-server']);
});

test('validazione della lista', async () => {
  for (const tabs of [undefined, 'git', [1, 2], [{}]]) {
    const r = await call('PUT', '/layout/tabs', { tabs });
    assert.equal(r.status, 400, JSON.stringify(tabs));
    assert.equal(r.json.code, 'core.layout_tabs');
  }
  // dall'import: codici non validi o ripetuti rifiutati
  let r = await call('POST', '/config/import', { mode: 'replace', config: { layout: { tabs: ['git', 'git'] } } });
  assert.equal(r.status, 400);
  r = await call('POST', '/config/import', { mode: 'replace', config: { layout: { tabs: ['Git!'] } } });
  assert.equal(r.status, 400);
  r = await call('POST', '/config/import', { mode: 'replace', config: { layout: { tabs: ['env', 'old-extension'], extra: 1 } } });
  assert.equal(r.status, 200, r.text);
  // un'estensione rimossa resta nella lista salvata ma la shell la ignora
  assert.deepEqual(srv.readConfig().layout, { tabs: ['env', 'old-extension'] });
});

test('ripristino dell\'ordine predefinito', async () => {
  const r = await call('DELETE', '/layout/tabs');
  assert.deepEqual(r.json, { tabs: [] });
  assert.deepEqual(srv.readConfig().layout, {});
});
