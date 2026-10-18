const express = require('express');
const { spawn, spawnSync, execSync, execFileSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
// Sovrascrivibili da ambiente (istanze di test, più installazioni)
const PORT = parseInt(process.env.DEVDOCK_PORT) || 3500;
const CONFIG_PATH = process.env.DEVDOCK_CONFIG || path.join(__dirname, 'config.json');

// ============================================================================
// SICUREZZA — l'API esegue ssh/npm/git/pm2: accetta solo richieste dalla UI locale
// ============================================================================

const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const UNSAFE_METHODS  = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const ALLOWED_HOSTS   = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

// Anti DNS rebinding: un dominio esterno può risolvere a 127.0.0.1 e diventare
// "same-origin" con l'API. Il suo nome resta però nell'header Host, quindi si
// accettano solo gli host locali.
app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.has((req.get('Host') || '').toLowerCase())) {
    return res.status(421).json({ error: 'Host non consentito' });
  }
  next();
});

// Anti-CSRF: una pagina web qualsiasi aperta nel browser può inviare richieste a
// localhost. I browser aggiungono sempre Origin alle richieste cross-site non-GET,
// quindi si rifiuta ogni Origin (o in mancanza Referer) che non sia la UI stessa.
// Richieste senza nessuno dei due (curl, script locali) sono ammesse.
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ error: 'Origine non consentita' });
  }
  if (!origin && UNSAFE_METHODS.has(req.method)) {
    const referer = req.get('Referer');
    if (referer && !ALLOWED_ORIGINS.has(originOf(referer))) {
      return res.status(403).json({ error: 'Origine non consentita' });
    }
  }
  next();
});

app.disable('x-powered-by');

// Header di sicurezza. La CSP ammette script inline (la UI usa onclick inline)
// e cdnjs per Swagger UI; connect-src resta aperto per il "Try it out" di Swagger.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' http: https:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});

