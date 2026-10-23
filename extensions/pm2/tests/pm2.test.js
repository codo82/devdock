const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, tmpDir, makeRepo } = require('../../../lib/testkit');

let srv;
before(async () => {
  const projectDir = makeRepo(path.join(tmpDir(), 'app'), { scripts: { hello: 'echo ciao' } });
  srv = await startServer({ groups: [], servers: [], projects: [{ id: 'app', label: 'App', path: projectDir }] });
});
after(() => srv.stop());

test('estensione pm2 caricata come pulsante nell\'header', async () => {
  const pm2 = (await srv.request('GET', '/api/core/extensions')).json.find(e => e.code === 'pm2');
  assert.equal(pm2.state, 'ok');
  assert.equal(pm2.position, 'header');
  assert.deepEqual(Object.keys(pm2.frontend).sort(), ['css', 'html', 'js', 'sidebar']);
  for (const f of Object.values(pm2.frontend)) {
    assert.equal((await srv.request('GET', `/ext/pm2/${f}`)).status, 200, f);
  }
  assert.equal((await srv.request('GET', '/ext/pm2/server.js')).status, 404);
});

test('azioni e nomi validati, nessun crash senza pm2', async () => {
  const action = body => srv.request('POST', '/api/ext/pm2/action', { body });
  assert.equal((await action({ action: 'kill', target: 'x' })).status, 400);
  assert.equal((await action({ action: 'stop', target: '--help' })).status, 400);
  assert.equal((await action({ action: 'start', projectId: 'app', script: 'nope' })).status, 400);
  assert.equal((await srv.request('GET', '/api/ext/pm2/logs?name=-x')).status, 400);
  await action({ action: 'stop', target: 'app-1' }); // con o senza pm2 non deve far cadere il server
  assert.equal((await srv.request('GET', '/api/ext/pm2/list')).status, 200);
});

test('con pm2 installato: lista e azioni (pm2 finto nel PATH)', async () => {
  const fs = require('fs');
  const bin = tmpDir('devdock-pm2-');
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'pm2'), `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1" = "jlist" ]; then
  echo '[{"pm_id":0,"name":"api","pid":123,"monit":{"cpu":1,"memory":52428800},"pm2_env":{"status":"online","restart_time":2}}]'
fi
`, { mode: 0o755 });
  const fake = await startServer({ groups: [], servers: [], projects: [] }, { env: { PATH: `${bin}:${process.env.PATH}` } });
  try {
    const list = (await fake.request('GET', '/api/ext/pm2/list')).json;
    assert.deepEqual(list, [{ id: 0, name: 'api', status: 'online', pid: 123, cpu: 1, memory: 52428800, restarts: 2 }]);
    const r = await fake.request('POST', '/api/ext/pm2/action', { body: { action: 'restart', target: 'api' } });
    assert.equal(r.status, 200);
    assert.match(fs.readFileSync(log, 'utf8'), /^restart api$/m);
  } finally {
    await fake.stop();
  }
});
