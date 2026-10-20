// Controlli sui cataloghi delle traduzioni, usati dai test (tests/i18n-catalogs.test.js)
// e dal report (npm run i18n:report). Nessuna dipendenza dal server in esecuzione.
const fs = require('fs');
const path = require('path');
const { SOURCE_LANG, catalogTags, readCatalog } = require('./i18n');

const ROOT = path.join(__dirname, '..');

// Insiemi di cataloghi: il core e ogni estensione con una cartella i18n
// { scope, dir, prefix (namespace delle chiavi nel codice), files (sorgenti da analizzare) }
function catalogSets(root = ROOT) {
  const sets = [{
    scope: 'core', dir: path.join(root, 'public/core/i18n'), prefix: '', metaRequired: true,
    // frontend del core e backend (errori del core: security, config, error handler)
    files: ['public/index.html', 'server.js', 'routes/core.js',
      ...fs.readdirSync(path.join(root, 'public/core')).filter(f => f.endsWith('.js')).map(f => `public/core/${f}`),
      ...fs.readdirSync(path.join(root, 'lib')).filter(f => f.endsWith('.js')).map(f => `lib/${f}`)]
      .map(f => path.join(root, f)),
  }];
  const extDir = path.join(root, 'extensions');
  for (const code of fs.readdirSync(extDir).sort()) {
    const dir = path.join(extDir, code);
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, 'setting.json'))) continue;
    sets.push({
      scope: code, dir: path.join(dir, 'i18n'), prefix: `${code}.`, metaRequired: false,
      files: fs.readdirSync(dir).filter(f => /\.(js|html)$/.test(f)).map(f => path.join(dir, f)),
    });
  }
  return sets;
}

const placeholders = value => {
  const texts = typeof value === 'string' ? [value] : Object.values(value);
  return new Set(texts.flatMap(t => [...t.matchAll(/\{(\w+)\}/g)].map(m => m[1])));
};

// Problemi di un insieme: catalogo sorgente mancante o non valido, cataloghi non validi,
// chiavi assenti dalla sorgente (obsolete), segnaposto diversi dalla sorgente
function checkSet(set) {
  const problems = [];
  const tags = catalogTags(set.dir);
  if (!tags.includes(SOURCE_LANG)) return { problems: [`${set.scope}: manca ${SOURCE_LANG}.json`], source: {}, catalogs: {} };
  const catalogs = {};
  for (const tag of tags) {
    try { catalogs[tag] = readCatalog(path.join(set.dir, `${tag}.json`), { metaRequired: set.metaRequired }).entries; }
    catch (e) { problems.push(`${set.scope}/${tag}: ${e.message}`); }
  }
  const source = catalogs[SOURCE_LANG] || {};
  for (const [tag, entries] of Object.entries(catalogs)) {
    if (tag === SOURCE_LANG) continue;
    for (const [key, value] of Object.entries(entries)) {
      if (!(key in source)) { problems.push(`${set.scope}/${tag}: chiave obsoleta "${key}"`); continue; }
      const want = placeholders(source[key]), got = placeholders(value);
      // una forma singolare può omettere {count} ("un file"), ma non usarne di sconosciuti
      const extra = [...got].filter(p => !want.has(p));
      const missing = typeof value === 'string' ? [...want].filter(p => !got.has(p)) : [];
      if (extra.length || missing.length) problems.push(`${set.scope}/${tag}: "${key}" segnaposto diversi dalla sorgente (${[...extra, ...missing].join(', ')})`);
    }
  }
  return { problems, source, catalogs };
}

