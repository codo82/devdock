// Cataloghi delle traduzioni: una lingua esiste quando esiste il suo file
// (public/core/i18n/<tag>.json, extensions/<code>/i18n/<tag>.json). Nessun elenco di
// lingue nel codice; l'italiano è la lingua sorgente (completa e ultimo fallback).
const fs = require('fs');
const path = require('path');

const SOURCE_LANG = 'it';
// Tag BCP 47 (forma semplificata): lingua + sottotag opzionali (pt-BR, zh-Hant, sr-Latn-RS)
const TAG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const KEY_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_-]+)*$/;
const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];
const DIRS = new Set(['ltr', 'rtl']);

class CatalogError extends Error {}

// Tag con un catalogo nella cartella (nomi file <tag>.json)
function catalogTags(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5))
    .filter(tag => TAG_RE.test(tag))
    .sort();
}

// Valida un catalogo: { _meta?, "<chiave>": "testo" | { one, other, … } }
// Restituisce { meta, entries } (entries senza _meta). metaRequired per i cataloghi del core.
function parseCatalog(data, { metaRequired = false, name = 'catalogo' } = {}) {
  const fail = msg => { throw new CatalogError(`${name}: ${msg}`); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('deve essere un oggetto JSON');
  const { _meta, ...entries } = data;
  if (_meta !== undefined || metaRequired) {
    if (!_meta || typeof _meta !== 'object') fail('"_meta" mancante');
    for (const k of ['name', 'nativeName']) {
      if (typeof _meta[k] !== 'string' || !_meta[k].trim()) fail(`"_meta.${k}" obbligatorio`);
    }
    if (_meta.dir !== undefined && !DIRS.has(_meta.dir)) fail('"_meta.dir" deve essere "ltr" o "rtl"');
  }
  for (const [key, value] of Object.entries(entries)) {
    if (!KEY_RE.test(key)) fail(`chiave non valida: "${key}"`);
    if (typeof value === 'string') continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`"${key}": il valore deve essere un testo o un oggetto di plurali`);
    const cats = Object.keys(value);
    const bad = cats.filter(c => !PLURAL_CATEGORIES.includes(c));
    if (bad.length) fail(`"${key}": categorie di plurale non valide: ${bad.join(', ')}`);
    if (typeof value.other !== 'string') fail(`"${key}": il plurale deve avere "other"`);
    if (cats.some(c => typeof value[c] !== 'string')) fail(`"${key}": ogni forma del plurale deve essere un testo`);
  }
  return { meta: _meta ? { dir: 'ltr', ...(_meta) } : null, entries };
}

function readCatalog(file, opts = {}) {
  return parseCatalog(JSON.parse(fs.readFileSync(file, 'utf8')), { name: path.basename(file), ...opts });
}

// Lingue disponibili (dai cataloghi del core) con la completezza rispetto alla lingua
// sorgente, contando insieme core ed estensioni. extCatalogs: [{ code, dir }] (cartelle i18n).
function languages(coreDir, extCatalogs = []) {
  const load = (dir, tag, opts) => {
    try { return readCatalog(path.join(dir, `${tag}.json`), opts); } catch { return null; }
  };
  const keysOf = tag => {
    const keys = new Set(Object.keys(load(coreDir, tag)?.entries || {}));
    for (const { code, dir } of extCatalogs) {
      for (const k of Object.keys(load(dir, tag)?.entries || {})) keys.add(`${code}.${k}`);
    }
    return keys;
  };
  const source = keysOf(SOURCE_LANG);
  return catalogTags(coreDir).flatMap(tag => {
    const cat = load(coreDir, tag, { metaRequired: true });
    if (!cat) return [];
    const keys = tag === SOURCE_LANG ? source : keysOf(tag);
    const done = [...source].filter(k => keys.has(k)).length;
    return [{
      tag,
      name: cat.meta.name,
      nativeName: cat.meta.nativeName,
      dir: cat.meta.dir,
      completeness: source.size ? Math.floor((done / source.size) * 100) : 100,
    }];
  });
}

// Valore di un campo del manifest traducibile: testo semplice o { "<tag>": "testo" }
function isLocalizedText(v) {
  if (typeof v === 'string') return !!v.trim();
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length > 0
    && Object.entries(v).every(([tag, s]) => TAG_RE.test(tag) && typeof s === 'string' && s.trim());
}

// Testo nella lingua sorgente (per log e messaggi del server)
function sourceText(v) {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object') return '';
  return v[SOURCE_LANG] ?? Object.values(v)[0] ?? '';
}

module.exports = {
  SOURCE_LANG, TAG_RE, KEY_RE, PLURAL_CATEGORIES, CatalogError,
  catalogTags, parseCatalog, readCatalog, languages, isLocalizedText, sourceText,
};
