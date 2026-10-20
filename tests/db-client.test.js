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
