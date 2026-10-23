// Strumenti MCP di Git: repository, stato e log
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, tmpDir, makeRepo, mcpClient } = require('../../../lib/testkit');

let srv, client;
before(async () => {
  const repo = makeRepo(path.join(tmpDir(), 'app'));
  srv = await startServer({ projects: [{ id: 'app', label: 'App', path: repo }] });
  client = await mcpClient(srv);
});
after(async () => { await client?.close(); await srv?.stop(); });

const call = async (name, args = {}) => client.callTool({ name, arguments: args });

test('strumenti git: sola lettura', async () => {
  const { tools } = await client.listTools();
  for (const n of ['git_repos', 'git_status', 'git_log']) assert.equal(tools.find(t => t.name === n)?.annotations.readOnlyHint, true, n);
  let r = await call('git_repos');
  assert.equal(r.structuredContent.repos[0].branch, 'main');
  r = await call('git_log', { repo: 'app', limit: 5 });
  assert.equal(r.structuredContent.commits[0].subject, 'init');
  r = await call('git_status', { repo: 'nope' });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, 'git.repo_not_found');
});
