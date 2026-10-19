// config.json: lettura, validazione e scrittura
const fs = require('fs');
const path = require('path');
const { CONFIG_PATH } = require('./env');
const { KEY_RE, COLOR_RE, REMOTE_RE, ALIAS_RE, isPort, isText } = require('./validate');

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

class ConfigError extends Error {}

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

module.exports = {
  EMPTY_CONFIG, ConfigError,
  loadConfig, saveConfig, validateConfig,
  pick, normalizeServer, SERVER_FIELDS, GROUP_FIELDS, PROJECT_FIELDS,
  getServerMap, getProjects, saveProjects,
};
