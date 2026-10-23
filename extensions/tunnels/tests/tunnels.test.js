const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../../../lib/testkit');

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
  assert.equal((await srv.request('POST', '/api/ext/tunnels/tunnels', { body: { serverKey: 'nope' } })).status, 400);
  for (const port of [0, 70000, -1, 'abc']) {
    const r = await srv.request('POST', '/api/ext/tunnels/tunnels', { body: { serverKey: 's', port } });
    assert.equal(r.status, 400, `atteso 400 per porta ${port}`);
  }
});

test('avvio, lista, log, porta occupata e stop di un tunnel', async () => {
  const r = await srv.request('POST', '/api/ext/tunnels/tunnels', { body: { serverKey: 's' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.port, 45999);

  assert.equal((await srv.request('POST', '/api/ext/tunnels/tunnels', { body: { serverKey: 's' } })).status, 409);

  const list = (await srv.request('GET', '/api/ext/tunnels/state')).json.tunnels;
  assert.deepEqual(list.map(t => [t.serverKey, t.port]), [['s', 45999]]);

  await sleep(500);
  const logs = (await srv.request('GET', `/api/ext/tunnels/tunnels/${r.json.id}/logs`)).json;
  assert.match(logs[0].text, /devdock-test\.invalid → 127\.0\.0\.1:45999 ↔ db\.internal:5432/);

  assert.equal((await srv.request('DELETE', `/api/ext/tunnels/tunnels/${r.json.id}`)).status, 200);
  assert.deepEqual((await srv.request('GET', '/api/ext/tunnels/state')).json.tunnels, []);
});

test('stop di tutti i tunnel', async () => {
  await srv.request('POST', '/api/ext/tunnels/tunnels', { body: { serverKey: 's', port: 46001 } });
  assert.equal((await srv.request('DELETE', '/api/ext/tunnels/tunnels')).status, 200);
  assert.deepEqual((await srv.request('GET', '/api/ext/tunnels/state')).json.tunnels, []);
});

const server = (over = {}) => ({ key: 'db', label: 'DB', port: 3306, remote: '10.0.0.1:3306', alias: 'bastion', ...over });

test('CRUD server e gruppi con validazione', async () => {
  assert.equal((await srv.request('POST', '/api/ext/tunnels/servers', { body: server() })).status, 200);
  assert.equal((await srv.request('POST', '/api/ext/tunnels/servers', { body: server() })).status, 409);

  const bad = [
    server({ key: 'x1', port: 99999 }),
    server({ key: 'x2', alias: '-oProxyCommand=evil' }),
    server({ key: 'x3', remote: 'host-senza-porta' }),
    server({ key: 'a b' }),
  ];
  for (const body of bad) {
    const r = await srv.request('POST', '/api/ext/tunnels/servers', { body });
    assert.equal(r.status, 400, `atteso 400 per ${JSON.stringify(body)}`);
  }

  assert.equal((await srv.request('POST', '/api/ext/tunnels/groups', { body: { key: 'grp', label: 'G', color: 'red;x:y' } })).status, 400);
  assert.equal((await srv.request('POST', '/api/ext/tunnels/groups', { body: { key: 'grp', label: 'G', color: '#ff0000' } })).status, 200);
  assert.equal((await srv.request('PUT', '/api/ext/tunnels/groups/grp', { body: { servers: ['nope'] } })).status, 400);
  assert.equal((await srv.request('PUT', '/api/ext/tunnels/groups/grp', { body: { servers: ['db'], evil: 1 } })).status, 200);
  assert.equal((await srv.request('PUT', '/api/ext/tunnels/servers/db', { body: { port: '3307' } })).status, 200);

  const cfg = srv.readConfig();
  assert.deepEqual(cfg.groups.find(g => g.key === 'grp'), { key: 'grp', label: 'G', color: '#ff0000', servers: ['db'] });
  assert.equal(cfg.servers.find(s => s.key === 'db').port, 3307);

  const state = await srv.request('GET', '/api/ext/tunnels/state');
  assert.equal(state.json.groups.find(g => g.key === 'grp').servers[0].key, 'db');

  assert.equal((await srv.request('DELETE', '/api/ext/tunnels/servers/db')).status, 200);
  assert.deepEqual(srv.readConfig().groups.find(g => g.key === 'grp').servers, []);
});


test('eliminare un gruppo elimina i suoi server che non stanno in altri gruppi', async () => {
  const srv2 = await startServer({
    groups: [
      { key: 'a', label: 'A', color: '#336699', servers: ['solo_a', 'condiviso'] },
      { key: 'b', label: 'B', color: '#336699', servers: ['condiviso'] },
    ],
    servers: [
      { key: 'solo_a', label: 'Solo A', port: 46201, remote: 'db:3306', alias: 'a.invalid' },
      { key: 'condiviso', label: 'Condiviso', port: 46202, remote: 'db:3306', alias: 'c.invalid' },
    ],
    projects: [],
  });
  try {
    const r = await srv2.request('DELETE', '/api/ext/tunnels/groups/a');
    assert.deepEqual(r.json, { ok: true, deletedServers: ['solo_a'] });
    const state = (await srv2.request('GET', '/api/ext/tunnels/state')).json;
    assert.deepEqual(state.servers.map(s => s.key), ['condiviso']);
    assert.deepEqual(state.groups.map(g => g.key), ['b']);
    assert.equal((await srv2.request('DELETE', '/api/ext/tunnels/groups/a')).status, 404);
  } finally { await srv2.stop(); }
});
