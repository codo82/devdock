// Migration collegate a un repository: numerazione NNN_<tabella>_<operazione>.sql,
// cartelle dentro il repository, collegamento a una connessione (MySQL non serve)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir, makeRepo, git } = require('../../../lib/testkit');
const mig = require('../migrations');

test('numerazione: numero attuale, larghezza, file fuori formato, duplicati', () => {
  assert.deepEqual(mig.scan([]), { files: [], ignored: [], current: 0, width: 3, duplicates: [] });
  const s = mig.scan(['001_users_create.sql', '002_users_add_email.sql', '010_orders_create.sql', 'note.md', 'schema.sql', '7_x.sql', '010_orders_drop.sql']);
  assert.equal(s.current, 10);
  assert.equal(s.width, 3);
  assert.deepEqual(s.ignored, ['schema.sql']);
  assert.deepEqual(s.duplicates, [10]);
  assert.equal(s.files[0].name, '001_users_create.sql');
  assert.equal(s.files.find(f => f.name === '7_x.sql').number, 7);
  // larghezza cresciuta oltre 999: si mantiene quella più lunga
  assert.equal(mig.scan(['0999_a_b.sql', '1000_a_b.sql']).width, 4);
  assert.equal(mig.pad(1, 3), '001');
  assert.equal(mig.pad(1000, 3), '1000');
});

test('nome del file: slug di tabella e operazione', () => {
  assert.equal(mig.fileName(12, 3, 'Ordini', 'add status'), '012_ordini_add_status.sql');
  assert.equal(mig.fileName(1, 4, 'user-roles', 'create'), '0001_user_roles_create.sql');
  assert.throws(() => mig.fileName(1, 3, '!!!', 'create'), mig.MigrationError);
  assert.throws(() => mig.fileName(1, 3, 'users', ''), mig.MigrationError);
});

test('cartelle: solo dentro il repository', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'db/migrations'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.symlinkSync(tmpDir(), path.join(root, 'fuori'));
  for (const bad of ['..', '../x', '/etc', 'db/../..', '.git', 'db//x', 'a\\b']) assert.equal(mig.isValidDir(bad), false, bad);
  assert.equal(mig.resolveInside(root, 'fuori'), null, 'link che esce dal repository');
  assert.deepEqual(mig.listFolders(root, '').folders, ['db']);
  assert.deepEqual(mig.listFolders(root, 'db').folders, ['migrations']);
  assert.equal(mig.createFolder(root, 'db', 'seeds'), 'db/seeds');
  assert.throws(() => mig.createFolder(root, 'db', 'seeds'), /folder_exists/);
  assert.throws(() => mig.createFolder(root, 'db', '..'), /folder_name_invalid/);
});

test('scrittura: mai sovrascrivere, contenuto con intestazione', () => {
  const dir = tmpDir();
  mig.writeExclusive(dir, '001_a_create.sql', 'uno');
  assert.throws(() => mig.writeExclusive(dir, '001_a_create.sql', 'due'), /file_exists/);
  assert.equal(fs.readFileSync(path.join(dir, '001_a_create.sql'), 'utf8'), 'uno');
  assert.deepEqual(fs.readdirSync(dir), ['001_a_create.sql'], 'nessun file temporaneo rimasto');
  const content = mig.migrationContent('002_a_alter.sql', { connection: 'Locale', database: 'app', date: new Date('2026-01-02T03:04:05Z') }, ['ALTER TABLE a ADD b INT', 'CREATE INDEX i ON a (b)']);
  assert.equal(content, '-- 002_a_alter.sql\n-- DevDock · Locale · app · 2026-01-02T03:04:05.000Z\n\nALTER TABLE a ADD b INT;\n\nCREATE INDEX i ON a (b);\n');
});

