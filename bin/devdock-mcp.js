#!/usr/bin/env node
// Ponte stdio → server MCP di DevDock (/mcp, Streamable HTTP), per i client che avviano i
// server MCP come processi (Claude Desktop e simili). Porta e file del token sono quelli
// dell'istanza (DEVDOCK_PORT, DEVDOCK_CONFIG come per il server): nella configurazione del
// client non c'è nessun segreto, e il token è riletto a ogni richiesta, così il ponte
// continua a funzionare dopo una rigenerazione.
//   node bin/devdock-mcp.js        oppure   devdock mcp
const fs = require('fs');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { PORT } = require('../lib/env');
const { tokenFile } = require('../lib/mcp');
const { coreError } = require('../lib/errors');

const url = new URL(`http://127.0.0.1:${PORT}/mcp`);

const readToken = () => {
  try { return fs.readFileSync(tokenFile(), 'utf8').trim(); } catch { return ''; }
};

// fetch con il token attuale; DevDock spento o token sbagliato diventano errori con un codice
// Un 401 si ritenta una volta con il token riletto: il file nasce alla prima richiesta al
// server, o il token è appena stato rigenerato
async function devdockFetch(input, init = {}) {
  const attempt = async () => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${readToken()}`);
    try { return await fetch(input, { ...init, headers }); }
    catch { throw Object.assign(coreError(503, 'mcp_bridge_unreachable', { url: url.origin }), { bridge: true }); }
  };
  let res = await attempt();
  if (res.status === 401) res = await attempt();
  if (res.status === 401) throw Object.assign(coreError(401, 'mcp_bridge_token', { file: tokenFile() }), { bridge: true });
  return res;
}

async function main() {
  const local = new StdioServerTransport();
  const remote = new StreamableHTTPClientTransport(url, { fetch: devdockFetch });

  // messaggi del client → DevDock; un errore di collegamento torna come risposta JSON-RPC
  local.onmessage = async message => {
    try { await remote.send(message); }
    catch (e) {
      const text = e.bridge ? e.message : coreError(502, 'mcp_bridge_failed', { error: e.message || String(e) }).message;
      process.stderr.write(`devdock-mcp: ${text}\n`);
      if (message.id !== undefined) await local.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: text } });
    }
  };
  remote.onmessage = message => local.send(message);
  // il flusso SSE in GET non è usato dal server (risposte JSON): i suoi errori non fermano il ponte
  remote.onerror = e => { if (!/405|SSE/i.test(String(e?.message))) process.stderr.write(`devdock-mcp: ${e?.message || e}\n`); };
  local.onclose = () => { remote.close().catch(() => {}); process.exit(0); };

  await remote.start();
  await local.start();
}

if (require.main === module) {
  main().catch(e => { process.stderr.write(`devdock-mcp: ${e.message}\n`); process.exit(1); });
}

module.exports = { main };
