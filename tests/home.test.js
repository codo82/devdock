// Nuovo nome (2.13): ~/.devdock spostata in ~/.kelbo con estensioni installate, lock file e
// backup; token MCP rinominato; indirizzi del repository ufficiale riscritti; variabili DEVDOCK_*
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, startServer } = require('../lib/testkit');
const { migrateHome, homeDir } = require('../lib/home');

// ~/.devdock come la lasciava la 2.12: un'estensione installata (con node_modules e un link),
// il lock file con il repository di prima e il backup della versione precedente
function oldHome(homedir) {
  const old = path.join(homedir, '.devdock');
  const ext = path.join(old, 'extensions', 'hello');
  fs.mkdirSync(path.join(ext, 'node_modules', 'dep'), { recursive: true });
  fs.mkdirSync(path.join(ext, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'setting.json'), JSON.stringify({
    name: 'Hello', code: 'hello', version: '1.1.0', devdock: '^2.0', color: '#336699', position: 'tab',
    backend: { module: 'server.js', routes: [{ method: 'GET', path: '/hi', handler: 'hi' }] },
  }));
  fs.writeFileSync(path.join(ext, 'server.js'), "module.exports = () => ({ handlers: { hi: (req, res) => res.json({ hi: require('dep') }) } });");
  fs.writeFileSync(path.join(ext, 'node_modules', 'dep', 'index.js'), "module.exports = 'dal node_modules';");
  fs.symlinkSync('../dep/index.js', path.join(ext, 'node_modules', '.bin', 'dep'));
  fs.mkdirSync(path.join(old, 'backups', 'hello'), { recursive: true });
  fs.writeFileSync(path.join(old, 'backups', 'hello', 'setting.json'), '{"code":"hello","version":"1.0.0"}');
  fs.writeFileSync(path.join(old, 'extensions.lock.json'), JSON.stringify({
    extensions: {
      hello: {
        repo: 'https://github.com/codo82/devdock-extensions.git', path: 'hello', tag: 'hello@1.1.0', version: '1.1.0', commit: 'abc',
        previous: { repo: 'git@github.com:codo82/devdock-extensions.git', path: 'hello', tag: 'hello@1.0.0', version: '1.0.0', commit: 'def' },
      },
    },
  }));
  return old;
}

const files = dir => fs.readdirSync(dir, { recursive: true }).sort();

test('spostamento: tutto il contenuto in ~/.kelbo, la vecchia cartella non c\'è più', () => {
  const homedir = tmpDir('kelbo-home-');
  const old = oldHome(homedir);
  const before = files(old);
  const logs = [];
  const r = migrateHome({ env: {}, homedir, log: m => logs.push(m) });
  assert.deepEqual([r.dir, r.moved], [path.join(homedir, '.kelbo'), true]);
  assert.equal(fs.existsSync(old), false);
  assert.deepEqual(files(r.dir), before);
  assert.equal(fs.readlinkSync(path.join(r.dir, 'extensions/hello/node_modules/.bin/dep')), '../dep/index.js');
  assert.match(logs[0], /spostata/);
  // seconda volta: niente da fare
  assert.deepEqual(migrateHome({ env: {}, homedir, log: () => {} }), { dir: r.dir, moved: false });
});

test('dischi diversi: copia verificata, poi la vecchia cancellata; copia che fallisce: si resta su ~/.devdock', () => {
  const exdev = () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };
  let homedir = tmpDir('kelbo-home-');
  let old = oldHome(homedir);
  const before = files(old);
  let r = migrateHome({ env: {}, homedir, log: () => {}, rename: (a, b) => (a === old ? exdev() : fs.renameSync(a, b)) });
  assert.deepEqual([r.dir, r.moved], [path.join(homedir, '.kelbo'), true]);
  assert.deepEqual(files(r.dir), before);
  assert.equal(fs.existsSync(old), false);

  homedir = tmpDir('kelbo-home-');
  old = oldHome(homedir);
  const logs = [];
  r = migrateHome({ env: {}, homedir, log: m => logs.push(m), rename: exdev, copy: () => { throw new Error('disco pieno'); } });
  assert.deepEqual([r.dir, r.moved, r.notice], [old, false, 'disco pieno']);
  assert.deepEqual(files(old), before); // intatta
  assert.deepEqual(fs.readdirSync(homedir), ['.devdock']); // nessuna copia a metà
  assert.match(logs[0], /si continua con .*\.devdock/);
  assert.equal(homeDir({ env: {}, homedir }), old); // finché non riesce si usa la vecchia
});

