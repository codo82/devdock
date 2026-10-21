// Porte in uso: elenco con il processo, collegamento agli script npm, arresto
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { startServer, tmpDir, makeRepo } = require('./helpers');

const listenScript = port => `require('http').createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1')`;
const freePort = () => new Promise(r => { const s = require('net').createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const wait = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

let srv, repo, npmPort;
before(async () => {
  npmPort = await freePort();
  repo = makeRepo(path.join(tmpDir(), 'web'), { scripts: { serve: `node -e "${listenScript(npmPort)}"` } });
  srv = await startServer({ groups: [], servers: [], projects: [{ id: 'web', label: 'Web', path: repo }] });
});
after(() => srv?.stop());

const list = async () => (await srv.request('GET', '/api/ext/ports/list')).json.ports;
async function waitPort(port) {
  for (let i = 0; i < 50; i++) { const p = (await list()).find(x => x.port === port); if (p) return p; await wait(100); }
  return null;
}

test('porta di un processo qualsiasi: trovata e fermata', { skip: process.platform === 'win32' }, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['-e', listenScript(port)], { stdio: 'ignore' });
  try {
    const p = await waitPort(port);
    assert.ok(p, 'porta in elenco');
    assert.equal(p.pid, child.pid);
    assert.equal(p.own, true);
    assert.equal(p.owner, null);
    assert.match(p.command, /createServer/);
    const r = await srv.request('POST', '/api/ext/ports/stop', { body: { port, pid: child.pid } });
    assert.deepEqual(r.json, { ok: true, via: 'signal', force: false, freed: true });
    for (let i = 0; i < 30 && alive(child.pid); i++) await wait(100);
    assert.equal(alive(child.pid), false);
  } finally { if (alive(child.pid)) child.kill('SIGKILL'); }
});

test('porta di uno script npm avviato da DevDock: fermata tramite npm', { skip: process.platform === 'win32' }, async () => {
  await srv.request('POST', '/api/ext/npm/projects/web/run', { body: { script: 'serve' } });
  const p = await waitPort(npmPort);
  assert.ok(p);
  assert.equal(p.owner.type, 'npm');
  assert.equal(p.owner.label, 'Web — serve');
  const r = await srv.request('POST', '/api/ext/ports/stop', { body: { port: npmPort, pid: p.pid } });
  assert.equal(r.json.via, 'npm');
  assert.deepEqual((await srv.request('GET', '/api/ext/npm/processes')).json, []);
  for (let i = 0; i < 30 && alive(p.pid); i++) await wait(100);
  assert.equal(alive(p.pid), false);
});

test('DevDock stesso e porte non più in ascolto non si fermano', async () => {
  const me = (await list()).find(x => x.port === srv.port);
  assert.equal(me.owner.type, 'devdock');
  let r = await srv.request('POST', '/api/ext/ports/stop', { body: { port: srv.port, pid: me.pid } });
  assert.equal(r.json.code, 'ports.self');
  r = await srv.request('POST', '/api/ext/ports/stop', { body: { port: 1, pid: 999999 } });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'ports.not_listening');
});

test('processo che ignora SIGTERM: "Ferma" non libera la porta, "Forza chiusura" sì', { skip: process.platform === 'win32' }, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); ${listenScript(port)}`], { stdio: 'ignore' });
  try {
    const p = await waitPort(port);
    assert.ok(p);
    let r = await srv.request('POST', '/api/ext/ports/stop', { body: { port, pid: child.pid } });
    assert.equal(r.json.freed, false);
    assert.equal(alive(child.pid), true);
    r = await srv.request('POST', '/api/ext/ports/stop', { body: { port, pid: child.pid, force: true } });
    assert.deepEqual([r.json.force, r.json.freed], [true, true]);
    for (let i = 0; i < 30 && alive(child.pid); i++) await wait(100);
    assert.equal(alive(child.pid), false);
  } finally { if (alive(child.pid)) child.kill('SIGKILL'); }
});
