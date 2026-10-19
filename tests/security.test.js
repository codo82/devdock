const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.stop());

// Richiesta innocua che, se ammessa, fallisce per validazione (400) senza toccare la config
const probe = (headers = {}) => srv.request('POST', '/api/config/groups', { body: {}, headers });

test('Host non locale → 421 (DNS rebinding)', async () => {
  const r = await srv.request('GET', '/api/core/system', { headers: { Host: `evil.example:${srv.port}` } });
  assert.equal(r.status, 421);
});

test('Host locale accettato anche come localhost', async () => {
  const r = await srv.request('GET', '/api/core/system', { headers: { Host: `localhost:${srv.port}` } });
  assert.equal(r.status, 200);
});

test('Origin estraneo → 403 (CSRF)', async () => {
  assert.equal((await probe({ Origin: 'https://evil.example' })).status, 403);
  assert.equal((await probe({ Origin: 'null' })).status, 403);
});

test('Referer estraneo senza Origin → 403', async () => {
  assert.equal((await probe({ Referer: 'https://evil.example/page' })).status, 403);
});

test('Origin della UI e richieste senza Origin (curl) ammesse', async () => {
  assert.equal((await probe({ Origin: `http://127.0.0.1:${srv.port}` })).status, 400);
  assert.equal((await probe({ Origin: `http://localhost:${srv.port}` })).status, 400);
  assert.equal((await probe()).status, 400);
});

test('POST senza Content-Type JSON → 415', async () => {
  const r = await srv.request('POST', '/api/config/groups', {
    raw: 'key=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(r.status, 415);
});

test('JSON malformato → 400 JSON', async () => {
  const r = await srv.request('POST', '/api/config/groups', { raw: '{bad', headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'JSON non valido');
});

test('header di sicurezza presenti', async () => {
  const r = await srv.request('GET', '/');
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['x-powered-by'], undefined);
});

test('endpoint debug-push rimosso', async () => {
  const r = await srv.request('GET', '/api/git/repos/x/debug-push');
  assert.equal(r.status, 404);
});

test('/api/system descrive piattaforma e strumenti', async () => {
  const r = await srv.request('GET', '/api/core/system');
  assert.equal(r.json.platform, process.platform);
  assert.equal(typeof r.json.tools.git, 'boolean');
});