// I form HTML cross-site possono inviare solo tipi "semplici" (form, text/plain):
// esigere JSON chiude anche il caso di browser che non inviano Origin
app.use('/api', (req, res, next) => {
  if ((req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type deve essere application/json' });
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// CONFIG JSON
// ============================================================================

const EMPTY_CONFIG = { groups: [], servers: [], projects: [] };

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(EMPTY_CONFIG, null, 2));
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  // Config create con versioni precedenti possono non avere tutte le chiavi
  for (const k of Object.keys(EMPTY_CONFIG)) if (!Array.isArray(cfg[k])) cfg[k] = [];
  return cfg;
}

// ---- Validazione: i valori finiscono in argomenti di ssh/npm/git e nell'HTML della UI ----

class ConfigError extends Error {}

const KEY_RE    = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR_RE  = /^#[0-9a-f]{3,8}$/i;
const REMOTE_RE = /^(\[[0-9a-f:.]+\]|[A-Za-z0-9._-]+):(\d{1,5})$/i; // host:porta o [ipv6]:porta
const ALIAS_RE  = /^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/;               // host/alias ssh, mai "-" iniziale

const isPort = n => Number.isInteger(n) && n >= 1 && n <= 65535;
const isText = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

function validateServer(srv) {
  const where = `server "${srv?.key}"`;
  if (!srv || typeof srv !== 'object') throw new ConfigError('Server non valido');
  if (!KEY_RE.test(srv.key || '')) throw new ConfigError(`${where}: chiave non valida (lettere, numeri, _ e -)`);
  if (!isText(srv.label)) throw new ConfigError(`${where}: nome obbligatorio`);
  if (!isPort(srv.port)) throw new ConfigError(`${where}: porta locale non valida (1-65535)`);
  const m = REMOTE_RE.exec(srv.remote || '');
  if (!m || !isPort(Number(m[2]))) throw new ConfigError(`${where}: remote non valido (formato host:porta)`);
  if (!ALIAS_RE.test(srv.alias || '')) throw new ConfigError(`${where}: alias SSH non valido`);
  if (srv.type != null && !isText(srv.type, 40)) throw new ConfigError(`${where}: tipo non valido`);
}

function validateGroup(g, serverKeys) {
  const where = `gruppo "${g?.key}"`;
  if (!g || typeof g !== 'object') throw new ConfigError('Gruppo non valido');
  if (!KEY_RE.test(g.key || '')) throw new ConfigError(`${where}: chiave non valida (lettere, numeri, _ e -)`);
  if (!isText(g.label)) throw new ConfigError(`${where}: nome obbligatorio`);
  if (!COLOR_RE.test(g.color || '')) throw new ConfigError(`${where}: colore non valido (#rrggbb)`);
  if (!Array.isArray(g.servers)) throw new ConfigError(`${where}: lista server non valida`);
  const missing = g.servers.filter(k => !serverKeys.has(k));
  if (missing.length) throw new ConfigError(`${where}: server inesistenti ${missing.join(', ')}`);
}

function validateProject(p) {
  const where = `progetto "${p?.id}"`;
  if (!p || typeof p !== 'object') throw new ConfigError('Progetto non valido');
  if (!KEY_RE.test(p.id || '')) throw new ConfigError(`${where}: id non valido (lettere, numeri, _ e -)`);
  if (!isText(p.label)) throw new ConfigError(`${where}: nome obbligatorio`);
  if (!isText(p.path, 1024) || !path.isAbsolute(p.path)) throw new ConfigError(`${where}: il percorso deve essere assoluto`);
}

function assertUnique(list, field, what) {
  const seen = new Set();
  for (const x of list) {
    if (seen.has(x[field])) throw new ConfigError(`${what} duplicato: ${x[field]}`);
    seen.add(x[field]);
  }
}

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new ConfigError('Config non valida');
  for (const k of Object.keys(EMPTY_CONFIG)) {
    if (!Array.isArray(cfg[k])) throw new ConfigError(`Config non valida: "${k}" deve essere una lista`);
  }
  cfg.servers.forEach(validateServer);
  assertUnique(cfg.servers, 'key', 'Server');
  const serverKeys = new Set(cfg.servers.map(s => s.key));
  cfg.groups.forEach(g => validateGroup(g, serverKeys));
  assertUnique(cfg.groups, 'key', 'Gruppo');
  cfg.projects.forEach(validateProject);
  assertUnique(cfg.projects, 'id', 'Progetto');
}

// Solo i campi noti: nessuna proprietà arbitraria finisce in config.json
const pick = (obj, fields) => Object.fromEntries(fields.filter(f => obj[f] !== undefined).map(f => [f, obj[f]]));
const SERVER_FIELDS  = ['key', 'label', 'port', 'remote', 'alias', 'type'];
const GROUP_FIELDS   = ['key', 'label', 'color', 'servers'];
const PROJECT_FIELDS = ['id', 'label', 'path'];

function normalizeServer(srv) {
  const out = pick(srv || {}, SERVER_FIELDS);
  if (out.port !== undefined) out.port = Number(out.port);
  return out;
}

function saveConfig(cfg) {
  validateConfig(cfg);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function getServerMap(cfg) {
  return Object.fromEntries(cfg.servers.map(s => [s.key, s]));
}

// ============================================================================
// SISTEMA — strumenti esterni disponibili
// ============================================================================

function hasCommand(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(finder, [cmd], { stdio: 'ignore' }).status === 0;
}

function detectTools() {
  return {
    ssh:     hasCommand('ssh'),
    autossh: hasCommand('autossh'),
    git:     hasCommand('git'),
    npm:     hasCommand('npm'),
    pm2:     hasCommand('pm2'),
    lsof:    hasCommand('lsof'),
    ss:      process.platform === 'linux' && hasCommand('ss'),
  };
}

let TOOLS = detectTools();

// Stato degli strumenti per la UI (?refresh=1 li ricontrolla, es. dopo un'installazione)
app.get('/api/system', (req, res) => {
  if (req.query.refresh) TOOLS = detectTools();
  res.json({ platform: process.platform, tools: TOOLS });
});

// ============================================================================
// TUNNEL
// ============================================================================

const activeTunnels = new Map();

// ============================================================================
// API — CONFIG
// ============================================================================

app.get('/api/config', (req, res) => {
  res.json(loadConfig());
});

// Export config come download (type: 'all'|'tunnels'|'git')
app.get('/api/config/export', (req, res) => {
  const cfg = loadConfig();
  const type = req.query.type || 'all';
  let data;
  let suffix;
  if (type === 'tunnels') {
    data = { groups: cfg.groups || [], servers: cfg.servers || [] };
    suffix = 'tunnels';
  } else if (type === 'git') {
    data = { projects: cfg.projects || [] };
    suffix = 'git';
  } else {
    data = cfg;
    suffix = 'all';
  }
  res.setHeader('Content-Disposition', `attachment; filename="devdock-config-${suffix}-${new Date().toISOString().slice(0,10)}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(data, null, 2));
});

// Import config (sostituisce o fa merge)
app.post('/api/config/import', (req, res) => {
  try {
    const { config: incoming, mode } = req.body; // mode: 'replace' | 'merge'
    if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.groups) || !Array.isArray(incoming.servers)) {
      return res.status(400).json({ error: 'Config non valida' });
    }
    incoming.servers  = incoming.servers.map(normalizeServer);
    incoming.groups   = incoming.groups.map(g => pick(g || {}, GROUP_FIELDS));
    incoming.projects = Array.isArray(incoming.projects) ? incoming.projects.map(p => pick(p || {}, PROJECT_FIELDS)) : [];
    validateConfig(incoming); // il file importato deve essere valido già da solo
    if (mode === 'merge') {
      const current = loadConfig();
      const existingServerKeys = new Set(current.servers.map(s => s.key));
      const existingGroupKeys  = new Set(current.groups.map(g => g.key));
      incoming.servers.forEach(s => { if (!existingServerKeys.has(s.key)) current.servers.push(s); });
      incoming.groups.forEach(g => {
        if (!existingGroupKeys.has(g.key)) current.groups.push(g);
        else {
          const cur = current.groups.find(x => x.key === g.key);
          g.servers.forEach(sk => { if (!cur.servers.includes(sk)) cur.servers.push(sk); });
        }
      });
      saveConfig(current);
    } else {
      saveConfig(incoming);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(e instanceof ConfigError ? 400 : 500).json({ error: e.message });
  }
});

// Salva intera config
app.put('/api/config', (req, res) => {
  try {
    // Le chiavi non gestite qui (es. dati di estensioni) restano quelle attuali
    const cfg = { ...loadConfig(), ...pick(req.body || {}, Object.keys(EMPTY_CONFIG)) };
    saveConfig(cfg);
    res.json({ ok: true });
  } catch (e) {
    res.status(e instanceof ConfigError ? 400 : 500).json({ error: e.message });
  }
});

// Gruppo — crea
app.post('/api/config/groups', (req, res) => {
  const cfg = loadConfig();
  const { key, label, color } = req.body;
  if (!key || !label) return res.status(400).json({ error: 'key e label obbligatori' });
  if (cfg.groups.find(g => g.key === key)) return res.status(409).json({ error: 'Chiave già esistente' });
  cfg.groups.push({ key, label, color: color || '#6b7280', servers: [] }); // validato da saveConfig
  saveConfig(cfg);
  res.json({ ok: true });
});

// Gruppo — aggiorna
app.put('/api/config/groups/:key', (req, res) => {
  const cfg = loadConfig();
  const idx = cfg.groups.findIndex(g => g.key === req.params.key);
  if (idx === -1) return res.status(404).json({ error: 'Gruppo non trovato' });
  cfg.groups[idx] = { ...cfg.groups[idx], ...pick(req.body, ['label', 'color', 'servers']) };
  saveConfig(cfg);
  res.json({ ok: true });
});

// Gruppo — elimina
app.delete('/api/config/groups/:key', (req, res) => {
  const cfg = loadConfig();
  cfg.groups = cfg.groups.filter(g => g.key !== req.params.key);
  saveConfig(cfg);
  res.json({ ok: true });
});

// Server — crea
app.post('/api/config/servers', (req, res) => {
  const cfg = loadConfig();
  const { key, label, port, remote, alias, type, groupKey } = req.body;
  if (!key || !label || !port || !remote || !alias) return res.status(400).json({ error: 'Campi obbligatori mancanti' });
  if (cfg.servers.find(s => s.key === key)) return res.status(409).json({ error: 'Chiave già esistente' });
  cfg.servers.push(normalizeServer({ key, label, port, remote, alias, type: type || 'TCP' }));
  if (groupKey) {
    const g = cfg.groups.find(g => g.key === groupKey);
    if (g) g.servers.push(key);
  }
  saveConfig(cfg);
  res.json({ ok: true });
});

// Server — aggiorna
app.put('/api/config/servers/:key', (req, res) => {
  const cfg = loadConfig();
  const idx = cfg.servers.findIndex(s => s.key === req.params.key);
  if (idx === -1) return res.status(404).json({ error: 'Server non trovato' });
  cfg.servers[idx] = { ...cfg.servers[idx], ...normalizeServer(pick(req.body, ['label', 'port', 'remote', 'alias', 'type'])) };
  saveConfig(cfg);
  res.json({ ok: true });
});

// Server — elimina
app.delete('/api/config/servers/:key', (req, res) => {
  const cfg = loadConfig();
  cfg.servers = cfg.servers.filter(s => s.key !== req.params.key);
  cfg.groups.forEach(g => { g.servers = g.servers.filter(sk => sk !== req.params.key); });
  saveConfig(cfg);
  res.json({ ok: true });
});

// Sposta server tra gruppi / riordina
app.put('/api/config/groups/:key/servers', (req, res) => {
  const cfg = loadConfig();
  const g = cfg.groups.find(g => g.key === req.params.key);
  if (!g) return res.status(404).json({ error: 'Gruppo non trovato' });
  g.servers = req.body.servers;
  saveConfig(cfg);
  res.json({ ok: true });
});

// ============================================================================
// API — GRUPPI (read, per UI principale)
// ============================================================================

app.get('/api/groups', (req, res) => {
  const cfg = loadConfig();
  const serverMap = getServerMap(cfg);
  const result = cfg.groups.map(g => ({
    key: g.key,
    label: g.label,
    color: g.color,
    servers: g.servers.map(sk => serverMap[sk]).filter(Boolean),
  }));
  res.json(result);
});

// ============================================================================
// API — TUNNEL
// ============================================================================

app.get('/api/tunnels', (req, res) => {
  const list = [];
  for (const [id, t] of activeTunnels) {
    list.push({
      id, serverKey: t.serverKey, label: t.label, port: t.port,
      remote: t.remote, alias: t.alias, type: t.type,
      pid: t.pid, startedAt: t.startedAt,
      reconnecting: !!t.reconnectTimer,
    });
  }
  res.json(list);
});

// Parametri reconnect
const RECONNECT_INITIAL_DELAY = 5000;   // 5s primo tentativo
const RECONNECT_MAX_DELAY     = 60000;  // max 60s tra un tentativo e l'altro
const RECONNECT_BACKOFF       = 1.5;    // moltiplicatore backoff

function spawnTunnel(id, sshArgs, useAuto) {
  const td = activeTunnels.get(id);
  if (!td || td.stopping) return;

  const proc = useAuto
    ? spawn('autossh', ['-M', '0', ...sshArgs])
    : spawn('ssh', sshArgs);

  td.process = proc;
  td.pid     = proc.pid;

  const log = text => {
    td.logs.push({ ts: Date.now(), text });
    if (td.logs.length > 200) td.logs.splice(0, td.logs.length - 200);
  };

  const mode = useAuto ? 'autossh' : 'ssh';
  log(`Connessione a ${td.alias} → 127.0.0.1:${td.port} ↔ ${td.remote} [${mode}, pid ${proc.pid}]`);

  proc.stdout.on('data', d => log(d.toString()));
  proc.stderr.on('data', d => log(d.toString()));

  proc.on('error', err => log(`Errore spawn: ${err.message}`));

  proc.on('close', code => {
    if (!activeTunnels.has(id)) return; // già rimosso manualmente
    const t = activeTunnels.get(id);
    if (t.stopping) { activeTunnels.delete(id); return; }

    const delay = Math.min(t.reconnectDelay, RECONNECT_MAX_DELAY);
    log(`Tunnel chiuso (exit ${code}). Riconnessione tra ${Math.round(delay/1000)}s...`);
    t.reconnectDelay = Math.round(delay * RECONNECT_BACKOFF);
    t.reconnectTimer = setTimeout(() => {
      if (!activeTunnels.has(id) || activeTunnels.get(id).stopping) return;
      activeTunnels.get(id).reconnectTimer = null;
      spawnTunnel(id, sshArgs, useAuto);
    }, delay);
  });
}

app.post('/api/tunnels/start', (req, res) => {
  const { serverKey, port: customPort } = req.body;
  const cfg = loadConfig();
  const serverMap = getServerMap(cfg);
  const srv = serverMap[serverKey];
  if (!srv) return res.status(400).json({ error: 'Server non trovato' });

  const localPort = parseInt(customPort) || srv.port;
  for (const [, t] of activeTunnels) {
    if (t.port === localPort) return res.status(409).json({ error: `Porta ${localPort} già in uso da "${t.label}"` });
  }

  const id = crypto.randomUUID();
  const sshArgs = [
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'TCPKeepAlive=yes',
    '-L', `127.0.0.1:${localPort}:${srv.remote}`,
    '-N', srv.alias,
  ];

  const useAuto = hasCommand('autossh'); // ricontrollato a ogni avvio: può essere installato a server acceso
  const td = {
    serverKey, label: srv.label, port: localPort,
    remote: srv.remote, alias: srv.alias, type: srv.type,
    pid: null, process: null,
    startedAt: new Date().toISOString(),
    logs: [],
    stopping: false,
    reconnectDelay: RECONNECT_INITIAL_DELAY,
    reconnectTimer: null,
  };
  activeTunnels.set(id, td);
  spawnTunnel(id, sshArgs, useAuto);

  res.json({ id, pid: td.pid, port: localPort, label: srv.label });
});

app.delete('/api/tunnels/:id', (req, res) => {
  const t = activeTunnels.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tunnel non trovato' });
  t.stopping = true;
  if (t.reconnectTimer) clearTimeout(t.reconnectTimer);
  try { t.process && t.process.kill('SIGTERM'); } catch {}
  activeTunnels.delete(req.params.id);
  res.json({ ok: true });
});

app.get('/api/tunnels/:id/logs', (req, res) => {
  const t = activeTunnels.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tunnel non trovato' });
  res.json(t.logs.slice(-100));
});

app.delete('/api/tunnels', (req, res) => {
  for (const [, t] of activeTunnels) {
    t.stopping = true;
    if (t.reconnectTimer) clearTimeout(t.reconnectTimer);
    try { t.process && t.process.kill('SIGTERM'); } catch {}
  }
  activeTunnels.clear();
  res.json({ ok: true });
});

// ============================================================================
// API — NPM / PM2 MANAGER
// ============================================================================

// Legge i progetti dalla config
function getProjects() {
  const cfg = loadConfig();
  return cfg.projects || [];
}

function saveProjects(projects) {
  const cfg = loadConfig();
  cfg.projects = projects;
  saveConfig(cfg);
}

// Progetti — CRUD
app.get('/api/projects', (req, res) => {
  res.json(getProjects());
});

app.post('/api/projects', (req, res) => {
  const { id, label, path: projectPath } = req.body;
  if (!id || !label || !projectPath) return res.status(400).json({ error: 'id, label e path obbligatori' });
  const projects = getProjects();
  if (projects.find(p => p.id === id)) return res.status(409).json({ error: 'ID già esistente' });
  if (!fs.existsSync(projectPath)) return res.status(400).json({ error: `Cartella non trovata: ${projectPath}` });
  projects.push({ id, label, path: projectPath });
  saveProjects(projects);
  res.json({ ok: true });
});

app.put('/api/projects/:id', (req, res) => {
  const projects = getProjects();
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Progetto non trovato' });
  const { label, path: projectPath } = req.body;
  if (projectPath && !fs.existsSync(projectPath)) return res.status(400).json({ error: `Cartella non trovata: ${projectPath}` });
  projects[idx] = { ...projects[idx], ...pick(req.body, ['label', 'path']) };
  saveProjects(projects);
  res.json({ ok: true });
});

app.delete('/api/projects/:id', (req, res) => {
  const projects = getProjects().filter(p => p.id !== req.params.id);
  saveProjects(projects);
  res.json({ ok: true });
});

// package.json del progetto (null se assente o non valido)
function readProjectPackage(p) {
  try { return JSON.parse(fs.readFileSync(path.join(p.path, 'package.json'), 'utf8')); } catch { return null; }
}

// Nome pacchetto npm (anche scoped): impedisce path traversal e opzioni travestite
const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

// Legge package.json di un progetto
app.get('/api/projects/:id/package', (req, res) => {
  const p = getProjects().find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Progetto non trovato' });
  const pkgPath = path.join(p.path, 'package.json');
  if (!fs.existsSync(pkgPath)) return res.json({ name: null, scripts: {}, dependencies: {}, devDependencies: {} });
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    res.json({
      name: pkg.name || null,
      version: pkg.version || null,
      scripts: pkg.scripts || {},
      dependencies: pkg.dependencies || {},
      devDependencies: pkg.devDependencies || {},
    });
  } catch (e) {
    res.status(500).json({ error: 'package.json non valido' });
  }
});

// Versioni installate (legge da node_modules/<pkg>/package.json)
app.post('/api/projects/:id/installed-versions', (req, res) => {
  const p = getProjects().find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Progetto non trovato' });
  const packages = Array.isArray(req.body.packages) ? req.body.packages : [];
  const result = {};
  for (const name of packages) {
    if (typeof name !== 'string' || !NPM_NAME_RE.test(name)) continue;
    try {
      const pkgFile = path.join(p.path, 'node_modules', name, 'package.json');
      if (fs.existsSync(pkgFile)) {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        result[name] = pkg.version || null;
      } else {
        result[name] = null;
      }
    } catch {
      result[name] = null;
    }
  }
  res.json(result);
});

// npm outdated (eseguito nel cwd del progetto, output JSON)
app.get('/api/projects/:id/outdated', (req, res) => {
  const p = getProjects().find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Progetto non trovato' });
  try {
    // npm outdated --json esce con codice 1 se ci sono pacchetti obsoleti — ignoriamo il codice
    let out = '';
    try {
      out = execSync('npm outdated --json', { cwd: p.path, encoding: 'utf8', timeout: 30000 });
    } catch (e) {
      out = e.stdout || '{}'; // npm outdated restituisce exit 1 ma stdout è valido
    }
    res.json(JSON.parse(out || '{}'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// PROCESSI NPM TRACCIATI (come activeTunnels per SSH)
// ============================================================================

const activeProcesses = new Map(); // id → { id, projectId, projectLabel, script, pid, process, startedAt, logs[], running, exitCode }

function procLog(pd, text) {
  pd.logs.push({ ts: Date.now(), text });
  if (pd.logs.length > 500) pd.logs.splice(0, pd.logs.length - 500);
}

// Esegue un comando senza shell; restituisce stdout ('' se fallisce o esce con codice ≠ 0)
function runQuiet(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch (e) {
    return e.stdout || '';
  }
}


// Porte TCP in LISTEN dei PID dati — lsof (macOS/Linux) con fallback a ss (Linux)
function getListeningPorts(pids) {
  const ports = new Set();
  if (TOOLS.lsof) {
    // -F n: una riga per socket nel formato "n<indirizzo>:<porta>", es. "n*:3000", "n[::1]:5173"
    const out = runQuiet('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(','), '-Fn']);
    for (const line of out.split('\n')) {
      const m = line.match(/^n.*:(\d+)$/);
      if (m && Number(m[1]) > 0) ports.add(Number(m[1]));
    }
  } else if (TOOLS.ss) {
    // formato: "LISTEN 0 511 0.0.0.0:3000 ... users:(("node",pid=1234,fd=20))"
    const pidSet = new Set(pids.map(String));
    for (const line of runQuiet('ss', ['-tlnpH']).split('\n')) {
      const owners = [...line.matchAll(/pid=(\d+),/g)].map(m => m[1]);
      if (!owners.some(p => pidSet.has(p))) continue;
      const m = line.match(/:(\d+)\s/);
      if (m && Number(m[1]) > 0) ports.add(Number(m[1]));
    }
  }
  return [...ports].sort((a, b) => a - b);
}

// Trova le porte usate da un process group (pgid → tutti i PID → socket in LISTEN)
function getPortsForPgid(rootPid) {
  if (process.platform === 'win32') return []; // process group POSIX non disponibili
  // PGID del processo root (di solito coincide col PID dato che usiamo detached)
  const pgid = parseInt(runQuiet('ps', ['-o', 'pgid=', '-p', String(rootPid)]).trim());
  if (!pgid) return [];

  // Tutti i PID nel process group
  const allPids = runQuiet('pgrep', ['-g', String(pgid)]).trim().split(/\s+/).filter(Boolean).map(Number);
  if (!allPids.length) return [];

  return getListeningPorts(allPids);
}

// Lista processi attivi
app.get('/api/processes', (req, res) => {
  const list = [];
  for (const [id, pd] of activeProcesses) {
    const ports = pd.running ? getPortsForPgid(pd.pid) : [];
    list.push({
      id, projectId: pd.projectId, projectLabel: pd.projectLabel,
      script: pd.script, pid: pd.pid, ports,
      startedAt: pd.startedAt, running: pd.running, exitCode: pd.exitCode,
    });
  }
  res.json(list);
});

// Avvia (o riavvia) npm con pd.args nel process group di pd. Gli eventi di un
// processo sostituito da un riavvio vengono ignorati: altrimenti la sua chiusura
// segnerebbe come terminato il processo nuovo.
function spawnTrackedNpm(pd, cwd, header = '') {
  const proc = spawn('npm', pd.args, { cwd, env: { ...process.env }, detached: true });
  pd.process = proc; pd.pid = proc.pid;
  pd.startedAt = new Date().toISOString();
  pd.running = true; pd.exitCode = null;
  procLog(pd, `${header}$ npm ${pd.args.join(' ')} (pid ${proc.pid})\n`);
  const current = () => pd.process === proc;
  proc.stdout.on('data', d => procLog(pd, d.toString()));
  proc.stderr.on('data', d => procLog(pd, d.toString()));
  proc.on('close', code => {
    if (!current()) return;
    pd.running = false; pd.exitCode = code;
    procLog(pd, `\n[exit ${code}]`);
  });
  proc.on('error', err => { if (current()) { pd.running = false; procLog(pd, `\nErrore: ${err.message}`); } });
}

function startTrackedNpm(p, script, args) {
  const pd = {
    id: crypto.randomUUID(), projectId: p.id, projectLabel: p.label,
    script, args, pid: null, process: null,
    startedAt: null, logs: [], running: false, exitCode: null,
  };
  activeProcesses.set(pd.id, pd);
  spawnTrackedNpm(pd, p.path);
  return pd;
}

// Avvia processo npm tracciato: solo "install" o script definiti in package.json
app.post('/api/projects/:id/npm/start', (req, res) => {
  const p = getProjects().find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Progetto non trovato' });
  const { script } = req.body;
  if (typeof script !== 'string' || !script) return res.status(400).json({ error: 'script obbligatorio' });

  let args;
  if (script === 'install') {
    args = ['install'];
  } else {
    const scripts = readProjectPackage(p)?.scripts || {};
    if (!Object.hasOwn(scripts, script)) return res.status(400).json({ error: `Script non definito in package.json: ${script}` });
    args = ['run', script];
  }

  const pd = startTrackedNpm(p, script, args);
  res.json({ id: pd.id, pid: pd.pid });
});

// Aggiorna una dipendenza (npm update <pkg>): solo pacchetti dichiarati in package.json
app.post('/api/projects/:id/npm/update', (req, res) => {
  const p = getProjects().find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Progetto non trovato' });
  const name = req.body.package;
  const pkg = readProjectPackage(p) || {};
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  if (typeof name !== 'string' || !NPM_NAME_RE.test(name) || !Object.hasOwn(declared, name)) {
    return res.status(400).json({ error: `Pacchetto non dichiarato in package.json: ${name}` });
  }
  const pd = startTrackedNpm(p, `update ${name}`, ['update', name]);
  res.json({ id: pd.id, pid: pd.pid });
});

// Ferma processo (killa l'intero process group per liberare la porta)
function killProcessGroup(pd) {
  try {
    if (pd.process && pd.pid) {
      process.kill(-pd.pid, 'SIGTERM');
    }
  } catch {
    // fallback se il process group non esiste più
    try { pd.process && pd.process.kill('SIGTERM'); } catch {}
  }
}

app.delete('/api/processes/:id', (req, res) => {
  const pd = activeProcesses.get(req.params.id);
  if (!pd) return res.status(404).json({ error: 'Processo non trovato' });
  killProcessGroup(pd);
  pd.running = false;
  activeProcesses.delete(req.params.id);
  res.json({ ok: true });
});

// Rimuove processo terminato dalla lista (pulizia manuale)
app.delete('/api/processes/:id/dismiss', (req, res) => {
  const pd = activeProcesses.get(req.params.id);
  if (!pd) return res.status(404).json({ error: 'Processo non trovato' });
  if (pd.running) return res.status(409).json({ error: 'Processo ancora in esecuzione' });
  activeProcesses.delete(req.params.id);
  res.json({ ok: true });
});

// Riavvia processo (kill + respawn)
app.post('/api/processes/:id/restart', (req, res) => {
  const pd = activeProcesses.get(req.params.id);
  if (!pd) return res.status(404).json({ error: 'Processo non trovato' });
  const p = getProjects().find(x => x.id === pd.projectId);
  if (!p) return res.status(400).json({ error: 'Progetto non più disponibile' });

  killProcessGroup(pd);
  spawnTrackedNpm(pd, p.path, '\n--- Riavvio ---\n');
  res.json({ ok: true, pid: pd.pid });
});

// Log SSE di un processo tracciato (streaming live)
app.get('/api/processes/:id/stream', (req, res) => {
  const pd = activeProcesses.get(req.params.id);
  if (!pd) { res.status(404).end(); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, data })}\n\n`); } catch {} };

  // Prima invia tutti i log accumulati
  if (pd.logs.length) send('history', pd.logs.map(l => l.text).join(''));
  if (!pd.running) { send('exit', `[processo terminato, exit ${pd.exitCode}]`); res.end(); return; }

  // Poi aggiorna ogni 300ms con i nuovi log
  let lastSentTs = pd.logs.length ? pd.logs[pd.logs.length - 1].ts : Date.now();
  const interval = setInterval(() => {
    const current = activeProcesses.get(req.params.id);
    if (!current) { clearInterval(interval); send('exit', '[processo rimosso]'); res.end(); return; }
    const newLogs = current.logs.filter(l => l.ts > lastSentTs);
    if (newLogs.length) { send('stdout', newLogs.map(l => l.text).join('')); lastSentTs = newLogs[newLogs.length - 1].ts; }
    if (!current.running) { clearInterval(interval); send('exit', `[exit ${current.exitCode}]`); res.end(); }
  }, 100);

  req.on('close', () => clearInterval(interval));
});

