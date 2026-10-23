const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../lib/testkit');
const { sampleExtensions } = require('./fixtures');

let srv;
before(async () => { srv = await startServer(undefined, { extensions: sampleExtensions() }); });
after(() => srv.stop());


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
  const sample = { items: [{ id: 'i1' }], links: [{ id: 'l1', item: 'i1' }] };
  let r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'merge', config: sample } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.sections, ['items', 'links']);

  r = await srv.request('POST', '/api/core/config/import', {
    body: { mode: 'merge', config: { projects: [{ id: 'q', label: 'Q', path: '/tmp/q' }], items: [{ id: 'i1', extra: 1 }, { id: 'i2' }] } },
  });
  assert.equal(r.status, 200);
  let cfg = srv.readConfig();
  assert.deepEqual(cfg.items, [{ id: 'i1' }, { id: 'i2' }], 'merge: aggiunti solo gli elementi nuovi');
  assert.deepEqual(cfg.projects.map(p => p.id), ['q']);

  // replace di una sola sezione non tocca le altre
  r = await srv.request('POST', '/api/core/config/import', {
    body: { mode: 'replace', config: { projects: [{ id: 'z', label: 'Z', path: '/tmp/z' }] } },
  });
  assert.equal(r.status, 200);
  cfg = srv.readConfig();
  assert.deepEqual(cfg.projects.map(p => p.id), ['z']);
  assert.equal(cfg.items.length, 2);

  // risultato non valido (link verso un item rimosso) → 400 e config invariata
  r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'replace', config: { items: [] } } });
  assert.equal(r.status, 400);
  assert.equal(srv.readConfig().items.length, 2);

  r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'merge', config: { foo: 1 } } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /sezioni riconosciute/);
  r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'boh', config: sample } });
  assert.equal(r.status, 400);
});

test('sezioni: quelle dichiarate appartengono all\'estensione, projects, projectFolders e layout al core', async () => {
  const sections = Object.fromEntries((await srv.request('GET', '/api/core/config/sections')).json.map(x => [x.key, x.owner]));
  assert.equal(sections.items, 'sample');
  assert.equal(sections.links, 'sample');
  assert.equal(sections.projects, 'core');
  assert.equal(sections.projectFolders, 'core');
  assert.equal(sections.layout, 'core');
});

test('export per tipo', async () => {
  const projects = await srv.request('GET', '/api/core/config/export?name=progetti&sections=projects');
  assert.deepEqual(Object.keys(projects.json), ['projects']);
  assert.match(projects.headers['content-disposition'], /devdock-config-progetti-/);
  const sample = await srv.request('GET', '/api/core/config/export?name=sample&sections=items,links');
  assert.deepEqual(Object.keys(sample.json).sort(), ['items', 'links']);
});

test('le estensioni dichiarano le caselle del dialog di export', async () => {
  const exts = Object.fromEntries((await srv.request('GET', '/api/core/extensions')).json.map(e => [e.code, e.export]));
  assert.deepEqual(exts.sample.map(x => x.sections), [['items', 'links']]);
  assert.deepEqual(exts.second, []);
});
