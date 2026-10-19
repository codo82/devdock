const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir } = require('./helpers');

// Crea un'estensione di prova: files = { 'setting.json': {...}, 'server.js': '...' }
function ext(root, code, files) {
  const dir = path.join(root, code);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
}

const manifest = (code, extra = {}) => ({ name: code.toUpperCase(), code, color: '#336699', position: 'tab', ...extra });

let srv;
before(async () => {
  const root = tmpDir('devdock-ext-');

  ext(root, 'alpha', {
    'setting.json': manifest('alpha', {
      order: 10,
      config: ['alpha'],
      backend: {
        module: 'server.js',
        routes: [
          { method: 'GET',  path: '/hello',     handler: 'hello' },
          { method: 'POST', path: '/echo/:id',  handler: 'echo' },
          { method: 'GET',  path: '/boom',      handler: 'boom' },
          { method: 'GET',  path: '/stream',    handler: 'stream', stream: true },
          { method: 'POST', path: '/config',    handler: 'saveConfig' },
          { method: 'GET',  path: '/foreign',   handler: 'foreign' },
        ],
      },
      frontend: { js: 'view.js', html: 'view.html' },
    }),
    'server.js': `module.exports = ctx => ({
      handlers: {
        hello: (req, res) => res.json({ msg: 'ciao da ' + ctx.code }),
        echo: (req, res) => res.json({ id: req.params.id, body: req.body }),
        boom: async () => { throw new Error('esploso'); },
        stream: (req, res) => { const send = ctx.sse(res); send('stdout', 'uno'); send('exit', 0); send.end(); },
        saveConfig: (req, res) => { ctx.config.set('alpha', req.body); res.json(ctx.config.get('alpha')); },
        foreign: (req, res) => res.json(ctx.config.get('servers')),
        unused: () => {},
      },
      services: { greet: name => 'ciao ' + name },
    });`,
    'view.js': 'export default { mount() {} };',
    'view.html': '<div>alpha</div>',
  });

  ext(root, 'beta', {
    'setting.json': manifest('beta', {
      order: 20,
      dependencies: [{ code: 'alpha', required: true }],
      backend: { module: 'server.js', routes: [{ method: 'GET', path: '/greet', handler: 'greet' }] },
    }),
    'server.js': `module.exports = ctx => {
      const alpha = ctx.require('alpha');
      return { handlers: { greet: (req, res) => res.json({ text: alpha.greet('beta') }) } };
    };`,
  });

  ext(root, 'gamma', { 'setting.json': manifest('gamma', { dependencies: [{ code: 'missing', required: true }] }) });
  ext(root, 'delta', { 'setting.json': manifest('delta', { position: 'header', dependencies: [{ code: 'missing', required: false }] }) });
  ext(root, 'cyc-a', { 'setting.json': manifest('cyc-a', { dependencies: [{ code: 'cyc-b', required: true }] }) });
  ext(root, 'cyc-b', { 'setting.json': manifest('cyc-b', { dependencies: [{ code: 'cyc-a', required: true }] }) });
  ext(root, 'wrongcode', { 'setting.json': manifest('altro') });
  ext(root, 'badjson', { 'setting.json': '{ non json' });
  ext(root, 'nohandler', {
    'setting.json': manifest('nohandler', { backend: { module: 'server.js', routes: [{ method: 'GET', path: '/x', handler: 'manca' }] } }),
    'server.js': 'module.exports = () => ({ handlers: {} });',
  });
  ext(root, 'needs-nohandler', { 'setting.json': manifest('needs-nohandler', { dependencies: [{ code: 'nohandler', required: true }] }) });
  ext(root, 'clash', { 'setting.json': manifest('clash', { config: ['alpha'] }) });
  ext(root, 'escape', { 'setting.json': manifest('escape', { frontend: { js: '../alpha/server.js' } }) });
  fs.mkdirSync(path.join(root, 'senza-manifest'));

  srv = await startServer({ groups: [], servers: [], projects: [] }, { env: { DEVDOCK_EXTENSIONS_DIR: root } });
});
after(() => srv.stop());