test('~/.kelbo già presente o KELBO_HOME/DEVDOCK_HOME: nessuno spostamento', () => {
  const homedir = tmpDir('kelbo-home-');
  const old = oldHome(homedir);
  fs.mkdirSync(path.join(homedir, '.kelbo'));
  const logs = [];
  assert.deepEqual(migrateHome({ env: {}, homedir, log: m => logs.push(m) }), { dir: path.join(homedir, '.kelbo'), moved: false });
  assert.ok(fs.existsSync(path.join(old, 'extensions.lock.json')));
  assert.match(logs[0], /sia .*\.kelbo sia .*\.devdock/);
  for (const env of [{ KELBO_HOME: '/altrove' }, { DEVDOCK_HOME: '/altrove' }]) {
    assert.deepEqual(migrateHome({ env, homedir, log: () => {} }), { dir: '/altrove', moved: false });
    assert.equal(homeDir({ env, homedir }), '/altrove');
  }
  assert.equal(homeDir({ env: {}, homedir: tmpDir('kelbo-empty-') }).endsWith('.kelbo'), true);
});

test('avvio dopo l\'aggiornamento: estensione installata caricata da ~/.kelbo, indirizzi e token aggiornati', async () => {
  const homedir = tmpDir('kelbo-home-');
  oldHome(homedir);
  const srv = await startServer({ projects: [], extensions: { installed: [{ code: 'hello', repo: 'https://github.com/codo82/devdock-extensions.git', path: 'hello' }] } },
    { extensions: null, env: { HOME: homedir, USERPROFILE: homedir, KELBO_HOME: null } });
  // token MCP accanto a config.json con il nome di prima: rinominato al primo uso, stesso valore
  const oldToken = path.join(path.dirname(srv.configPath), '.devdock-mcp-token');
  fs.writeFileSync(oldToken, 'a'.repeat(64) + '\n');
  try {
    const kelbo = path.join(homedir, '.kelbo');
    assert.equal(fs.existsSync(path.join(homedir, '.devdock')), false);
    assert.deepEqual((await srv.request('GET', '/api/ext/hello/hi')).json, { hi: 'dal node_modules' });
    const admin = (await srv.request('GET', '/api/core/extensions-admin')).json;
    const hello = admin.extensions.find(e => e.code === 'hello');
    assert.equal(hello.source, 'installed');
    assert.equal(hello.hasBackup, true); // "versione precedente" ancora disponibile
    const lock = JSON.parse(fs.readFileSync(path.join(kelbo, 'extensions.lock.json'), 'utf8'));
    assert.equal(lock.extensions.hello.repo, 'https://github.com/kelbodev/kelbo-extensions.git');
    assert.equal(lock.extensions.hello.previous.repo, 'git@github.com:kelbodev/kelbo-extensions.git');
    assert.equal(srv.readConfig().extensions.installed[0].repo, 'https://github.com/kelbodev/kelbo-extensions.git');
    const r = await srv.request('GET', '/api/core/mcp');
    assert.equal(r.json.token, 'a'.repeat(64));
    assert.ok(fs.existsSync(path.join(path.dirname(srv.configPath), '.kelbo-mcp-token')));
    assert.equal(fs.existsSync(oldToken), false);
    assert.match(r.json.bridge.args[0], /kelbo-mcp\.js$/);
  } finally { await srv.stop(); }
});

test('variabili DEVDOCK_* di prima: valgono ancora (KELBO_* ha la precedenza)', async () => {
  // il kit passa KELBO_*: qui si prova direttamente il modulo con le sole DEVDOCK_*
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', "const e=require('./lib/env');console.log(JSON.stringify([e.PORT,e.CONFIG_PATH,e.HOME]))"], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
    env: { PATH: process.env.PATH, DEVDOCK_PORT: '4567', DEVDOCK_CONFIG: '/tmp/x.json', DEVDOCK_HOME: '/tmp/h', HOME: tmpDir() },
  });
  assert.deepEqual(JSON.parse(out), [4567, '/tmp/x.json', '/tmp/h']);
  const both = execFileSync(process.execPath, ['-e', "console.log(require('./lib/env').PORT)"], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { PATH: process.env.PATH, DEVDOCK_PORT: '4567', KELBO_PORT: '4568', HOME: tmpDir() },
  });
  assert.equal(both.trim(), '4568');
});