// Log snapshot (ultimi N, per polling leggero)
app.get('/api/processes/:id/logs', (req, res) => {
  const pd = activeProcesses.get(req.params.id);
  if (!pd) return res.status(404).json({ error: 'Processo non trovato' });
  res.json({ running: pd.running, exitCode: pd.exitCode, logs: pd.logs.slice(-200) });
});

// PM2 — lista processi (json)
app.get('/api/pm2/list', (req, res) => {
  const proc = spawn('pm2', ['jlist'], { env: { ...process.env } });
  let out = '';
  proc.stdout.on('data', d => out += d.toString());
  proc.stderr.on('data', d => out += d.toString());
  proc.on('close', () => {
    try {
      const list = JSON.parse(out);
      if (res.headersSent) return;
      res.json(list.map(p => ({
        id: p.pm_id, name: p.name, status: p.pm2_env?.status,
        pid: p.pid, cpu: p.monit?.cpu, memory: p.monit?.memory,
        uptime: p.pm2_env?.pm_uptime, restarts: p.pm2_env?.restart_time,
      })));
    } catch {
      if (!res.headersSent) res.json([]);
    }
  });
  proc.on('error', () => { if (!res.headersSent) res.json([]); });
});

// Nome o id di un processo pm2 (no "-" iniziale: sarebbe letto come opzione)
const PM2_TARGET_RE = /^[A-Za-z0-9_.@:][A-Za-z0-9_.@:-]*$/;
const PM2_ACTIONS = new Set(['start', 'stop', 'restart', 'delete']);

