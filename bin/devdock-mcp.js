#!/usr/bin/env node
// Nome di prima della 2.13: le configurazioni dei client MCP (Claude Desktop) puntano a questo
// file con il percorso assoluto, quindi resta e avvia il ponte di bin/kelbo-mcp.js
const bridge = require('./kelbo-mcp.js');
bridge.main().catch(e => { process.stderr.write(`kelbo-mcp: ${e.message}\n`); process.exit(1); });
