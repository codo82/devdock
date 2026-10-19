// config.json: lettura, validazione e scrittura per sezioni.
// Ogni chiave di primo livello è una "sezione" con un proprietario (il core o
// un'estensione), che ne definisce validazione, normalizzazione e merge in import.
const fs = require('fs');
const path = require('path');
const { CONFIG_PATH } = require('./env');
const { KEY_RE, COLOR_RE, REMOTE_RE, ALIAS_RE, isPort, isText } = require('./validate');

class ConfigError extends Error {}

// ---- Registro delle sezioni ----

// key → { owner, empty, idField, validate(value, cfg), normalize(value), merge(current, incoming) }
const sections = new Map();

// Registra (o riassegna) una sezione. I campi non indicati restano quelli già
// registrati: un'estensione che prende una sezione del core ne eredita le regole.
function registerSection(key, spec) {
  sections.set(key, { ...(sections.get(key) || {}), ...spec });
}

const getSection = key => sections.get(key);
const listSections = () => [...sections.entries()].map(([key, s]) => ({ key, owner: s.owner }));

// ---- Lettura e scrittura ----

function emptyConfig() {
  const cfg = {};
  for (const [key, s] of sections) if (s.empty !== undefined) cfg[key] = structuredClone(s.empty);
  return cfg;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) writeFileAtomic(CONFIG_PATH, JSON.stringify(emptyConfig(), null, 2));
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  // Config create con versioni precedenti possono non avere tutte le sezioni
  for (const [key, s] of sections) {
    if (s.empty !== undefined && (cfg[key] === undefined || typeof cfg[key] !== typeof s.empty)) cfg[key] = structuredClone(s.empty);
  }
  return cfg;
}

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new ConfigError('Config non valida');
  for (const [key, s] of sections) {
    if (!s.validate || cfg[key] === undefined) continue;
    try { s.validate(cfg[key], cfg); }
    catch (e) { throw e instanceof ConfigError ? e : new ConfigError(`${key}: ${e.message}`); }
  }
}

// Scrittura atomica: un crash a metà non lascia un config.json troncato
function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function saveConfig(cfg) {
  validateConfig(cfg);
  writeFileAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ---- Export / import per sezioni ----

// keys: sezioni da esportare (default: tutta la config)
function exportConfig(keys) {
  const cfg = loadConfig();
  if (!keys) return cfg;
  return Object.fromEntries(keys.filter(k => cfg[k] !== undefined).map(k => [k, cfg[k]]));
}

// Merge di default: liste con idField → si aggiungono gli elementi nuovi;
// oggetti → si aggiungono le chiavi nuove; altrimenti resta il valore attuale.
function defaultMerge(current, incoming, idField) {
  if (Array.isArray(current) && Array.isArray(incoming) && idField) {
    const ids = new Set(current.map(x => x?.[idField]));
    return [...current, ...incoming.filter(x => !ids.has(x?.[idField]))];
  }
  if (isPlainObject(current) && isPlainObject(incoming)) return { ...incoming, ...current };
  return current === undefined ? incoming : current;
}

const isPlainObject = v => v && typeof v === 'object' && !Array.isArray(v);

// Applica le sezioni registrate presenti nel file:
//   replace → sostituiscono quelle attuali · merge → si aggiungono gli elementi nuovi
// Le sezioni assenti dal file restano invariate; le chiavi sconosciute sono ignorate.
function importConfig(incoming, mode) {
  if (mode !== 'replace' && mode !== 'merge') throw new ConfigError('Modalità di import non valida');
  if (!isPlainObject(incoming)) throw new ConfigError('Config non valida');
  const keys = Object.keys(incoming).filter(k => sections.has(k));
  const ignored = Object.keys(incoming).filter(k => !sections.has(k));
  if (!keys.length) throw new ConfigError('Il file non contiene sezioni riconosciute');

  const cfg = loadConfig();
  for (const key of keys) {
    const s = sections.get(key);
    const value = s.normalize ? s.normalize(incoming[key]) : incoming[key];
    if (mode === 'replace') cfg[key] = value;
    else cfg[key] = s.merge ? s.merge(cfg[key], value) : defaultMerge(cfg[key], value, s.idField);
  }
  saveConfig(cfg); // valida il risultato (es. gruppi che puntano a server mancanti)
  return { sections: keys, ignored };
}

// ---- Sezioni del core: tunnel (groups, servers) e progetti ----

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

function assertList(value, key) {
  if (!Array.isArray(value)) throw new ConfigError(`Config non valida: "${key}" deve essere una lista`);
}

function assertUnique(list, field, what) {
  const seen = new Set();
  for (const x of list) {
    if (seen.has(x[field])) throw new ConfigError(`${what} duplicato: ${x[field]}`);
    seen.add(x[field]);
  }
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

const normalizeList = fn => value => (Array.isArray(value) ? value.map(fn) : value);

registerSection('servers', {
  owner: 'core', empty: [], idField: 'key',
  normalize: normalizeList(normalizeServer),
  validate(list) {
    assertList(list, 'servers');
    list.forEach(validateServer);
    assertUnique(list, 'key', 'Server');
  },
});

registerSection('groups', {
  owner: 'core', empty: [], idField: 'key',
  normalize: normalizeList(g => pick(g || {}, GROUP_FIELDS)),
  validate(list, cfg) {
    assertList(list, 'groups');
    const serverKeys = new Set((cfg.servers || []).map(s => s.key));
    list.forEach(g => validateGroup(g, serverKeys));
    assertUnique(list, 'key', 'Gruppo');
  },
  // Gruppi già esistenti: si uniscono le liste di server
  merge(current, incoming) {
    const out = current.map(g => ({ ...g, servers: [...g.servers] }));
    for (const g of incoming) {
      const cur = out.find(x => x.key === g.key);
      if (!cur) out.push(g);
      else if (Array.isArray(g.servers)) g.servers.forEach(sk => { if (!cur.servers.includes(sk)) cur.servers.push(sk); });
    }
    return out;
  },
});

registerSection('projects', {
  owner: 'core', empty: [], idField: 'id',
  normalize: normalizeList(p => pick(p || {}, PROJECT_FIELDS)),
  validate(list) {
    assertList(list, 'projects');
    list.forEach(validateProject);
    assertUnique(list, 'id', 'Progetto');
  },
});

// ---- Accesso per le route esistenti ----

function getServerMap(cfg) {
  return Object.fromEntries(cfg.servers.map(s => [s.key, s]));
}

function getProjects() {
  return loadConfig().projects || [];
}

function saveProjects(projects) {
  const cfg = loadConfig();
  cfg.projects = projects;
  saveConfig(cfg);
}

module.exports = {
  ConfigError,
  registerSection, getSection, listSections,
  loadConfig, saveConfig, validateConfig, exportConfig, importConfig,
  pick, normalizeServer, SERVER_FIELDS, GROUP_FIELDS, PROJECT_FIELDS,
  getServerMap, getProjects, saveProjects,
};
