// Loader delle estensioni: legge extensions/*/setting.json, risolve le dipendenze,
// crea i backend in ordine topologico e monta le route dichiarate nel manifest
// su /api/ext/<code>. Contratto completo in docs/EXTENSIONS.md.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { loadConfig, saveConfig, registerSection } = require('./config');
const { openSse } = require('./sse');
const { SOURCE_LANG, catalogTags, readCatalog, isLocalizedText } = require('./i18n');
const { errorFactory } = require('./errors');
const semver = require('./semver');

// Versione del core contro cui si controlla il campo "devdock" dei manifest
const CORE_VERSION = require('../package.json').version;

const CODE_RE     = /^[a-z0-9][a-z0-9-]{0,39}$/;
const COLOR_RE    = /^#[0-9a-f]{6}$/i;
const FILE_RE     = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/; // relativo, senza ".."
const CONFIG_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const METHODS     = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const POSITIONS   = new Set(['tab', 'header']);

class ManifestError extends Error {}

const isFile = f => typeof f === 'string' && FILE_RE.test(f) && !f.split('/').includes('..');

// Controlla un setting.json e restituisce il manifest normalizzato
function validateManifest(m, folder) {
  const fail = msg => { throw new ManifestError(`${folder}/setting.json: ${msg}`); };
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('deve essere un oggetto JSON');
  // name, description ed export[].label: testo o mappa per lingua ({ "it": "…", "en": "…" })
  if (!isLocalizedText(m.name)) fail('"name" obbligatorio (testo o mappa per lingua)');
  if (m.description != null && !isLocalizedText(m.description)) fail('"description" deve essere un testo o una mappa per lingua');
  if (!CODE_RE.test(m.code || '')) fail('"code" non valido (minuscole, numeri e -)');
  if (m.code === 'core') fail('"core" è riservato (namespace delle traduzioni del core)');
  if (m.code !== folder) fail(`"code" (${m.code}) deve coincidere con il nome della cartella`);
  if (!COLOR_RE.test(m.color || '')) fail('"color" deve essere #rrggbb');
  if (!POSITIONS.has(m.position)) fail('"position" deve essere "tab" o "header"');
  if (m.order != null && !Number.isFinite(m.order)) fail('"order" deve essere un numero');
  // contratto versionato: versione dell'estensione e versioni del core con cui funziona
  if (!semver.valid(m.version)) fail('"version" obbligatoria, in formato SemVer (es. 1.0.0)');
  if (!semver.validRange(m.devdock)) fail('"devdock" obbligatorio: le versioni di DevDock compatibili, es. "^2.0"');

  const deps = m.dependencies ?? [];
  if (!Array.isArray(deps)) fail('"dependencies" deve essere una lista');
  for (const d of deps) {
    if (!d || !CODE_RE.test(d.code || '')) fail('dipendenza senza "code" valido');
    if (typeof d.required !== 'boolean') fail(`dipendenza "${d.code}": "required" deve essere true o false`);
    if (d.code === m.code) fail('un\'estensione non può dipendere da sé stessa');
  }

  const config = m.config ?? [];
  if (!Array.isArray(config) || !config.every(k => CONFIG_KEY_RE.test(k))) fail('"config" deve essere una lista di chiavi');

  if (m.backend != null) {
    const b = m.backend;
    if (!isFile(b.module)) fail('"backend.module" deve essere un file nella cartella');
    const routes = b.routes ?? [];
    if (!Array.isArray(routes)) fail('"backend.routes" deve essere una lista');
    const seen = new Set();
    for (const r of routes) {
      if (!METHODS.has(r?.method)) fail(`route con metodo non valido: ${r?.method}`);
      if (typeof r.path !== 'string' || !r.path.startsWith('/')) fail(`route ${r.method}: "path" deve iniziare con /`);
      if (typeof r.handler !== 'string' || !r.handler) fail(`route ${r.method} ${r.path}: "handler" obbligatorio`);
      const id = `${r.method} ${r.path}`;
      if (seen.has(id)) fail(`route duplicata: ${id}`);
      seen.add(id);
    }
  }

  if (m.frontend != null) {
    for (const k of ['html', 'sidebar', 'js', 'css']) {
      if (m.frontend[k] != null && !isFile(m.frontend[k])) fail(`"frontend.${k}" deve essere un file nella cartella`);
    }
  }

  // Caselle del dialog di export/import: ognuna include alcune sezioni di config dell'estensione
  const exportsList = m.export ?? [];
  if (!Array.isArray(exportsList)) fail('"export" deve essere una lista');
  const exportIds = new Set();
  for (const x of exportsList) {
    if (!x || !CODE_RE.test(x.id || '')) fail('voce di "export" senza "id" valido (minuscole, numeri e -)');
    if (exportIds.has(x.id)) fail(`export "${x.id}" duplicato`);
    exportIds.add(x.id);
    if (!isLocalizedText(x.label)) fail(`export "${x.id}": "label" obbligatoria (testo o mappa per lingua)`);
    if (x.description != null && !isLocalizedText(x.description)) fail(`export "${x.id}": "description" deve essere un testo o una mappa per lingua`);
    if (!Array.isArray(x.sections) || !x.sections.length) fail(`export "${x.id}": "sections" deve essere una lista non vuota`);
    const foreign = x.sections.filter(k => !config.includes(k));
    if (foreign.length) fail(`export "${x.id}": sezioni non dichiarate in "config": ${foreign.join(', ')}`);
  }

  // Strumenti MCP: ognuno ha un handler in instance.mcp del backend
  const mcp = m.mcp ?? {};
  if (typeof mcp !== 'object' || Array.isArray(mcp)) fail('"mcp" deve essere un oggetto');
  const tools = mcp.tools ?? [];
  if (!Array.isArray(tools)) fail('"mcp.tools" deve essere una lista');
  const toolNames = new Set();
  for (const tool of tools) {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(tool?.name || '')) fail(`strumento MCP senza "name" valido (minuscole, numeri e _)`);
    if (toolNames.has(tool.name)) fail(`strumento MCP "${tool.name}" duplicato`);
    toolNames.add(tool.name);
    if (typeof tool.description !== 'string' || !tool.description.trim()) fail(`strumento MCP "${tool.name}": "description" obbligatoria`);
    if (typeof tool.handler !== 'string' || !tool.handler) fail(`strumento MCP "${tool.name}": "handler" obbligatorio`);
    const schema = tool.inputSchema ?? { type: 'object', properties: {} };
    if (!schema || schema.type !== 'object') fail(`strumento MCP "${tool.name}": "inputSchema" deve essere uno schema JSON di tipo object`);
    if (typeof (tool.readOnly ?? true) !== 'boolean') fail(`strumento MCP "${tool.name}": "readOnly" deve essere true o false`);
  }
  if (tools.length && !m.backend) fail('"mcp.tools" richiede un backend');

  return { order: 100, dependencies: deps, config, ...m, export: exportsList, mcp: { tools } };
}

