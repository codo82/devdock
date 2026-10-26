// config.json: lettura, validazione e scrittura per sezioni.
// Ogni chiave di primo livello è una "sezione" con un proprietario (il core o
// un'estensione), che ne definisce validazione, normalizzazione e merge in import.
const fs = require('fs');
const { CONFIG_PATH } = require('./env');
const { ConfigError, coreError } = require('./errors');

// ---- Registro delle sezioni ----

// key → { owner, empty, idField, validate(value, cfg), normalize(value), merge(current, incoming), local }
// local: dati di questo computer (percorsi…), mai esportati
const sections = new Map();

// Registra (o riassegna) una sezione. I campi non indicati restano quelli già
// registrati: un'estensione che prende una sezione del core ne eredita le regole.
function registerSection(key, spec) {
  sections.set(key, { ...(sections.get(key) || {}), ...spec });
}

// Sezione non più gestita (estensione scaricata): i dati restano in config.json
function unregisterSection(key) { sections.delete(key); }

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
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw coreError.config('config_invalid');
  for (const [key, s] of sections) {
    if (!s.validate || cfg[key] === undefined) continue;
    try { s.validate(cfg[key], cfg); }
    catch (e) { throw e instanceof ConfigError ? e : coreError.config('section_invalid', { section: key, error: e.message }); }
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
  const exportable = k => cfg[k] !== undefined && !sections.get(k)?.local;
  return Object.fromEntries((keys || Object.keys(cfg)).filter(exportable).map(k => [k, cfg[k]]));
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
  if (mode !== 'replace' && mode !== 'merge') throw coreError.config('import_mode');
  if (!isPlainObject(incoming)) throw coreError.config('config_invalid');
  const keys = Object.keys(incoming).filter(k => sections.has(k));
  const ignored = Object.keys(incoming).filter(k => !sections.has(k));
  if (!keys.length) throw coreError.config('import_no_sections');

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

// Solo i campi noti: nessuna proprietà arbitraria finisce in config.json
const pick = (obj, fields) => Object.fromEntries(fields.filter(f => obj[f] !== undefined).map(f => [f, obj[f]]));

module.exports = {
  ConfigError,
  registerSection, unregisterSection, getSection, listSections,
  loadConfig, saveConfig, validateConfig, exportConfig, importConfig,
  pick,
};
