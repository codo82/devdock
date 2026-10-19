// config.json: lettura, validazione e scrittura per sezioni.
// Ogni chiave di primo livello è una "sezione" con un proprietario (il core o
// un'estensione), che ne definisce validazione, normalizzazione e merge in import.
const fs = require('fs');
const path = require('path');
const { CONFIG_PATH } = require('./env');
const { KEY_RE, isText } = require('./validate');

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

// ---- Sezione del core: progetti (passerà all'estensione npm) ----

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
const PROJECT_FIELDS = ['id', 'label', 'path'];

const normalizeList = fn => value => (Array.isArray(value) ? value.map(fn) : value);

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
  pick, PROJECT_FIELDS, getProjects, saveProjects,
};