// Ordine topologico (dipendenze prima). Le estensioni in un ciclo restano fuori.
function topoSort(exts) {
  const byCode = new Map(exts.map(e => [e.manifest.code, e]));
  const state = new Map(); // code → 'visiting' | 'done'
  const order = [];
  const cyclic = new Set();
  const visit = (e, stack) => {
    const code = e.manifest.code;
    if (state.get(code) === 'done') return;
    if (state.get(code) === 'visiting') {
      stack.slice(stack.indexOf(code)).forEach(c => cyclic.add(c));
      return;
    }
    state.set(code, 'visiting');
    for (const d of e.manifest.dependencies) {
      const dep = byCode.get(d.code);
      if (dep) visit(dep, [...stack, code]);
    }
    state.set(code, 'done');
    order.push(e);
  };
  [...exts].sort((a, b) => a.manifest.code.localeCompare(b.manifest.code)).forEach(e => visit(e, []));
  return { order: order.filter(e => !cyclic.has(e.manifest.code)), cyclic };
}

// Cataloghi validi in <estensione>/i18n; quelli non validi vengono ignorati con un avviso
function extensionLanguages(ext) {
  const dir = path.join(ext.dir, 'i18n');
  return catalogTags(dir).filter(tag => {
    try { readCatalog(path.join(dir, `${tag}.json`)); return true; }
    catch (e) { ext.warnings.push(`catalogo i18n/${tag}.json ignorato: ${e.message}`); return false; }
  });
}

