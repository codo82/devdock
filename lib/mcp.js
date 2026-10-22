// Server MCP (Model Context Protocol) su /mcp: Streamable HTTP senza sessioni, con
// gli strumenti dichiarati dalle estensioni (setting.json → mcp.tools). Accesso con un
// token bearer salvato accanto a config.json (mai esportato); niente richieste da browser.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { CONFIG_PATH } = require('./env');
const { ApiError, ConfigError, coreError, errorBody } = require('./errors');

const MAX_TEXT = 20000; // caratteri del testo restituito all'agente

const tokenFile = () => path.join(path.dirname(CONFIG_PATH), '.devdock-mcp-token');

// Token esistente o nuovo (32 byte casuali, file leggibile solo dall'utente)
function getToken() {
  try {
    const t = fs.readFileSync(tokenFile(), 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(t)) return t;
  } catch { /* non ancora creato */ }
  return regenerateToken();
}

function regenerateToken() {
  const t = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile(), t + '\n', { mode: 0o600 });
  return t;
}

const sameToken = (given, expected) => {
  const a = Buffer.from(String(given)), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Risultato di uno strumento: JSON strutturato e lo stesso JSON come testo (troncato)
function toolResult(value) {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value };
  let text = JSON.stringify(data, null, 2);
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '\n… (truncated)';
  return { content: [{ type: 'text', text }], structuredContent: data };
}

// Errore come errore dello strumento, con il codice delle API (M6)
function toolError(err) {
  const body = err instanceof ApiError || err instanceof ConfigError || err?.code?.includes?.('.')
    ? errorBody(err) : errorBody(coreError(500, 'internal', { error: err?.message || String(err) }));
  return { isError: true, content: [{ type: 'text', text: `${body.code ? `[${body.code}] ` : ''}${body.error}` }], structuredContent: body };
}

function instructions(extensions) {
  const tools = extensions.mcpTools();
  const byExt = [...new Set(tools.map(t => t.extension))];
  return [
    'DevDock is a local developer dashboard running on this machine: SSH tunnels, projects (npm scripts, Git repositories, .env files), PM2 processes and a MySQL/MariaDB client.',
    `Tools are prefixed with the extension they belong to (${byExt.join(', ') || 'none loaded'}).`,
    'All tools only read state, except the npm ones that run and stop scripts.',
    'Database tools work only while the user has unlocked the DevDock vault from its UI; if they report a locked vault, ask the user to unlock it. Never ask for the master password.',
  ].join('\n');
}

// Middleware per /mcp
function mcpHandler(extensions, { version }) {
  return async (req, res) => {
    // le richieste dei browser hanno sempre Origin: un client MCP locale no
    if (req.get('Origin')) return res.status(403).json(errorBody(coreError(403, 'mcp_browser')));
    const auth = /^Bearer\s+(.+)$/i.exec(req.get('Authorization') || '')?.[1];
    if (!auth || !sameToken(auth, getToken())) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json(errorBody(coreError(401, 'mcp_token')));
    }
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json(errorBody(coreError(405, 'mcp_method')));

    const tools = extensions.mcpTools();
    const server = new Server({ name: 'devdock', version }, { capabilities: { tools: {} }, instructions: instructions(extensions) });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map(t => ({
        name: t.name, description: t.description, inputSchema: t.inputSchema,
        annotations: { readOnlyHint: t.readOnly, openWorldHint: false },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const tool = tools.find(t => t.name === request.params.name);
      if (!tool) return toolError(coreError(404, 'mcp_tool_unknown', { name: String(request.params.name) }));
      try { return toolResult(await tool.run(request.params.arguments || {})); }
      catch (e) { return toolError(e); }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json(errorBody(coreError(500, 'internal', { error: e.message })));
    }
  };
}

module.exports = { mcpHandler, getToken, regenerateToken, tokenFile, toolResult, toolError };
