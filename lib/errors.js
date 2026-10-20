// Errori delle API con codice traducibile. Risposta:
//   { error: "<messaggio nella lingua sorgente>", code: "<ns>.<nome>", params?: { … }, …extra }
// Il messaggio viene dal catalogo della lingua sorgente (chiave "<ns>.errors.<nome>"),
// così il server non contiene le frasi e resta indipendente dalla lingua dell'utente:
// il frontend traduce `code` con i suoi cataloghi e usa `error` come ripiego.
const path = require('path');
const { ROOT } = require('./env');
const { SOURCE_LANG, readCatalog } = require('./i18n');

// Configurazione non valida (400). code/params opzionali come per ApiError
class ConfigError extends Error {}

class ApiError extends Error {
  constructor(status, code, params = {}, extra = {}, message = code) {
    super(message);
    this.status = status;
    this.code = code;
    this.params = params;
    this.extra = extra;
  }
}

// Cataloghi della lingua sorgente: file → voci (letti una volta)
const catalogs = new Map();
function sourceEntries(file) {
  if (!catalogs.has(file)) {
    try { catalogs.set(file, readCatalog(file).entries); } catch { catalogs.set(file, {}); }
  }
  return catalogs.get(file);
}

const plural = new Intl.PluralRules(SOURCE_LANG);

// Testo del catalogo con {param} e plurali su params.count (come t() nel browser)
function format(template, params = {}) {
  let text = template;
  if (text && typeof text === 'object') {
    const n = Number(params.count);
    text = text[Number.isFinite(n) ? plural.select(n) : 'other'] ?? text.other;
  }
  return String(text).replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

// Fabbrica di errori per un namespace: ns = "core" o il codice di un'estensione;
// file = catalogo della lingua sorgente; keyPrefix = prefisso delle chiavi nel file
// ("core.errors." nel core, "errors." nelle estensioni, che non scrivono il namespace)
function errorFactory(ns, file, keyPrefix = 'errors.') {
  const message = (name, params) => {
    const template = sourceEntries(file)[keyPrefix + name];
    return template === undefined ? `${ns}.${name}` : format(template, params);
  };
  // error(404, 'not_found', { id }) → ApiError; extra: campi aggiunti alla risposta (es. files)
  const error = (status, name, params = {}, extra = {}) =>
    new ApiError(status, `${ns}.${name}`, params, extra, message(name, params));
  // Errore di validazione della configurazione (400), con lo stesso codice
  error.config = (name, params = {}) =>
    Object.assign(new ConfigError(message(name, params)), { code: `${ns}.${name}`, params });
  error.message = message;
  // Risposta immediata, per i punti dove non si può lanciare (callback, eventi)
  error.send = (res, status, name, params = {}, extra = {}) => res.status(status).json(errorBody(error(status, name, params, extra)));
  return error;
}

const coreError = errorFactory('core', path.join(ROOT, 'public/core/i18n', `${SOURCE_LANG}.json`), 'core.errors.');

// Corpo JSON della risposta per un errore con codice
function errorBody(err) {
  const body = { error: err.message };
  if (err.code) body.code = err.code;
  if (err.params && Object.keys(err.params).length) body.params = err.params;
  return { ...body, ...(err.extra || {}) };
}

module.exports = { ApiError, ConfigError, errorFactory, coreError, errorBody, format };
