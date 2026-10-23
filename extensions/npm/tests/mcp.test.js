// Strumenti MCP di npm: progetti, avvio di uno script e suo output
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, tmpDir, makeRepo, mcpClient } = require('../../../lib/testkit');

let srv, client;
before(async () => {
  const repo = makeRepo(path.join(tmpDir(), 'app'), { scripts: { hello: 'node -e "console.log(\'ciao da npm\')"' } });
  srv = await startServer({ projects: [{ id: 'app', label: 'App', path: repo }] });
  client = await mcpClient(srv);
});
after(async () => { await client?.close(); await srv?.stop(); });

const call = async (name, args = {}) => client.callTool({ name, arguments: args });

test('npm: lettura, avvio di uno script e suo output', async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.find(t => t.name === 'npm_run').annotations.readOnlyHint, false);
  assert.equal(tools.find(t => t.name === 'npm_projects').annotations.readOnlyHint, true);
  let r = await call('npm_projects');
  assert.deepEqual(Object.keys(r.structuredContent.projects[0].scripts), ['hello']);
  r = await call('npm_run', { project: 'app', script: 'non-esiste' });
  assert.equal(r.structuredContent.code, 'npm.script_not_defined');
  r = await call('npm_run', { project: 'app', script: 'hello' });
  const id = r.structuredContent.process.id;
  let out;
  for (let i = 0; i < 50; i++) {
    out = (await call('npm_output', { process: id })).structuredContent;
    if (!out.running && /ciao da npm/.test(out.output)) break;
    await new Promise(res => setTimeout(res, 100));
  }
  assert.match(out.output, /ciao da npm/);
  assert.equal(out.exitCode, 0);
  assert.equal((await call('npm_stop', { process: id })).structuredContent.stopped, true);
});

