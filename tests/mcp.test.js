// Server MCP: autenticazione, elenco e chiamata degli strumenti con il client dell'SDK
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, mcpClient } = require('../lib/testkit');
const { sampleExtensions } = require('./fixtures');

let srv, token, client;
before(async () => {
  srv = await startServer({ projects: [], items: [{ id: 'i1' }] }, { extensions: sampleExtensions() });
  client = await mcpClient(srv);
  token = client.token;
});
after(async () => { await client?.close(); await srv?.stop(); });

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
  assert.deepEqual(tools.map(t => t.name).sort(), ['sample_items', 'sample_touch']);
  assert.equal(tools.find(t => t.name === 'sample_touch').annotations.readOnlyHint, false);
  assert.equal(tools.find(t => t.name === 'sample_items').annotations.readOnlyHint, true);
  const panel = (await srv.request('GET', '/api/core/mcp')).json;
  assert.equal(panel.url, `http://127.0.0.1:${srv.port}/mcp`);
  assert.equal(panel.tools.length, tools.length);
});

test('chiamata: risultato strutturato, errori dell\'estensione con codice', async () => {
  let r = await call('sample_items');
  assert.deepEqual(r.structuredContent, { items: [{ id: 'i1' }] });
  r = await call('sample_touch', { id: 'x' });
  assert.deepEqual(r.structuredContent, { touched: 'x' });
  r = await call('sample_touch', { id: 'nope' });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, 'sample.not_found');
});

test('strumento sconosciuto: errore dello strumento con codice', async () => {
  const r = await call('nope_tool');
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, 'core.mcp_tool_unknown');
});