// Carica tutte le estensioni di dir. Restituisce { router, extensions, list(), shutdown() }
function loadExtensions(dir, { lib = {}, projects = null, log = console } = {}) {
  const router = express.Router();
  const extensions = [];

  // ---- scoperta e validazione dei manifest ----
  const folders = fs.existsSync(dir)
    // cartelle o link a cartelle (estensioni sviluppate altrove)
    ? fs.readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory() || (d.isSymbolicLink() && fs.statSync(path.join(dir, d.name), { throwIfNoEntry: false })?.isDirectory()))
        .map(d => d.name).sort()
    : [];
  for (const folder of folders) {
    const file = path.join(dir, folder, 'setting.json');
    if (!fs.existsSync(file)) continue;
    const ext = { dir: path.join(dir, folder), i18n: [], manifest: null, state: 'ok', warnings: [], error: null, services: null, instance: null };
    try {
      ext.manifest = validateManifest(JSON.parse(fs.readFileSync(file, 'utf8')), folder);
      // incompatibile: resta in lista con i dati del manifest (versione richiesta), ma non si carica
      if (!semver.satisfies(CORE_VERSION, ext.manifest.devdock)) {
        ext.state = 'disabled';
        ext.incompatible = true;
        ext.error = `${folder}/setting.json: richiede DevDock ${ext.manifest.devdock}, questa è la ${CORE_VERSION}`;
      } else ext.i18n = extensionLanguages(ext);
    } catch (e) {
      ext.manifest = { code: folder, name: folder, dependencies: [], config: [] };
      ext.state = 'disabled';
      ext.error = e instanceof ManifestError ? e.message : `${folder}/setting.json: ${e.message}`;
    }
    extensions.push(ext);
  }

  const byCode = new Map(extensions.map(e => [e.manifest.code, e]));

  // Una chiave di config.json appartiene a una sola estensione
  const configOwner = new Map();
  for (const e of extensions.filter(x => x.state !== 'disabled')) {
    for (const key of e.manifest.config) {
      if (configOwner.has(key)) {
        e.state = 'disabled';
        e.error = `chiave di config "${key}" già usata da "${configOwner.get(key)}"`;
      } else configOwner.set(key, e.manifest.code);
    }
  }

  // ---- ordine e dipendenze ----
  const { order, cyclic } = topoSort(extensions.filter(e => e.state !== 'disabled'));
  for (const code of cyclic) {
    const e = byCode.get(code);
    e.state = 'disabled';
    e.error = 'dipendenza circolare';
  }

  for (const ext of order) {
    const m = ext.manifest;
    for (const d of m.dependencies) {
      const dep = byCode.get(d.code);
      const usable = dep && dep.state !== 'disabled';
      if (!usable && d.required) {
        ext.state = 'disabled';
        ext.error = dep ? `dipendenza "${d.code}" non disponibile` : `dipendenza "${d.code}" mancante`;
        break;
      }
      if (!usable) ext.warnings.push(`dipendenza opzionale "${d.code}" non disponibile`);
    }
    if (ext.state === 'disabled') continue;
    if (ext.warnings.length) ext.state = 'warning';
    if (!m.backend) { claimConfig(ext, {}); continue; }

    // ---- creazione del backend ----
    try {
      const ctx = makeContext(ext, { byCode, lib, projects, log });
      const factory = require(path.join(ext.dir, m.backend.module));
      if (typeof factory !== 'function') throw new Error(`${m.backend.module} deve esportare una funzione (ctx) => { handlers }`);
      const instance = factory(ctx) || {};
      const handlers = instance.handlers || {};
      const missing = (m.backend.routes || []).filter(r => typeof handlers[r.handler] !== 'function').map(r => r.handler);
      if (missing.length) throw new Error(`handler non trovati: ${missing.join(', ')}`);
      const used = new Set((m.backend.routes || []).map(r => r.handler));
      const unused = Object.keys(handlers).filter(h => !used.has(h));
      if (unused.length) log.warn(`[ext:${m.code}] handler senza route: ${unused.join(', ')}`);
      const mcpHandlers = instance.mcp || {};
      const missingMcp = m.mcp.tools.filter(t => typeof mcpHandlers[t.handler] !== 'function').map(t => t.handler);
      if (missingMcp.length) throw new Error(`handler MCP non trovati: ${missingMcp.join(', ')}`);

      const extRouter = express.Router();
      for (const r of m.backend.routes || []) {
        const fn = handlers[r.handler];
        // Gli errori (anche delle funzioni async) passano all'error handler del core
        extRouter[r.method.toLowerCase()](r.path, (req, res, next) => {
          try { Promise.resolve(fn(req, res, next)).catch(next); } catch (e) { next(e); }
        });
      }
      router.use(`/${m.code}`, extRouter);
      ext.instance = instance;
      ext.services = instance.services || {};
      ext.mcpTools = m.mcp.tools.map(t => ({ ...t, readOnly: t.readOnly ?? true, run: mcpHandlers[t.handler] }));
      claimConfig(ext, instance.config || {});
    } catch (e) {
      ext.state = 'disabled';
      ext.error = `backend: ${e.message}`;
      // chi dipende in modo obbligatorio da questa estensione viene escluso nel giro successivo del ciclo
    }
  }

  for (const e of extensions) {
    if (e.state === 'disabled') log.warn(`[ext:${e.manifest.code}] disattivata: ${e.error}`);
  }

  const active = order.filter(e => e.state !== 'disabled');

  return {
    router,
    extensions,
    get: code => byCode.get(code),
    // Strumenti MCP delle estensioni attive: { name: <code>_<nome>, extension, description, inputSchema, readOnly, run }
    mcpTools: () => active.filter(e => e.state !== 'disabled').flatMap(e => (e.mcpTools || []).map(t => ({
      name: `${e.manifest.code.replace(/-/g, '_')}_${t.name}`, extension: e.manifest.code,
      description: t.description, inputSchema: t.inputSchema || { type: 'object', properties: {} }, readOnly: t.readOnly, run: t.run,
    }))),
    configOwner,
    // Dati pubblici per la UI (/api/core/extensions)
    list: () => extensions.map(e => ({
      code: e.manifest.code,
      name: e.manifest.name,
      description: e.manifest.description || '',
      version: e.manifest.version || null,
      devdock: e.manifest.devdock || null,
      color: e.manifest.color || null,
      icon: e.manifest.icon || null,
      position: e.manifest.position || null,
      order: e.manifest.order ?? 100,
      dependencies: e.manifest.dependencies,
      frontend: e.manifest.frontend || null,
      // lingue di cui l'estensione ha un catalogo (i18n/<tag>.json)
      i18n: e.state === 'disabled' ? [] : e.i18n,
      export: (e.manifest.export || []).map(x => ({ id: x.id, label: x.label, description: x.description || '', sections: x.sections })),
      state: e.state,
      warnings: e.warnings,
      error: e.error,
    })).sort((a, b) => a.order - b.order || a.code.localeCompare(b.code)),
    shutdown() {
      for (const e of [...active].reverse()) {
        try { e.instance?.shutdown?.(); } catch (err) { log.error(`[ext:${e.manifest.code}] shutdown: ${err.message}`); }
      }
    },
  };
}