// PM2 — azione su processo (start/stop/restart/delete).
// Con projectId + script avvia "npm run <script>" del progetto sotto pm2.
app.post('/api/pm2/action', (req, res) => {
  const { action, target, projectId, script } = req.body;
  if (!PM2_ACTIONS.has(action)) return res.status(400).json({ error: 'Azione PM2 non supportata' });
  let args;
  if (action === 'start' && projectId) {
    const p = getProjects().find(x => x.id === projectId);
    if (!p) return res.status(404).json({ error: 'Progetto non trovato' });
    const scripts = readProjectPackage(p)?.scripts || {};
    if (typeof script !== 'string' || !Object.hasOwn(scripts, script)) {
      return res.status(400).json({ error: `Script non definito in package.json: ${script}` });
    }
    args = ['start', 'npm', '--name', `${p.id}-${script}`, '--cwd', p.path, '--', 'run', script];
  } else {
    if (typeof target !== 'string' || !PM2_TARGET_RE.test(target)) return res.status(400).json({ error: 'Processo PM2 non valido' });
    args = [action, target];
  }
  const proc = spawn('pm2', args, { env: { ...process.env } });
  let out = '', err = '';
  proc.stdout.on('data', d => out += d.toString());
  proc.stderr.on('data', d => err += d.toString());
  // Se pm2 non esiste arrivano sia 'error' sia 'close': si risponde una volta sola
  proc.on('close', code => {
    if (res.headersSent) return;
    if (code === 0) res.json({ ok: true, out });
    else res.status(500).json({ error: err || out || `exit ${code}` });
  });
  proc.on('error', e => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
});

// PM2 — log streaming via SSE
app.get('/api/pm2/logs', (req, res) => {
  const { name } = req.query;
  if (name != null && !PM2_TARGET_RE.test(name)) return res.status(400).json({ error: 'Processo PM2 non valido' });
  const lines = String(Math.min(Math.max(parseInt(req.query.lines) || 50, 1), 5000));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, data })}\n\n`); };

  const args = name
    ? ['logs', name, '--lines', lines, '--nostream=false']
    : ['logs', '--lines', lines, '--nostream=false'];

  const proc = spawn('pm2', args, { env: { ...process.env } });

  proc.stdout.on('data', d => send('stdout', d.toString()));
  proc.stderr.on('data', d => send('stderr', d.toString()));
  proc.on('close', () => { send('exit', 'Stream terminato'); if (!res.writableEnded) res.end(); });
  proc.on('error', err => { send('error', err.message); if (!res.writableEnded) res.end(); });

  req.on('close', () => { try { proc.kill(); } catch {} });
});

// ============================================================================
// API — GIT
// ============================================================================

function gitExec(cwd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts });
    let out = '', err = '';
    proc.stdout && proc.stdout.on('data', d => out += d.toString());
    proc.stderr && proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      if (code === 0 || opts.allowFail) resolve({ out, err, code });
      else reject(new Error(err.trim() || out.trim() || `git exit ${code}`));
    });
    proc.on('error', reject);
  });
}

// ---- Validazione input git (argument injection: un valore che inizia con "-"
// verrebbe letto da git come opzione, es. "--upload-pack=<comando>") ----

const GIT_ACTIONS = new Set(['commit', 'pull', 'push', 'push_force', 'pull_push', 'merge', 'fetch', 'checkout', 'stash', 'stash_pop']);
const BRANCH_ACTIONS = new Set(['push', 'push_force', 'pull_push', 'merge', 'checkout']); // branch obbligatorio
const REMOTE_ACTIONS = new Set(['pull', 'push', 'push_force', 'pull_push']);              // remote usato

function isValidBranchName(name) {
  if (typeof name !== 'string' || !name || name.startsWith('-')) return false;
  return spawnSync('git', ['check-ref-format', '--branch', name], { stdio: 'ignore' }).status === 0;
}

function isValidCommitHash(hash) {
  return typeof hash === 'string' && /^[0-9a-f]{4,64}$/i.test(hash);
}

async function getGitRemotes(cwd) {
  const r = await gitExec(cwd, ['remote'], { allowFail: true });
  return r.out.split('\n').map(x => x.trim()).filter(Boolean);
}

// Restituisce un messaggio d'errore o null se i parametri sono validi
async function validateGitAction(repoPath, { action, branch, remote, message }) {
  if (!GIT_ACTIONS.has(action)) return 'Azione non supportata';
  if (BRANCH_ACTIONS.has(action) && !branch) return 'Branch obbligatorio';
  if (branch != null && branch !== '' && !isValidBranchName(branch)) return `Nome branch non valido: ${branch}`;
  if (REMOTE_ACTIONS.has(action) && !(await getGitRemotes(repoPath)).includes(remote)) return `Remote sconosciuto: ${remote}`;
  if (message != null && typeof message !== 'string') return 'Messaggio non valido';
  return null;
}

// git status --porcelain -z: nomi file esatti (niente quoting), rinomine con path originale
async function getGitStatus(cwd) {
  const r = await gitExec(cwd, ['status', '--porcelain', '-b', '-z'], { allowFail: true });
  const fields = r.out.split('\0');
  const header = fields[0].startsWith('## ') ? fields.shift() : '';
  const files = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    const entry = { xy: f.slice(0, 2), name: f.slice(3) };
    if (/[RC]/.test(entry.xy)) entry.orig = fields[++i]; // rinomina/copia: segue il path originale
    files.push(entry);
  }
  return { header, files };
}

function findGitRoot(startPath) {
  let dir = startPath;
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root, non trovato
    dir = parent;
  }
}

function getGitRepos() {
  const cfg = loadConfig();
  const projects = cfg.projects || [];
  const seen = new Set();
  const repos = [];
  for (const p of projects) {
    const gitRoot = findGitRoot(p.path);
    if (!gitRoot) continue;
    if (seen.has(gitRoot)) continue; // stesso repo già aggiunto (più progetti npm nella stessa repo)
    seen.add(gitRoot);
    repos.push({ id: p.id, label: p.label, path: gitRoot });
  }
  return repos;
}

// Lista repos (da progetti NPM che hanno .git)
app.get('/api/git/repos', (req, res) => {
  res.json(getGitRepos());
});

// Status: branch, ahead/behind, modifiche
app.get('/api/git/repos/:id/status', async (req, res) => {
  const repos = getGitRepos();
  const repo = repos.find(r => r.id === req.params.id);
  if (!repo) return res.status(404).json({ error: 'Repo non trovato' });
  try {
    const [branchR, { header, files }, stashR] = await Promise.all([
      gitExec(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }),
      getGitStatus(repo.path),
      gitExec(repo.path, ['stash', 'list'], { allowFail: true }),
    ]);

    const branch = branchR.out.trim();

    // Parse ahead/behind dal ## branch
    const aheadM   = header.match(/\[ahead (\d+)/);
    const behindM  = header.match(/behind (\d+)/);
    const ahead    = aheadM  ? parseInt(aheadM[1])  : 0;
    const behind   = behindM ? parseInt(behindM[1]) : 0;

    const stashCount = stashR.out.trim().split('\n').filter(Boolean).length;

    res.json({ branch, ahead, behind, files, stashCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Log grafico (--graph --oneline --all)
app.get('/api/git/repos/:id/log', async (req, res) => {
  const repos = getGitRepos();
  const repo  = repos.find(r => r.id === req.params.id);
  if (!repo) return res.status(404).json({ error: 'Repo non trovato' });
  const limit = Math.min(parseInt(req.query.limit) || 40, 2000);
  try {
    // Mappa hash-completo → [branch names] da tutti i ref (locali + remoti)
    const refMap = {}; // hash → [refname, ...]
    try {
      const refOut = await gitExec(repo.path, [
        'for-each-ref',
        '--format=%(objectname) %(refname:short)',
        'refs/heads/', 'refs/remotes/',
      ], { allowFail: true });
      refOut.out.split('\n').filter(Boolean).forEach(line => {
        const sp = line.indexOf(' ');
        const hash = line.slice(0, sp).trim();
        const name = line.slice(sp + 1).trim();
        if (!refMap[hash]) refMap[hash] = [];
        refMap[hash].push(name);
      });
    } catch (_) {}

    const r = await gitExec(repo.path, [
      'log', '--all',
      `--pretty=format:%H%x01%h%x01%P%x01%s%x01%an%x01%ar%x01%d`,
      `-${limit}`,
    ], { allowFail: true });

    const rawLines = r.out.split('\n').filter(Boolean);
    const entries = rawLines.map(line => {
      const parts = line.split('\x01');
      const [hash, short, parents, subject, author, relDate, refs] = parts;
      // refs dal %d (branch tip nel range) + refs da for-each-ref (branch tip fuori range)
      const refsFromLog = refs ? refs.trim().replace(/[()]/g, '').split(', ').filter(Boolean) : [];
      const refsFromMap = (refMap[hash] || []).filter(n => !refsFromLog.some(r => r === n || r.endsWith(n)));
      return {
        hash,
        short,
        parents: parents ? parents.trim().split(' ').filter(Boolean) : [],
        subject,
        author,
        relDate,
        refs: [...refsFromLog, ...refsFromMap],
      };
    });
    // Passa anche la mappa completa refs: il frontend la usa per nominare le lane
    // anche quando il tip del branch non è nei commit visualizzati
    res.json({ entries, refs: refMap });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Messaggio completo di un commit (subject + body)
app.get('/api/git/repos/:id/commit/:hash', async (req, res) => {
  const repos = getGitRepos();
  const repo  = repos.find(r => r.id === req.params.id);
  if (!repo) return res.status(404).json({ error: 'Repo non trovato' });
  if (!isValidCommitHash(req.params.hash)) return res.status(400).json({ error: 'Hash non valido' });
  try {
    const r = await gitExec(repo.path, [
      'show', '--no-patch', '--format=%B', req.params.hash, '--',
    ], { allowFail: true });
    res.json({ body: r.out.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Azione git (commit, pull, push, merge) — SSE streaming
app.post('/api/git/repos/:id/action', async (req, res) => {
  const repos = getGitRepos();
  const repo  = repos.find(r => r.id === req.params.id);
  if (!repo) { res.status(404).json({ error: 'Repo non trovato' }); return; }

  const { action, message, branch, remote = 'origin', files = [] } = req.body;

  // Validazione prima di aprire lo stream SSE, così l'errore arriva come JSON 400
  const invalid = await validateGitAction(repo.path, { action, branch, remote, message });
  if (invalid) { res.status(400).json({ error: invalid }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, data })}\n\n`); } catch {} };

  let args;
  if (action === 'commit') {
    // Solo file presenti in git status: un nome arbitrario potrebbe essere
    // un'opzione di git add o un path fuori dalle modifiche mostrate
    if (!Array.isArray(files)) { send('error', 'Lista file non valida'); res.end(); return; }
    const { files: changed } = await getGitStatus(repo.path);
    const known = new Set(changed.map(f => f.name));
    const unknown = files.filter(f => !known.has(f));
    if (unknown.length) { send('error', `File non presenti tra le modifiche: ${unknown.join(', ')}`); res.end(); return; }
    // Prima stage i file, poi commit
    const stageArgs = files.length ? ['add', '-A', '--', ...files] : ['add', '-A'];
    const proc1 = spawn('git', stageArgs, { cwd: repo.path, env: { ...process.env } });
    let stageErr = '';
    proc1.stderr.on('data', d => stageErr += d.toString());
    proc1.on('close', code => {
      if (code !== 0) { send('error', stageErr || 'git add fallito'); res.end(); return; }
      send('stdout', `$ git ${stageArgs.join(' ')}\n`);
      const proc2 = spawn('git', ['commit', '-m', message || 'Update'], { cwd: repo.path, env: { ...process.env } });
      proc2.stdout.on('data', d => send('stdout', d.toString()));
      proc2.stderr.on('data', d => send('stderr', d.toString()));
      proc2.on('close', c2 => { send('exit', c2); res.end(); });
      proc2.on('error', e => { send('error', e.message); res.end(); });
    });
    return;
  } else if (action === 'pull') {
    args = ['pull', remote, branch || '--rebase=false'].filter(Boolean);
  } else if (action === 'push') {
    // Fetch silenzioso per aggiornare i remote-tracking refs prima del push.
    // Questo evita "cannot lock ref: is at X but expected Y" che si verifica
    // quando il tracking ref locale è stale rispetto al server remoto
    // (es. qualcuno ha pushato da console e i refs locali non sono aggiornati).
    send('stdout', `$ git fetch ${remote}\n`);
    const fetchProc = spawn('git', ['fetch', remote].filter(Boolean), {
      cwd: repo.path,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    let fetchStderr = '';
    fetchProc.stderr.on('data', d => { fetchStderr += d.toString(); });
    fetchProc.on('close', fetchCode => {
      if (fetchCode !== 0) {
        send('stdout', `[fetch warning: ${fetchStderr.trim()}]\n`);
      }
      // Dopo il fetch (o anche se il fetch ha fallito), esegui il push normale.
      // Ora i remote-tracking refs sono aggiornati e git invierà il corretto "expected" hash.
      const pArgs = ['push', remote, branch].filter(Boolean);
      send('stdout', `$ git ${pArgs.join(' ')}\n`);
      const p = spawn('git', pArgs, { cwd: repo.path, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      let pushStderr = '';
      p.stdout.on('data', d => send('stdout', d.toString()));
      p.stderr.on('data', d => { pushStderr += d.toString(); send('stderr', d.toString()); });
      p.on('close', c => { send('exit', c); res.end(); });
      p.on('error', e => { send('error', e.message); res.end(); });
    });
    fetchProc.on('error', e => {
      // Fetch non disponibile: prova il push comunque
      send('stdout', `[fetch error: ${e.message}]\n`);
      const pArgs = ['push', remote, branch].filter(Boolean);
      send('stdout', `$ git ${pArgs.join(' ')}\n`);
      const p = spawn('git', pArgs, { cwd: repo.path, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      p.stdout.on('data', d => send('stdout', d.toString()));
      p.stderr.on('data', d => send('stderr', d.toString()));
      p.on('close', c => { send('exit', c); res.end(); });
      p.on('error', e2 => { send('error', e2.message); res.end(); });
    });
    return;
  } else if (action === 'push_force') {
    args = ['push', '--force-with-lease', remote, branch].filter(Boolean);
  } else if (action === 'pull_push') {
    // pull poi push — il pull aggiorna già i remote-tracking refs,
    // quindi il push successivo avrà gli hash corretti
    const pullArgs = ['pull', remote, branch].filter(Boolean);
    send('stdout', `$ git ${pullArgs.join(' ')}\n`);
    const proc1 = spawn('git', pullArgs, { cwd: repo.path, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    proc1.stdout.on('data', d => send('stdout', d.toString()));
    proc1.stderr.on('data', d => send('stderr', d.toString()));
    proc1.on('close', code => {
      if (code !== 0) { send('exit', code); res.end(); return; }
      const pushArgs = ['push', remote, branch].filter(Boolean);
      send('stdout', `\n$ git ${pushArgs.join(' ')}\n`);
      const proc2 = spawn('git', pushArgs, { cwd: repo.path, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      proc2.stdout.on('data', d => send('stdout', d.toString()));
      proc2.stderr.on('data', d => send('stderr', d.toString()));
      proc2.on('close', c2 => { send('exit', c2); res.end(); });
      proc2.on('error', e => { send('error', e.message); res.end(); });
    });
    proc1.on('error', e => { send('error', e.message); res.end(); });
    return;
  } else if (action === 'merge') {
    args = ['merge', branch].filter(Boolean);
  } else if (action === 'fetch') {
    args = ['fetch', '--all', '--prune'];
  } else if (action === 'checkout') {
    args = ['checkout', branch, '--'];
  } else if (action === 'stash') {
    args = ['stash'];
  } else if (action === 'stash_pop') {
    args = ['stash', 'pop'];
  } else {
    send('error', 'Azione non supportata'); res.end(); return;
  }

  send('stdout', `$ git ${args.join(' ')}\n`);
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const proc = spawn('git', args, { cwd: repo.path, env: gitEnv });
  proc.stdout.on('data', d => send('stdout', d.toString()));
  proc.stderr.on('data', d => send('stderr', d.toString()));
  proc.on('close', code => { send('exit', code); res.end(); });
  proc.on('error', e => { send('error', e.message); res.end(); });
});

// ============================================================================
// SHUTDOWN + LISTEN
// ============================================================================

// Errori non gestiti nelle route: le validazioni della config diventano 400 JSON
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof ConfigError) return res.status(400).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON non valido' });
  console.error(err);
  res.status(500).json({ error: err.message || 'Errore interno' });
});

function shutdown(signal) {
  console.log(`\n${signal} — termino tunnel e processi npm...`);
  for (const [, t] of activeTunnels) {
    t.stopping = true;
    if (t.reconnectTimer) clearTimeout(t.reconnectTimer);
    try { t.process && t.process.kill('SIGTERM'); } catch {}
  }
  for (const [, pd] of activeProcesses) {
    killProcessGroup(pd);
  }
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP',  () => shutdown('SIGHUP')); // chiusura del terminale

app.listen(PORT, '127.0.0.1', () => {
  console.log(`DevDock → http://127.0.0.1:${PORT}`);
  console.log(`Config: ${CONFIG_PATH}`);
});