let srv, repo, base;
before(async () => {
  base = tmpDir();
  repo = makeRepo(path.join(base, 'repo'));
  fs.mkdirSync(path.join(repo, 'database/migrations'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'database/migrations/001_users_create.sql'), 'CREATE TABLE users (id INT);\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'migration 1');
  git(base, 'init', '-q', '--bare', 'origin.git');
  git(repo, 'remote', 'add', 'origin', path.join(base, 'origin.git'));
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  // un collega aggiunge 002 sul remoto: in locale non c'è ancora
  const other = path.join(base, 'other');
  git(base, 'clone', '-q', '-b', 'main', path.join(base, 'origin.git'), other);
  fs.writeFileSync(path.join(other, 'database/migrations/002_orders_create.sql'), 'CREATE TABLE orders (id INT);\n');
  git(other, 'add', '.');
  git(other, 'commit', '-qm', 'migration 2');
  git(other, 'push', '-q', 'origin', 'main');

  srv = await startServer({
    groups: [], servers: [], projects: [{ id: 'app', label: 'App', path: repo }],
    dbConnections: [{ id: 'c1', label: 'Locale', type: 'mysql', host: '127.0.0.1', port: 3306, user: 'u', password: null }],
  });
});
after(() => srv.stop());

const api = (method, p, body) => srv.request(method, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/db-client'}${p}`, body !== undefined ? { body } : {});

test('repository dall\'estensione Git e browser delle cartelle', async () => {
  const r = await api('GET', '/migrations/repos');
  assert.equal(r.json.source, 'git');
  assert.deepEqual(r.json.repos, [{ id: 'app', label: 'App' }]);
  assert.deepEqual((await api('GET', '/migrations/repos/app/folders?dir=')).json.folders, ['database']);
  const sub = await api('GET', '/migrations/repos/app/folders?dir=database/migrations');
  assert.deepEqual([sub.json.folders, sub.json.sqlFiles], [[], 1]);
  assert.equal((await api('GET', '/migrations/repos/app/folders?dir=../..')).json.code, 'db-client.dir_invalid');
  assert.equal((await api('GET', '/migrations/repos/app/folders?dir=manca')).status, 404);
  assert.equal((await api('GET', '/migrations/repos/nope/folders')).json.code, 'db-client.repo_not_found');
  const created = await api('POST', '/migrations/repos/app/folders', { parent: 'database', name: 'seeds' });
  assert.equal(created.json.dir, 'database/seeds');
  assert.ok(fs.existsSync(path.join(repo, 'database/seeds')));
});

test('numerazione dai file della cartella (il branch remoto non conta)', async () => {
  const r = await api('GET', '/migrations/repos/app/scan?dir=database/migrations');
  assert.equal(r.json.current, 1, 'la 002 del collega è solo sul remoto');
  assert.equal(r.json.nextPrefix, '002');
  assert.equal(r.json.upstream, undefined);
  // cartella vuota: si parte da 001
  assert.equal((await api('GET', '/migrations/repos/app/scan?dir=database/seeds')).json.nextPrefix, '001');
});

test('collegamento della connessione a repository e cartella', async () => {
  assert.equal((await api('PUT', '/connections/c1/migrations', { repo: 'app', dir: 'non/esiste' })).status, 404);
  assert.equal((await api('PUT', '/connections/c1/migrations', { repo: 'app', dir: '../x' })).status, 400);
  let r = await api('PUT', '/connections/c1/migrations', { repo: 'app', dir: 'database/migrations' });
  assert.equal(r.status, 200);
  r = await api('GET', '/connections/c1/migrations');
  assert.equal(r.json.linked, true);
  assert.equal(r.json.dir, 'database/migrations');
  assert.equal(r.json.nextPrefix, '002');
  const list = (await api('GET', '/connections')).json.connections;
  assert.deepEqual(list[0].migrations, { repo: 'app', dir: 'database/migrations' });
  assert.equal((await api('DELETE', '/connections/c1/migrations')).status, 200);
  assert.equal((await api('GET', '/connections/c1/migrations')).json.linked, false);
});
