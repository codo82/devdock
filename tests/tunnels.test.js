const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
before(async () => {
  srv = await startServer({
    groups: [{ key: 'g', label: 'G', color: '#336699', servers: ['s'] }],
    // alias su dominio .invalid: ssh fallisce subito, senza contattare nessuno
    servers: [{ key: 's', label: 'Test', port: 45999, remote: 'db.internal:5432', alias: 'devdock-test.invalid', type: 'PostgreSQL' }],
    projects: [],
  });
});
after(() => srv.stop());

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('server sconosciuto o porta non valida → 400', async () => {
  assert.equal((await srv.request('POST', '/api/tunnels/start', { body: { serverKey: 'nope' } })).status, 400);
  for (const port of [0, 70000, -1, 'abc']) {
    const r = await srv.request('POST', '/api/tunnels/start', { body: { serverKey: 's', port } });
    assert.equal(r.status, 400, `atteso 400 per porta ${port}`);
  }
});

test('avvio, lista, log, porta occupata e stop di un tunnel', async () => {
  const r = await srv.request('POST', '/api/tunnels/start', { body: { serverKey: 's' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.port, 45999);

  assert.equal((await srv.request('POST', '/api/tunnels/start', { body: { serverKey: 's' } })).status, 409);

  const list = (await srv.request('GET', '/api/tunnels')).json;
  assert.deepEqual(list.map(t => [t.serverKey, t.port]), [['s', 45999]]);

  await sleep(500);
  const logs = (await srv.request('GET', `/api/tunnels/${r.json.id}/logs`)).json;
  assert.match(logs[0].text, /devdock-test\.invalid → 127\.0\.0\.1:45999 ↔ db\.internal:5432/);

  assert.equal((await srv.request('DELETE', `/api/tunnels/${r.json.id}`)).status, 200);
  assert.deepEqual((await srv.request('GET', '/api/tunnels')).json, []);
});

test('stop di tutti i tunnel', async () => {
  await srv.request('POST', '/api/tunnels/start', { body: { serverKey: 's', port: 46001 } });
  assert.equal((await srv.request('DELETE', '/api/tunnels')).status, 200);
  assert.deepEqual((await srv.request('GET', '/api/tunnels')).json, []);
});