const list = async () => Object.fromEntries((await srv.request('GET', '/api/core/extensions')).json.map(e => [e.code, e]));

test('stato delle estensioni dopo il caricamento', async () => {
  const all = await list();
  assert.equal(all.alpha.state, 'ok');
  assert.equal(all.beta.state, 'ok');
  assert.equal(all.delta.state, 'warning');
  assert.match(all.delta.warnings[0], /missing/);
  assert.equal(all.gamma.state, 'disabled');
  assert.match(all.gamma.error, /dipendenza "missing" mancante/);
  assert.equal(all['cyc-a'].state, 'disabled');
  assert.equal(all['cyc-b'].error, 'dipendenza circolare');
  assert.match(all.wrongcode.error, /deve coincidere con il nome della cartella/);
  assert.equal(all.badjson.state, 'disabled');
  assert.match(all.nohandler.error, /handler non trovati: manca/);
  assert.match(all['needs-nohandler'].error, /dipendenza "nohandler" non disponibile/);
  assert.match(all.clash.error, /chiave di config "alpha" già usata da "alpha"/);
  assert.match(all.escape.error, /frontend\.js/);
  assert.equal(all['senza-manifest'], undefined);
});

test('lista ordinata per order e con i dati del manifest', async () => {
  const items = (await srv.request('GET', '/api/core/extensions')).json;
  assert.deepEqual(items.slice(0, 2).map(e => e.code), ['alpha', 'beta']);
  assert.equal(items[0].color, '#336699');
  assert.deepEqual(items[0].frontend, { js: 'view.js', html: 'view.html' });
});

test('route dichiarate montate su /api/ext/<code>', async () => {
  assert.deepEqual((await srv.request('GET', '/api/ext/alpha/hello')).json, { msg: 'ciao da alpha' });
  const echo = await srv.request('POST', '/api/ext/alpha/echo/42', { body: { a: 1 } });
  assert.deepEqual(echo.json, { id: '42', body: { a: 1 } });
  assert.equal((await srv.request('GET', '/api/ext/alpha/unused')).status, 404);
  assert.equal((await srv.request('GET', '/api/ext/nohandler/x')).status, 404);
});

test('servizi tra estensioni con ctx.require', async () => {
  assert.deepEqual((await srv.request('GET', '/api/ext/beta/greet')).json, { text: 'ciao beta' });
});

test('errori dei handler async → 500 JSON', async () => {
  const r = await srv.request('GET', '/api/ext/alpha/boom');
  assert.equal(r.status, 500);
  assert.equal(r.json.error, 'esploso');
});

test('stream SSE con ctx.sse', async () => {
  const r = await srv.request('GET', '/api/ext/alpha/stream');
  assert.deepEqual(r.events, [{ type: 'stdout', data: 'uno' }, { type: 'exit', data: 0 }]);
});

test('ctx.config: solo chiavi dichiarate', async () => {
  const r = await srv.request('POST', '/api/ext/alpha/config', { body: { x: 1 } });
  assert.deepEqual(r.json, { x: 1 });
  assert.deepEqual(srv.readConfig().alpha, { x: 1 });
  const foreign = await srv.request('GET', '/api/ext/alpha/foreign');
  assert.equal(foreign.status, 500);
  assert.match(foreign.json.error, /non dichiarata/);
});

test('la sicurezza del core vale anche per le estensioni', async () => {
  const r = await srv.request('POST', '/api/ext/alpha/echo/1', { body: {}, headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('solo i file frontend dichiarati vengono serviti', async () => {
  const js = await srv.request('GET', '/ext/alpha/view.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
  assert.equal((await srv.request('GET', '/ext/alpha/server.js')).status, 404);
  assert.equal((await srv.request('GET', '/ext/alpha/setting.json')).status, 404);
  assert.equal((await srv.request('GET', '/ext/alpha/..%2Fbeta%2Fserver.js')).status, 404);
  assert.equal((await srv.request('GET', '/ext/gamma/view.js')).status, 404);
});

test('avviso per handler senza route', () => {
  assert.match(srv.output(), /\[ext:alpha\] handler senza route: unused/);
});