// Chiavi usate nel codice: t('…'), data-i18n…="…", errori del server (ctx.error, notice, sysLog).
// Le chiavi composte a runtime (template con ${…}) non sono analizzabili e vengono saltate.
function usedKeys(set) {
  const keys = new Set();
  const add = (key, absolute) => keys.add(absolute || key.startsWith('core.') ? key : set.prefix + key);
  for (const file of set.files) {
    // senza i commenti di riga (contengono esempi di chiavi)
    const text = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    for (const m of text.matchAll(/\bt\(\s*'([A-Za-z0-9_.-]+)'/g)) add(m[1]);
    for (const m of text.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([A-Za-z0-9_.-]+)"/g)) add(m[1]);
    const err = name => add(set.scope === 'core' ? `core.errors.${name}` : `errors.${name}`, set.scope === 'core');
    for (const m of text.matchAll(/(?:ctx\.error|coreError)(?:\.config|\.send|\.message)?\(\s*(?:res,\s*)?(?:\d+,\s*)?'([a-z0-9_]+)'/g)) err(m[1]);
    for (const m of text.matchAll(/\b(?:notice|sysLog|reject\(res,\s*\d+,)\s*\(?\s*'([a-z0-9_]+)'/g)) err(m[1]);
  }
  return keys;
}

// Report di completezza: per insieme e lingua, % delle chiavi sorgente tradotte e chiavi mancanti
function report(root = ROOT) {
  const sets = catalogSets(root);
  const languages = new Set();
  const rows = sets.map(set => {
    const { problems, source, catalogs } = checkSet(set);
    Object.keys(catalogs).forEach(t => languages.add(t));
    const keys = Object.keys(source);
    const byLang = {};
    for (const [tag, entries] of Object.entries(catalogs)) {
      const missing = keys.filter(k => !(k in entries));
      byLang[tag] = { total: keys.length, done: keys.length - missing.length, missing };
    }
    return { scope: set.scope, problems, byLang };
  });
  return { source: SOURCE_LANG, languages: [...languages].sort(), sets: rows };
}

module.exports = { ROOT, catalogSets, checkSet, usedKeys, placeholders, report };

// ---- testi dell'interfaccia scritti nel codice (M6.16) ----
// Euristica sulla lingua sorgente: un testo è sospetto se contiene una lettera accentata
// o una parola italiana comune. Comandi e nomi propri (Pull, Merge, PM2…) non la attivano.
const SOURCE_WORDS = new Set(`il lo gli le un una uno di da del della dei delle dal dalla con su per tra fra non che è
sono nessun nessuna nessuno questo questa tutti tutte già ancora seleziona carica elimina modifica salva annulla aggiungi
errore attiva chiudi cerca nuovo nuova righe riga cartella progetto progetti connessione connessioni chiave
nome valore valori porta tabella colonna colonne indice prova esegui aggiorna ricarica conferma`.split(/\s+/));

function suspicious(text) {
  let t = text;
  while (/\$\{[^{}]*\}/.test(t)) t = t.replace(/\$\{[^{}]*\}/g, ' ');
  if (!/[A-Za-zÀ-ú]{2}/.test(t)) return false;
  if (/[àèéìòù]/i.test(t)) return true;
  return t.toLowerCase().split(/[^a-zà-ù_-]+/).some(w => SOURCE_WORDS.has(w)); // gli-dot, del-col: classi CSS
}

// Testi letterali di un file, riga per riga: stringhe JS ('…', "…", `…` sulla stessa riga),
// testo tra tag e attributi title/placeholder/aria-label. Commenti, console.* e import esclusi.
function literals(file, text) {
  let src = text.replace(/<!--[\s\S]*?-->/g, '');
  if (file.endsWith('.js')) src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  else src = src.replace(/<(script|style|code)[\s\S]*?<\/\1>/g, '');
  const out = [];
  for (const line of src.split('\n')) {
    if (/console\.(log|warn|error)|^\s*import /.test(line)) continue;
    if (file.endsWith('.js')) {
      for (const m of line.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
        const lit = m[1] ?? m[2] ?? m[3];
        // attributi HTML nei template (class="…", data-…="…"): title & co. sono presi sotto
        if (m[2] !== undefined && line[m.index - 1] === '=') continue;
        if (!/[<>]/.test(lit)) out.push(lit);
      }
    }
    for (const m of line.matchAll(/>([^<>]+)</g)) out.push(m[1]);
    for (const m of line.matchAll(/\s(?:title|placeholder|aria-label)="([^"]*)"/g)) out.push(m[1]);
  }
  return out.filter(s => s.trim());
}

// File del frontend da controllare: public/ (HTML e JS del core) e viste delle estensioni
function frontendFiles(root = ROOT) {
  const files = ['public/index.html',
    ...fs.readdirSync(path.join(root, 'public/core')).filter(f => f.endsWith('.js')).map(f => `public/core/${f}`)];
  for (const code of fs.readdirSync(path.join(root, 'extensions')).sort()) {
    const dir = path.join(root, 'extensions', code);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of ['view.js', 'view.html', 'sidebar.html']) if (fs.existsSync(path.join(dir, f))) files.push(`extensions/${code}/${f}`);
  }
  return files;
}

// [{ file, text }] dei testi sospetti non presenti nell'allowlist ("file: testo" per riga)
function hardcodedTexts(root = ROOT, allowFile = path.join(root, 'tests/i18n-allowlist.txt')) {
  const allow = fs.existsSync(allowFile)
    ? fs.readFileSync(allowFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    : [];
  const found = [];
  for (const file of frontendFiles(root)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const lit of literals(file, text)) {
      if (!suspicious(lit)) continue;
      if (allow.some(a => { const i = a.indexOf(': '); return a.slice(0, i) === file && lit.includes(a.slice(i + 2)); })) continue;
      found.push({ file, text: lit.trim().slice(0, 120) });
    }
  }
  return found;
}

module.exports.hardcodedTexts = hardcodedTexts;
module.exports.suspicious = suspicious;
