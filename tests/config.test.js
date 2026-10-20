const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.stop());

const server = (over = {}) => ({ key: 'db', label: 'DB', port: 3306, remote: '10.0.0.1:3306', alias: 'bastion', ...over });

test('progetti: percorso assoluto obbligatorio, PUT solo campi noti', async () => {
  assert.equal((await srv.request('POST', '/api/ext/npm/projects', { body: { id: 'rel', label: 'R', path: '.' } })).status, 400);
  assert.equal((await srv.request('POST', '/api/ext/npm/projects', { body: { id: 'tmp', label: 'T', path: require('os').tmpdir() } })).status, 200);
  assert.equal((await srv.request('PUT', '/api/ext/npm/projects/tmp', { body: { label: 'Nuovo', id: 'hack' } })).status, 200);
  assert.deepEqual(srv.readConfig().projects.map(p => [p.id, p.label]), [['tmp', 'Nuovo']]);
  assert.equal((await srv.request('DELETE', '/api/ext/npm/projects/tmp')).status, 200);
});

test('import: sezioni parziali, merge e replace', async () => {
  const tunnels = {
    groups: [{ key: 'g2', label: 'G2', color: '#112233', servers: ['s1'] }],
    servers: [server({ key: 's1', port: 1001 })],
  };
  let r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'merge', config: tunnels } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.sections, ['groups', 'servers']);

  r = await srv.request('POST', '/api/core/config/import', {
    body: { mode: 'merge', config: { projects: [{ id: 'q', label: 'Q', path: '/tmp/q' }] } },
  });
  assert.equal(r.status, 200);
  let cfg = srv.readConfig();
  assert.ok(cfg.servers.some(s => s.key === 's1'));
  assert.deepEqual(cfg.projects.map(p => p.id), ['q']);

  // replace di una sola sezione non tocca le altre
  r = await srv.request('POST', '/api/core/config/import', {
    body: { mode: 'replace', config: { projects: [{ id: 'z', label: 'Z', path: '/tmp/z' }] } },
  });
  assert.equal(r.status, 200);
  cfg = srv.readConfig();
  assert.deepEqual(cfg.projects.map(p => p.id), ['z']);
  assert.ok(cfg.servers.some(s => s.key === 's1'));

  // risultato non valido (gruppi verso server rimossi) → 400 e config invariata
  r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'replace', config: { servers: [] } } });
  assert.equal(r.status, 400);
  assert.ok(srv.readConfig().servers.some(s => s.key === 's1'));

  r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'merge', config: { foo: 1 } } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /sezioni riconosciute/);
  r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'boh', config: tunnels } });
  assert.equal(r.status, 400);
});

test('sezioni: groups/servers appartengono all\'estensione tunnels, projects a npm', async () => {
  const sections = Object.fromEntries((await srv.request('GET', '/api/core/config/sections')).json.map(x => [x.key, x.owner]));
  assert.equal(sections.groups, 'tunnels');
  assert.equal(sections.servers, 'tunnels');
  assert.equal(sections.projects, 'npm');
});

test('export per tipo', async () => {
  const git = await srv.request('GET', '/api/core/config/export?name=git&sections=projects');
  assert.deepEqual(Object.keys(git.json), ['projects']);
  assert.match(git.headers['content-disposition'], /devdock-config-git-/);
  const tunnels = await srv.request('GET', '/api/core/config/export?name=tunnels&sections=groups,servers');
  assert.deepEqual(Object.keys(tunnels.json).sort(), ['groups', 'servers']);
});