// Le chiavi di config dichiarate passano all'estensione, con le regole che il
// backend fornisce in instance.config[key] (empty, idField, validate, normalize, merge)
function claimConfig(ext, specs) {
  for (const key of ext.manifest.config) {
    registerSection(key, { ...(specs[key] || {}), owner: ext.manifest.code });
  }
}

function makeContext(ext, { byCode, lib, projects, log }) {
  const m = ext.manifest;
  const owned = new Set(m.config);
  const checkKey = key => {
    if (!owned.has(key)) throw new Error(`[ext:${m.code}] chiave di config "${key}" non dichiarata in setting.json`);
  };
  return {
    code: m.code,
    dir: ext.dir,
    lib,
    config: {
      get(key) { checkKey(key); return loadConfig()[key]; },
      set(key, value) { checkKey(key); const cfg = loadConfig(); cfg[key] = value; saveConfig(cfg); },
      // Più sezioni in un'unica scrittura atomica (tutte validate insieme)
      update(values) {
        Object.keys(values).forEach(checkKey);
        saveConfig({ ...loadConfig(), ...values });
      },
    },
    require(code) {
      const dep = m.dependencies.find(d => d.code === code);
      if (!dep) throw new Error(`[ext:${m.code}] "${code}" non è tra le dipendenze in setting.json`);
      const target = byCode.get(code);
      return target && target.state !== 'disabled' ? target.services : null;
    },
    // Progetti del core (sola lettura): list(), get(id), folders()
    projects: projects && { list: projects.list, get: projects.get, folders: projects.folders },
    sse: openSse,
    // Errori con codice traducibile: throw ctx.error(404, 'not_found', { id }) → { error, code: '<code>.not_found', params }
    // (messaggio da i18n/<lingua sorgente>.json, chiave "errors.not_found"); ctx.error.config(...) per le validazioni
    error: errorFactory(m.code, path.join(ext.dir, 'i18n', `${SOURCE_LANG}.json`)),
    log: {
      info: (...a) => log.log(`[ext:${m.code}]`, ...a),
      warn: (...a) => log.warn(`[ext:${m.code}]`, ...a),
      error: (...a) => log.error(`[ext:${m.code}]`, ...a),
    },
  };
}

// Serve solo i file frontend dichiarati nel manifest (mai server.js o altro)
function frontendRouter(loaded) {
  const router = express.Router();
  router.get('/:code/:file(*)', (req, res, next) => {
    const ext = loaded.get(req.params.code);
    const fe = ext && ext.state !== 'disabled' && ext.manifest.frontend;
    const catalog = /^i18n\/(.+)\.json$/.exec(req.params.file);
    const allowed = catalog ? ext?.i18n?.includes(catalog[1]) : fe && Object.values(fe).includes(req.params.file);
    if (!fe || !allowed) return next();
    res.sendFile(path.join(ext.dir, req.params.file));
  });
  return router;
}

module.exports = { loadExtensions, frontendRouter, validateManifest, topoSort, ManifestError, CORE_VERSION };
