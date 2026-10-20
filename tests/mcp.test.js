// Server MCP: autenticazione, elenco e chiamata degli strumenti con il client dell'SDK
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { startServer, tmpDir, makeRepo } = require('./helpers');
const { startMysql } = require('./mysql');

let srv, repo, token, client;
before(async () => {
  repo = makeRepo(path.join(tmpDir(), 'app'), { scripts: { hello: 'node -e "console.log(\'ciao da npm\')"' } });
  srv = await startServer({ groups: [], servers: [], projects: [{ id: 'app', label: 'App', path: repo }] });
  token = (await srv.request('GET', '/api/core/mcp')).json.token;
  client = await connect(srv, token);
});
after(async () => { await client?.close(); await srv?.stop(); });

async function connect(s, tok) {
  const c = new Client({ name: 'devdock-test', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${tok}` } },
  }));
  return c;
}

const call = async (name, args = {}) => client.callTool({ name, arguments: args });

test('token: generato, fuori da config.json, obbligatorio; niente richieste da browser', async () => {
  assert.match(token, /^[a-f0-9]{64}$/);
  const file = path.join(path.dirname(srv.configPath), '.devdock-mcp-token');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), token);
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'leggibile solo dal proprietario');
  assert.doesNotMatch(fs.readFileSync(srv.configPath, 'utf8'), new RegExp(token));
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } };
  const headers = { Accept: 'application/json, text/event-stream' };
  let r = await srv.request('POST', '/mcp', { body: init, headers });
  assert.equal(r.status, 401);
  r = await srv.request('POST', '/mcp', { body: init, headers: { ...headers, Authorization: 'Bearer ' + 'f'.repeat(64) } });
  assert.equal(r.status, 401);
  r = await srv.request('POST', '/mcp', { body: init, headers: { ...headers, Authorization: `Bearer ${token}`, Origin: `http://127.0.0.1:${srv.port}` } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'core.mcp_browser');
});

test('istruzioni ed elenco degli strumenti, con il prefisso dell\'estensione', async () => {
  assert.match(client.getInstructions(), /DevDock/);
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  for (const n of ['tunnels_list', 'pm2_list', 'pm2_logs', 'git_repos', 'git_status', 'git_log', 'npm_projects', 'npm_run', 'npm_stop', 'npm_output', 'db_client_query']) {
    assert.ok(names.includes(n), n);
  }
  assert.equal(tools.find(t => t.name === 'npm_run').annotations.readOnlyHint, false);
  assert.equal(tools.find(t => t.name === 'git_log').annotations.readOnlyHint, true);
  const panel = (await srv.request('GET', '/api/core/mcp')).json;
  assert.equal(panel.url, `http://127.0.0.1:${srv.port}/mcp`);
  assert.equal(panel.tools.length, tools.length);
});

test('git e npm: lettura, avvio di uno script e suo output', async () => {
  let r = await call('git_repos');
  assert.equal(r.structuredContent.repos[0].branch, 'main');
  r = await call('git_log', { repo: 'app', limit: 5 });
  assert.equal(r.structuredContent.commits[0].subject, 'init');
  r = await call('git_status', { repo: 'nope' });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, 'git.repo_not_found');

  r = await call('npm_projects');
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

test('strumento sconosciuto: errore dello strumento con codice', async () => {
  const r = await call('nope_tool');
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, 'core.mcp_tool_unknown');
});

test('database: solo con il vault sbloccato dall\'interfaccia, solo letture, niente credenziali', async t => {
  let r = await call('db_client_connections');
  assert.equal(r.structuredContent.code, 'db-client.mcp_vault_locked');

  const mysqlDb = await startMysql();
  if (!mysqlDb) return t.skip('mysqld non installato');
  try {
    const api = (m, p, body) => srv.request(m, `/api/ext/db-client${p}`, { body });
    await api('POST', '/vault/init', { password: 'master-password-db' });
    await api('POST', '/connections', { id: 'c', label: 'Locale', host: '127.0.0.1', port: mysqlDb.port, database: 'app', user: 'devdock', password: 'devdock-pass' });

    r = await call('db_client_connections');
    assert.deepEqual(r.structuredContent.connections[0], { id: 'c', label: 'Locale', host: '127.0.0.1', port: mysqlDb.port, tunnel: null, database: 'app', readOnly: false });
    assert.doesNotMatch(r.content[0].text, /devdock-pass|password|"user"/);
    r = await call('db_client_tables', { connection: 'c' });
    assert.deepEqual(r.structuredContent.tables.map(x => x.name), ['clienti']);
    r = await call('db_client_describe', { connection: 'c', table: 'clienti' });
    assert.deepEqual(r.structuredContent.primaryKey, ['id']);
    r = await call('db_client_query', { connection: 'c', sql: 'SELECT nome FROM clienti ORDER BY id', limit: 2 });
    assert.deepEqual(r.structuredContent.rows, [['Rossi'], ['Bianchi']]);
    assert.equal(r.structuredContent.truncated, true);
    r = await call('db_client_query', { connection: 'c', sql: 'DELETE FROM clienti' });
    assert.equal(r.structuredContent.code, 'db-client.mcp_read_only');
    // le letture girano in una transazione READ ONLY: una scrittura sfuggita al classificatore fallirebbe
    r = await call('db_client_query', { connection: 'c', sql: 'SELECT COUNT(*) FROM clienti' });
    assert.equal(r.structuredContent.rows[0][0], '3');

    assert.equal((await api('POST', '/vault/lock', {})).status, 200);
    r = await call('db_client_query', { connection: 'c', sql: 'SELECT 1' });
    assert.equal(r.structuredContent.code, 'db-client.mcp_vault_locked');
  } finally {
    await mysqlDb.stop();
  }
});
