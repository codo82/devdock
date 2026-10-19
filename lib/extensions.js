// Loader delle estensioni: legge extensions/*/setting.json, risolve le dipendenze,
// crea i backend in ordine topologico e monta le route dichiarate nel manifest
// su /api/ext/<code>. Contratto completo in docs/EXTENSIONS.md.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { loadConfig, saveConfig, registerSection } = require('./config');
const { openSse } = require('./sse');

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
  if (typeof m.name !== 'string' || !m.name.trim()) fail('"name" obbligatorio');
  if (!CODE_RE.test(m.code || '')) fail('"code" non valido (minuscole, numeri e -)');
  if (m.code !== folder) fail(`"code" (${m.code}) deve coincidere con il nome della cartella`);
  if (!COLOR_RE.test(m.color || '')) fail('"color" deve essere #rrggbb');
  if (!POSITIONS.has(m.position)) fail('"position" deve essere "tab" o "header"');
  if (m.order != null && !Number.isFinite(m.order)) fail('"order" deve essere un numero');

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

  return { order: 100, dependencies: deps, config, ...m };
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

// Carica tutte le estensioni di dir. Restituisce { router, extensions, list(), shutdown() }
function loadExtensions(dir, { lib = {}, log = console } = {}) {
  const router = express.Router();
  const extensions = [];

  // ---- scoperta e validazione dei manifest ----
  const folders = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
    : [];
  for (const folder of folders) {
    const file = path.join(dir, folder, 'setting.json');
    if (!fs.existsSync(file)) continue;
    const ext = { dir: path.join(dir, folder), manifest: null, state: 'ok', warnings: [], error: null, services: null, instance: null };
    try {
      ext.manifest = validateManifest(JSON.parse(fs.readFileSync(file, 'utf8')), folder);
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
      const ctx = makeContext(ext, { byCode, lib, log });
      const factory = require(path.join(ext.dir, m.backend.module));
      if (typeof factory !== 'function') throw new Error(`${m.backend.module} deve esportare una funzione (ctx) => { handlers }`);
      const instance = factory(ctx) || {};
      const handlers = instance.handlers || {};
      const missing = (m.backend.routes || []).filter(r => typeof handlers[r.handler] !== 'function').map(r => r.handler);
      if (missing.length) throw new Error(`handler non trovati: ${missing.join(', ')}`);
      const used = new Set((m.backend.routes || []).map(r => r.handler));
      const unused = Object.keys(handlers).filter(h => !used.has(h));
      if (unused.length) log.warn(`[ext:${m.code}] handler senza route: ${unused.join(', ')}`);

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
    configOwner,
    // Dati pubblici per la UI (/api/core/extensions)
    list: () => extensions.map(e => ({
      code: e.manifest.code,
      name: e.manifest.name,
      description: e.manifest.description || '',
      version: e.manifest.version || null,
      color: e.manifest.color || null,
      icon: e.manifest.icon || null,
      position: e.manifest.position || null,
      order: e.manifest.order ?? 100,
      dependencies: e.manifest.dependencies,
      frontend: e.manifest.frontend || null,
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

function makeContext(ext, { byCode, lib, log }) {
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
    },
    require(code) {
      const dep = m.dependencies.find(d => d.code === code);
      if (!dep) throw new Error(`[ext:${m.code}] "${code}" non è tra le dipendenze in setting.json`);
      const target = byCode.get(code);
      return target && target.state !== 'disabled' ? target.services : null;
    },
    sse: openSse,
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
    if (!fe || !Object.values(fe).includes(req.params.file)) return next();
    res.sendFile(path.join(ext.dir, req.params.file));
  });
  return router;
}

module.exports = { loadExtensions, frontendRouter, validateManifest, topoSort, ManifestError };
