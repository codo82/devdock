// Ponte stdio → server MCP: un client stdio vede gli strumenti di Kelbo senza conoscere il
// token, il ponte continua dopo una rigenerazione e spiega quando Kelbo non è avviato
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { startServer, freePort, tmpDir } = require('../lib/testkit');
const { sampleExtensions } = require('./fixtures');

const BRIDGE = path.join(__dirname, '..', 'bin', 'kelbo-mcp.js');
let srv;
before(async () => { srv = await startServer({ projects: [], items: [{ id: 'i1' }] }, { extensions: sampleExtensions() }); });
after(() => srv?.stop());

async function connect(env) {
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  const stderr = [];
  const transport = new StdioClientTransport({ command: process.execPath, args: [BRIDGE], env: { PATH: process.env.PATH, ...env }, stderr: 'pipe' });
  transport.stderr?.on('data', d => stderr.push(String(d)));
  await client.connect(transport);
  return { client, stderr };
}

test('il client stdio vede gli strumenti e li chiama; il token rigenerato è riletto', async () => {
  const { client } = await connect({ KELBO_PORT: String(srv.port), KELBO_CONFIG: srv.configPath });
  try {
    assert.equal(client.getServerVersion().name, 'kelbo');
    const names = (await client.listTools()).tools.map(t => t.name);
    assert.ok(names.includes('sample_items'));
    let r = await client.callTool({ name: 'sample_items', arguments: {} });
    assert.deepEqual(r.structuredContent.items, [{ id: 'i1' }]);
    // token rigenerato mentre il ponte è attivo: riletto alla richiesta successiva
    await srv.request('POST', '/api/core/mcp/token');
    r = await client.callTool({ name: 'sample_items', arguments: {} });
    assert.deepEqual(r.structuredContent.items, [{ id: 'i1' }]);
  } finally { await client.close(); }
});

test('la configurazione proposta per Claude Desktop usa il ponte, senza token', async () => {
  const r = (await srv.request('GET', '/api/core/mcp')).json;
  assert.equal(r.bridge.command, process.execPath);
  assert.deepEqual(r.bridge.args, [BRIDGE]);
  assert.deepEqual(r.bridge.env, { KELBO_PORT: String(srv.port), KELBO_CONFIG: srv.configPath });
  assert.doesNotMatch(JSON.stringify(r.bridge), new RegExp(r.token));
});

test('Kelbo spento o token di un\'altra istanza: errore chiaro al client', async () => {
  const port = await freePort();
  // l'inizializzazione stessa fallisce con il messaggio del ponte
  await assert.rejects(async () => {
    const c = new Client({ name: 'bridge-test', version: '1.0.0' });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [BRIDGE], env: { PATH: process.env.PATH, KELBO_PORT: String(port), KELBO_CONFIG: srv.configPath } }));
  }, new RegExp(`Kelbo non è in esecuzione su http://127\\.0\\.0\\.1:${port}`));
  await assert.rejects(async () => {
    const c = new Client({ name: 'bridge-test', version: '1.0.0' });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [BRIDGE], env: { PATH: process.env.PATH, DEVDOCK_PORT: String(srv.port), DEVDOCK_CONFIG: path.join(tmpDir(), 'config.json') } }));
  }, /ha rifiutato il token/);
});
