const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.stop());

const server = (over = {}) => ({ key: 'db', label: 'DB', port: 3306, remote: '10.0.0.1:3306', alias: 'bastion', ...over });

test('CRUD server e gruppi con validazione', async () => {
  assert.equal((await srv.request('POST', '/api/config/servers', { body: server() })).status, 200);
  assert.equal((await srv.request('POST', '/api/config/servers', { body: server() })).status, 409);

  const bad = [
    server({ key: 'x1', port: 99999 }),
    server({ key: 'x2', alias: '-oProxyCommand=evil' }),
    server({ key: 'x3', remote: 'host-senza-porta' }),
    server({ key: 'a b' }),
  ];
  for (const body of bad) {
    const r = await srv.request('POST', '/api/config/servers', { body });
    assert.equal(r.status, 400, `atteso 400 per ${JSON.stringify(body)}`);
  }

  assert.equal((await srv.request('POST', '/api/config/groups', { body: { key: 'g', label: 'G', color: 'red;x:y' } })).status, 400);
  assert.equal((await srv.request('POST', '/api/config/groups', { body: { key: 'g', label: 'G', color: '#ff0000' } })).status, 200);
  assert.equal((await srv.request('PUT', '/api/config/groups/g', { body: { servers: ['nope'] } })).status, 400);
  assert.equal((await srv.request('PUT', '/api/config/groups/g', { body: { servers: ['db'], evil: 1 } })).status, 200);
  assert.equal((await srv.request('PUT', '/api/config/servers/db', { body: { port: '3307' } })).status, 200);

  const cfg = srv.readConfig();
  assert.deepEqual(cfg.groups, [{ key: 'g', label: 'G', color: '#ff0000', servers: ['db'] }]);
  assert.equal(cfg.servers[0].port, 3307);

  const groups = await srv.request('GET', '/api/groups');
  assert.equal(groups.json[0].servers[0].key, 'db');

  assert.equal((await srv.request('DELETE', '/api/config/servers/db')).status, 200);
  assert.deepEqual(srv.readConfig().groups[0].servers, []);
});

test('progetti: percorso assoluto obbligatorio, PUT solo campi noti', async () => {
  assert.equal((await srv.request('POST', '/api/projects', { body: { id: 'rel', label: 'R', path: '.' } })).status, 400);
  assert.equal((await srv.request('POST', '/api/projects', { body: { id: 'tmp', label: 'T', path: require('os').tmpdir() } })).status, 200);
  assert.equal((await srv.request('PUT', '/api/projects/tmp', { body: { label: 'Nuovo', id: 'hack' } })).status, 200);
  assert.deepEqual(srv.readConfig().projects.map(p => [p.id, p.label]), [['tmp', 'Nuovo']]);
  assert.equal((await srv.request('DELETE', '/api/projects/tmp')).status, 200);
});

test('import: sezioni parziali, merge e replace', async () => {
  const tunnels = {
    groups: [{ key: 'g2', label: 'G2', color: '#112233', servers: ['s1'] }],
    servers: [server({ key: 's1', port: 1001 })],
  };
  let r = await srv.request('POST', '/api/config/import', { body: { mode: 'merge', config: tunnels } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.sections, ['groups', 'servers']);

  r = await srv.request('POST', '/api/config/import', {
    body: { mode: 'merge', config: { projects: [{ id: 'q', label: 'Q', path: '/tmp/q' }] } },
  });
  assert.equal(r.status, 200);
  let cfg = srv.readConfig();
  assert.ok(cfg.servers.some(s => s.key === 's1'));
  assert.deepEqual(cfg.projects.map(p => p.id), ['q']);

  // replace di una sola sezione non tocca le altre
  r = await srv.request('POST', '/api/config/import', {
    body: { mode: 'replace', config: { projects: [{ id: 'z', label: 'Z', path: '/tmp/z' }] } },
  });
  assert.equal(r.status, 200);
  cfg = srv.readConfig();
  assert.deepEqual(cfg.projects.map(p => p.id), ['z']);
  assert.ok(cfg.servers.some(s => s.key === 's1'));

  // risultato non valido (gruppi verso server rimossi) → 400 e config invariata
  r = await srv.request('POST', '/api/config/import', { body: { mode: 'replace', config: { servers: [] } } });
  assert.equal(r.status, 400);
  assert.ok(srv.readConfig().servers.some(s => s.key === 's1'));

  r = await srv.request('POST', '/api/config/import', { body: { mode: 'merge', config: { foo: 1 } } });
  assert.equal(r.status, 400);
  r = await srv.request('POST', '/api/config/import', { body: { mode: 'boh', config: tunnels } });
  assert.equal(r.status, 400);
});

test('export per tipo', async () => {
  const git = await srv.request('GET', '/api/config/export?type=git');
  assert.deepEqual(Object.keys(git.json), ['projects']);
  assert.match(git.headers['content-disposition'], /devdock-config-git-/);
  const tunnels = await srv.request('GET', '/api/config/export?type=tunnels');
  assert.deepEqual(Object.keys(tunnels.json).sort(), ['groups', 'servers']);
});

test('PUT /api/config valida lo schema', async () => {
  assert.equal((await srv.request('PUT', '/api/config', { body: { groups: 5 } })).status, 400);
});
