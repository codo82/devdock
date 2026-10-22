const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.stop());

const server = (over = {}) => ({ key: 'db', label: 'DB', port: 3306, remote: '10.0.0.1:3306', alias: 'bastion', ...over });

test('progetti: percorso assoluto obbligatorio, PUT solo campi noti', async () => {
  assert.equal((await srv.request('POST', '/api/core/projects', { body: { id: 'rel', label: 'R', path: '.' } })).json.code, 'core.path_absolute');
  assert.equal((await srv.request('POST', '/api/core/projects', { body: { id: 'tmp', label: 'T', path: require('os').tmpdir() } })).status, 200);
  assert.equal((await srv.request('POST', '/api/core/projects', { body: { id: 'tmp', label: 'T', path: require('os').tmpdir() } })).json.code, 'core.project_exists');
  assert.equal((await srv.request('PUT', '/api/core/projects/tmp', { body: { label: 'Nuovo', id: 'hack' } })).status, 200);
  assert.deepEqual(srv.readConfig().projects.map(p => [p.id, p.label]), [['tmp', 'Nuovo']]);
  assert.equal((await srv.request('DELETE', '/api/core/projects/tmp')).status, 200);
});

test('cartelle: creazione, spostamento dei progetti, eliminazione che li riporta nella radice', async () => {
  const dir = require('os').tmpdir();
  const f = (await srv.request('POST', '/api/core/folders', { body: { label: ' Clienti ' } })).json;
  assert.equal(f.label, 'Clienti');
  assert.equal((await srv.request('POST', '/api/core/folders', { body: { label: '  ' } })).json.code, 'core.folder_label_required');
  let r = await srv.request('POST', '/api/core/projects', { body: { id: 'a', label: 'A', path: dir, folder: f.id } });
  assert.equal(r.json.folder, f.id);
  await srv.request('POST', '/api/core/projects', { body: { id: 'b', label: 'B', path: dir } });
  assert.equal((await srv.request('PUT', '/api/core/projects/b', { body: { folder: 'nope' } })).json.code, 'core.folder_unknown');
  await srv.request('PUT', '/api/core/projects/b', { body: { folder: f.id } });
  await srv.request('PUT', '/api/core/folders/' + f.id, { body: { label: 'Lavoro' } });
  let data = (await srv.request('GET', '/api/core/projects')).json;
  assert.deepEqual(data.folders, [{ id: f.id, label: 'Lavoro' }]);
  assert.deepEqual(data.projects.map(p => [p.id, p.folder]), [['a', f.id], ['b', f.id]]);
  await srv.request('PUT', '/api/core/projects/a', { body: { folder: '' } }); // di nuovo nella radice
  assert.equal(srv.readConfig().projects.find(p => p.id === 'a').folder, undefined);
  await srv.request('DELETE', '/api/core/folders/' + f.id);
  data = (await srv.request('GET', '/api/core/projects')).json;
  assert.deepEqual(data.folders, []);
  assert.ok(data.projects.every(p => p.folder === undefined));
  // import: un progetto che punta a una cartella assente è rifiutato
  r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'merge', config: { projects: [{ id: 'x', label: 'X', path: dir, folder: 'fzz' }] } } });
  assert.equal(r.json.code, 'core.project_folder');
  r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'merge', config: { projectFolders: [{ id: 'fzz', label: 'Z' }], projects: [{ id: 'x', label: 'X', path: dir, folder: 'fzz' }] } } });
  assert.equal(r.status, 200);
  for (const id of ['a', 'b', 'x']) await srv.request('DELETE', '/api/core/projects/' + id);
  await srv.request('DELETE', '/api/core/folders/fzz');
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

test('sezioni: groups/servers appartengono all\'estensione tunnels, projects e projectFolders al core', async () => {
  const sections = Object.fromEntries((await srv.request('GET', '/api/core/config/sections')).json.map(x => [x.key, x.owner]));
  assert.equal(sections.groups, 'tunnels');
  assert.equal(sections.servers, 'tunnels');
  assert.equal(sections.projects, 'core');
  assert.equal(sections.projectFolders, 'core');
});

test('export per tipo', async () => {
  const git = await srv.request('GET', '/api/core/config/export?name=git&sections=projects');
  assert.deepEqual(Object.keys(git.json), ['projects']);
  assert.match(git.headers['content-disposition'], /devdock-config-git-/);
  const tunnels = await srv.request('GET', '/api/core/config/export?name=tunnels&sections=groups,servers');
  assert.deepEqual(Object.keys(tunnels.json).sort(), ['groups', 'servers']);
});

test('le estensioni dichiarano le caselle del dialog di export', async () => {
  const exts = Object.fromEntries((await srv.request('GET', '/api/core/extensions')).json.map(e => [e.code, e.export]));
  assert.deepEqual(exts.tunnels.map(x => x.sections), [['groups', 'servers']]);
  assert.deepEqual(exts.npm, []);
  assert.deepEqual(exts.git, []);
});
