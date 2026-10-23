// Rotte Express di un progetto per analisi statica (JS e TS), senza eseguire il codice.
// Parte dal "main" di package.json o dallo script di avvio, segue i require/import relativi
// e compone i prefissi di app.use / router.use tra i file, costanti comprese. I prefissi
// che non si possono ricavare (env, config, auto-loader con readdirSync) restano "da
// completare": il pezzo mancante è «espressione» nel percorso. NestJS, Fastify e Koa no.
const fs = require('fs');
const path = require('path');

const EXTENSIONS = ['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', 'test', 'tests', '__tests__', '__mocks__']);
const MAX_FILES = 3000;
const MAX_FILE_SIZE = 512 * 1024;
const MAX_PREFIXES = 20;
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'];
const ID = '[A-Za-z_$][\\w$]*';
const REL = `(\\.{1,2}/[^'"\`]+)`;

// ---- testo sorgente ----

// Commenti sostituiti da spazi (righe e posizioni invariate), stringhe intatte
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } out += src[i] ?? ''; continue; }
    if (c === '/' && n === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(src, i);
      out += src.slice(i, end); i = end - 1; continue;
    }
    out += c;
  }
  return out;
}

// Indice dopo la stringa che inizia in i (template con ${…} annidati compresi)
function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (q !== '`' && src[j] === '\n') return j;
    if (q === '`' && src[j] === '$' && src[j + 1] === '{') { j = skipBalanced(src, j + 1) - 1; continue; }
    if (src[j] === q) return j + 1;
  }
  return src.length;
}

// Indice dopo la parentesi che chiude quella in i ( ( [ { )
function skipBalanced(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') { j = skipString(src, j) - 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return j + 1; }
  }
  return src.length;
}

// Divide al livello più esterno (fuori da stringhe e parentesi) sul separatore
function splitTop(text, sep) {
  const parts = [];
  let depth = 0, start = 0;
  for (let j = 0; j < text.length; j++) {
    const c = text[j];
    if (c === '"' || c === "'" || c === '`') { j = skipString(text, j) - 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === sep && depth === 0) { parts.push(text.slice(start, j)); start = j + 1; }
  }
  parts.push(text.slice(start));
  return parts.map(s => s.trim()).filter((s, i, a) => s !== '' || a.length > 1);
}

// Argomenti della chiamata che apre in src[open] === '(' → { args, end }
function callArgs(src, open) {
  const end = skipBalanced(src, open);
  const inner = src.slice(open + 1, end - 1);
  return { args: inner.trim() ? splitTop(inner, ',') : [], end };
}

// Contenuto delle stringhe sostituito da spazi: le corrispondenze trovate qui non sono testo
function maskStrings(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(src, i);
      out += c + src.slice(i + 1, end - 1).replace(/[^\n]/g, ' ') + (end - 1 > i ? src[end - 1] : '');
      i = end - 1; continue;
    }
    out += c;
  }
  return out;
}

const lineAt = (src, index) => src.slice(0, index).split('\n').length;
const unquote = s => s.slice(1, -1).replace(/\\(.)/g, '$1');

// ---- analisi di un file ----

function parseFile(file, src) {
  const text = stripComments(src);
  const code = maskStrings(text);
  // corrispondenze che iniziano dentro una stringa (es. "router.get('/x')" in un testo) ignorate
  const inCode = m => code[m.index] === text[m.index] && code[m.index + m[0].length - 1] === text[m.index + m[0].length - 1];
  const all = re => [...text.matchAll(re)].filter(inCode);
  const f = {
    file, text,
    expressNames: new Set(), routers: new Map(), imports: new Map(), namespaces: new Map(),
    consts: new Map(), exports: new Map(), reexports: [], fnParams: new Set(), defaultFn: null,
    routes: [], mounts: [], calls: [], autoload: /\breaddir(Sync)?\s*\(/.test(text) && /\b(require|import)\s*\(\s*(?!(['"])[^'"]*\2\s*\))/.test(text),
  };

  for (const m of all(new RegExp(`\\b(${ID})\\s*=\\s*require\\(\\s*['"]express['"]\\s*\\)`, 'g'))) f.expressNames.add(m[1]);
  for (const m of all(new RegExp(`\\bimport\\s+(?:\\*\\s+as\\s+)?(${ID})\\s*(?:,|\\s+from)[^;\\n]*['"]express['"]`, 'g'))) f.expressNames.add(m[1]);

  // app e router creati nel file
  const decl = `(?:export\\s+)?(?:const|let|var)\\s+(${ID})(?:\\s*:\\s*[\\w$.<>\\[\\]]+)?\\s*=\\s*`;
  for (const m of all(new RegExp(`${decl}(?:new\\s+)?(?:(?:${ID}|require\\(\\s*['"]express['"]\\s*\\))\\s*\\.\\s*)?Router\\s*\\(`, 'g'))) f.routers.set(m[1], { kind: 'router', line: lineAt(text, m.index) });
  for (const m of all(new RegExp(`${decl}(${ID})\\s*\\(\\s*\\)`, 'g'))) {
    if (f.expressNames.has(m[2])) f.routers.set(m[1], { kind: 'app', line: lineAt(text, m.index) });
  }

  // import relativi
  const reqDecl = new RegExp(`\\b(?:const|let|var)\\s+(${ID})\\s*=\\s*require\\(\\s*['"\`]${REL}['"\`]\\s*\\)(\\s*\\.\\s*(${ID}))?`, 'g');
  for (const m of all(reqDecl)) f.imports.set(m[1], { spec: m[2], name: m[4] || 'default' });
  for (const m of all(new RegExp(`\\b(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\(\\s*['"\`]${REL}['"\`]\\s*\\)`, 'g'))) {
    for (const part of m[1].split(',')) {
      const [name, local] = part.split(':').map(s => s.trim());
      if (name) f.imports.set(local || name, { spec: m[2], name });
    }
  }
  for (const m of all(new RegExp(`\\bimport\\s+(?:type\\s+)?(${ID})?\\s*,?\\s*(?:\\{([^}]*)\\})?\\s*from\\s*['"]${REL}['"]`, 'g'))) {
    if (m[1] && m[1] !== 'type') f.imports.set(m[1], { spec: m[3], name: 'default' });
    for (const part of (m[2] || '').split(',')) {
      const [name, local] = part.replace(/^\s*type\s+/, '').split(/\s+as\s+/).map(s => s.trim());
      if (name) f.imports.set(local || name, { spec: m[3], name });
    }
  }
  for (const m of all(new RegExp(`\\bimport\\s*\\*\\s*as\\s+(${ID})\\s+from\\s*['"]${REL}['"]`, 'g'))) f.namespaces.set(m[1], m[2]);
  for (const m of all(new RegExp(`\\bimport\\s+(${ID})\\s*=\\s*require\\(\\s*['"]${REL}['"]\\s*\\)`, 'g'))) f.imports.set(m[1], { spec: m[2], name: 'default' });

  // costanti (prefissi): il valore è l'espressione fino a fine istruzione
  for (const m of all(new RegExp(`(?:^|[;\\n{}])\\s*(?:export\\s+)?(?:const|let|var)\\s+(${ID})(?:\\s*:\\s*[\\w$]+)?\\s*=\\s*(?=['"\`]|${ID}\\s*\\+|${ID}\\s*[;\\n])`, 'g'))) {
    const start = m.index + m[0].length;
    let end = start, depth = 0;
    for (; end < text.length; end++) {
      const c = text[end];
      if (c === '"' || c === "'" || c === '`') { end = skipString(text, end) - 1; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if ((c === ';' || c === ',' || c === '\n') && depth === 0) {
        if (c === '\n' && /[+]\s*$/.test(text.slice(start, end))) continue; // concatenazione su più righe
        break;
      }
    }
    if (!f.consts.has(m[1])) f.consts.set(m[1], text.slice(start, end).trim());
  }

  // export
  const exportsOf = (spec, local) => f.exports.set(spec, local);
  for (const m of all(new RegExp(`\\bmodule\\.exports\\s*=\\s*(${ID})\\s*(?=[;\\n]|$)`, 'g'))) exportsOf('default', { local: m[1] });
  for (const m of all(new RegExp(`\\bexport\\s+default\\s+(${ID})\\s*(?=[;\\n]|$)`, 'g'))) exportsOf('default', { local: m[1] });
  for (const m of all(new RegExp(`\\bexport\\s*=\\s*(${ID})\\s*(?=[;\\n]|$)`, 'g'))) exportsOf('default', { local: m[1] });
  for (const m of all(new RegExp(`\\bmodule\\.exports\\s*=\\s*require\\(\\s*['"]${REL}['"]\\s*\\)`, 'g'))) exportsOf('default', { spec: m[1], name: 'default' });
  for (const m of all(/\bmodule\.exports\s*=\s*\{/g)) {
    const end = skipBalanced(text, m.index + m[0].length - 1);
    for (const part of splitTop(text.slice(m.index + m[0].length, end - 1), ',')) {
      const pm = part.match(new RegExp(`^(${ID})\\s*(?::\\s*(${ID}))?$`));
      if (pm) exportsOf(pm[1], { local: pm[2] || pm[1] });
    }
  }
  for (const m of all(new RegExp(`\\b(?:module\\.)?exports\\.(${ID})\\s*=\\s*(${ID})\\s*(?=[;\\n]|$)`, 'g'))) exportsOf(m[1], { local: m[2] });
  for (const m of all(new RegExp(`\\bexport\\s+(?:const|let|var)\\s+(${ID})`, 'g'))) exportsOf(m[1], { local: m[1] });
  for (const m of all(/\bexport\s*\{([^}]*)\}\s*(?:from\s*['"](\.{1,2}\/[^'"]+)['"])?/g)) {
    for (const part of m[1].split(',')) {
      const [name, alias] = part.split(/\s+as\s+/).map(s => s.trim());
      if (!name) continue;
      exportsOf(alias || name, m[2] ? { spec: m[2], name } : { local: name });
    }
  }
  for (const m of all(/\bexport\s*\*\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g)) f.reexports.push(m[1]);

  // funzione esportata (module.exports = function (app) {…}, export default (router) => …):
  // i suoi parametri sono app/router passati da chi la chiama
  const fnDecls = new Map();
  for (const m of all(new RegExp(`\\bfunction\\s+(${ID})\\s*\\(\\s*(${ID})`, 'g'))) fnDecls.set(m[1], m[2]);
  for (const m of all(new RegExp(`\\b(?:const|let|var)\\s+(${ID})\\s*=\\s*(?:async\\s+)?(?:function\\s*(?:${ID})?\\s*\\(\\s*(${ID})|\\(?\\s*(${ID})\\s*(?::[^,)=]+)?[,)]?\\s*(?:=>|\\)\\s*=>))`, 'g'))) fnDecls.set(m[1], m[2] || m[3]);
  const inlineFn = text.match(new RegExp(`\\b(?:module\\.exports|export\\s+default)\\s*=?\\s*(?:async\\s+)?(?:function\\s*(?:${ID})?\\s*\\(\\s*(${ID})|\\(?\\s*(${ID})\\s*(?::[^,)=]+)?[,)]?\\s*(?:=>|\\)\\s*=>))`));
  if (inlineFn) f.defaultFn = inlineFn[1] || inlineFn[2];
  for (const [name, spec] of f.exports) {
    if (spec.local && fnDecls.has(spec.local) && !f.routers.has(spec.local)) {
      if (name === 'default') f.defaultFn = fnDecls.get(spec.local);
      spec.fnParam = fnDecls.get(spec.local);
    }
  }
  if (f.defaultFn) f.fnParams.add(f.defaultFn);
  for (const spec of f.exports.values()) if (spec.fnParam) f.fnParams.add(spec.fnParam);

  // rotte e mount: <oggetto>.<metodo>( … ), con .route('/x').get(…).post(…)
  const callRe = new RegExp(`(?<![\\w$.])(${ID})\\s*\\.\\s*(${[...METHODS, 'use', 'route'].join('|')})\\s*\\(`, 'g');
  for (const m of all(callRe)) {
    const [, receiver, method] = m;
    const open = m.index + m[0].length - 1;
    const { args, end } = callArgs(text, open);
    const line = lineAt(text, m.index);
    if (method === 'use') { f.mounts.push({ receiver, args, line }); continue; }
    if (method === 'route') {
      if (!args.length) continue;
      let pos = end;
      const chain = new RegExp(`^\\s*\\.\\s*(${METHODS.join('|')})\\s*\\(`);
      for (let cm; (cm = text.slice(pos).match(chain));) {
        const next = callArgs(text, pos + cm[0].length - 1);
        f.routes.push({ receiver, method: cm[1], pathExpr: args[0], line });
        pos = next.end;
      }
      continue;
    }
    if (args.length >= 2) f.routes.push({ receiver, method, pathExpr: args[0], line }); // app.get('setting') ha un solo argomento
  }

  // chiamate a funzioni con app/router come primo argomento: require('./routes')(app), routes(app)
  for (const m of all(new RegExp(`(?<![\\w$.])(require\\(\\s*['"]${REL}['"]\\s*\\)|${ID})\\s*\\(\\s*(${ID})\\s*[,)]`, 'g'))) {
    f.calls.push({ callee: m[1], arg: m[3], line: lineAt(text, m.index) });
  }
  return f;
}

// ---- progetto ----

function resolveModule(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, ...EXTENSIONS.map(e => base + e), ...EXTENSIONS.map(e => path.join(base, 'index' + e))];
  if (/\.(c|m)?js$/.test(base)) candidates.push(...['.ts', '.tsx', '.mts', '.cts'].map(e => base.replace(/\.(c|m)?js$/, e))); // import './x.js' di un sorgente TS
  return candidates.find(c => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}

// File di avvio: main di package.json, script start/dev, poi i nomi più comuni
function entryFile(root) {
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { /* senza package.json */ }
  const exists = rel => { const f = path.resolve(root, rel); try { return fs.statSync(f).isFile() ? f : null; } catch { return null; } };
  const tryModule = rel => exists(rel) || resolveModule(path.join(root, 'x'), rel.startsWith('.') ? rel : `./${rel}`);
  if (typeof pkg.main === 'string' && pkg.main) { const f = tryModule(pkg.main); if (f) return { file: f, from: 'main' }; }
  for (const script of ['start', 'dev', 'serve']) {
    const cmd = pkg.scripts?.[script];
    if (typeof cmd !== 'string') continue;
    for (const token of cmd.split(/\s+/)) {
      if (!token || token.startsWith('-') || /^(node|nodemon|ts-node|ts-node-dev|tsx|npx|cross-env|[A-Z_]+=.*)$/.test(token)) continue;
      const f = /[\\/.]/.test(token) && tryModule(token);
      if (f) return { file: f, from: script };
    }
  }
  for (const rel of ['server.js', 'app.js', 'index.js', 'src/server.ts', 'src/index.ts', 'src/app.ts', 'src/main.ts', 'src/server.js', 'src/index.js', 'src/app.js', 'bin/www']) {
    const f = exists(rel);
    if (f) return { file: f, from: 'default' };
  }
  return null;
}

function projectFiles(root) {
  const out = [];
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
      if (EXTENSIONS.includes(path.extname(e.name)) && !/\.(test|spec|d)\.[cm]?[jt]sx?$/.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

function discover(root) {
  const cache = new Map();
  const load = file => {
    if (cache.has(file)) return cache.get(file);
    let f = null;
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size <= MAX_FILE_SIZE) f = parseFile(file, fs.readFileSync(file, 'utf8'));
    } catch { /* illeggibile */ }
    cache.set(file, f);
    return f;
  };
  const entry = entryFile(root);
  const files = new Set(projectFiles(root));
  if (entry) files.add(entry.file);

  // file raggiungibili dall'avvio seguendo gli import relativi
  const reached = new Set();
  if (entry) {
    const stack = [entry.file];
    while (stack.length) {
      const file = stack.pop();
      if (reached.has(file)) continue;
      const f = load(file);
      if (!f) continue;
      reached.add(file);
      const specs = [...[...f.imports.values()].map(i => i.spec), ...f.namespaces.values(), ...f.reexports,
        ...[...f.exports.values()].filter(e => e.spec).map(e => e.spec),
        ...[...f.text.matchAll(/\b(?:require|import)\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)].map(m => m[1])];
      for (const spec of specs) { const target = resolveModule(file, spec); if (target) { files.add(target); stack.push(target); } }
    }
  }

  // ---- risoluzione dei nomi: nodo = "file#nome" di un'app, di un router o di un parametro ----

  const nodeId = (file, name) => `${file}#${name}`;
  const nodes = new Map(); // id → { file, name, kind }

  function exportNode(file, name, seen = new Set()) {
    const f = load(file);
    if (!f || seen.has(`${file}:${name}`)) return null;
    seen.add(`${file}:${name}`);
    const spec = f.exports.get(name);
    if (spec?.local) return localNode(f, spec.local, seen);
    if (spec?.spec) { const t = resolveModule(file, spec.spec); return t ? exportNode(t, spec.name, seen) : null; }
    if (name !== 'default') {
      for (const r of f.reexports) { const t = resolveModule(file, r); const n = t && exportNode(t, name, seen); if (n) return n; }
    }
    return null;
  }

  // Router restituito da una funzione esportata (factory): l'unico router creato nel file
  function factoryNode(file, name) {
    const f = load(file);
    if (!f) return null;
    const spec = f.exports.get(name);
    if (!(name === 'default' ? f.defaultFn || spec?.fnParam : spec?.fnParam)) return null;
    const routers = [...f.routers].filter(([, r]) => r.kind === 'router');
    return routers.length === 1 ? node(f, routers[0][0], 'router') : null;
  }

  function node(f, name, kind) {
    const id = nodeId(f.file, name);
    if (!nodes.has(id)) nodes.set(id, { id, file: f.file, name, kind });
    return nodes.get(id);
  }

  function localNode(f, name, seen = new Set()) {
    if (f.routers.has(name)) return node(f, name, f.routers.get(name).kind);
    if (f.fnParams.has(name)) return node(f, `(${name})`, 'param');
    const imp = f.imports.get(name);
    if (imp) { const t = resolveModule(f.file, imp.spec); return t ? exportNode(t, imp.name, seen) : null; }
    return null;
  }

  // Espressione usata come router in app.use(…): nome, require('./x'), x.y, chiamata di factory
  function exprNode(f, expr) {
    let m;
    if ((m = expr.match(new RegExp(`^(${ID})$`)))) return localNode(f, m[1]);
    if ((m = expr.match(new RegExp(`^require\\(\\s*['"]${REL}['"]\\s*\\)(?:\\s*\\.\\s*(${ID}))?$`)))) {
      const t = resolveModule(f.file, m[1]);
      return t ? exportNode(t, m[2] || 'default') || (m[2] ? null : null) : null;
    }
    if ((m = expr.match(new RegExp(`^(${ID})\\s*\\.\\s*(${ID})$`)))) {
      const target = f.namespaces.get(m[1]) || (f.imports.get(m[1])?.name === 'default' ? f.imports.get(m[1]).spec : null);
      const t = target && resolveModule(f.file, target);
      return t ? exportNode(t, m[2]) : null;
    }
    if ((m = expr.match(new RegExp(`^(require\\(\\s*['"]${REL}['"]\\s*\\)|${ID})\\s*\\(`)))) {
      const target = calleeExport(f, m[1]);
      return target ? factoryNode(target.file, target.name) : null;
    }
    return null;
  }

  // File e nome dell'export chiamato come funzione
  function calleeExport(f, callee) {
    const req = callee.match(/^require\(\s*['"](.+)['"]\s*\)$/);
    if (req) { const t = resolveModule(f.file, req[1]); return t ? { file: t, name: 'default' } : null; }
    const imp = f.imports.get(callee);
    if (!imp) return null;
    const t = resolveModule(f.file, imp.spec);
    return t ? { file: t, name: imp.name } : null;
  }

  // ---- valore dei percorsi: parti di testo e parti sconosciute ----

  function evalPath(f, expr, depth = 0) {
    expr = expr.trim().replace(/\s+as\s+const$/, '');
    if (depth > 8) return [{ unknown: expr }];
    if (/^(['"]).*\1$/s.test(expr)) return [{ text: unquote(expr) }];
    if (/^`[\s\S]*`$/.test(expr) && skipString(expr, 0) === expr.length) {
      const parts = [];
      const body = expr.slice(1, -1);
      let i = 0, buf = '';
      while (i < body.length) {
        if (body[i] === '\\') { buf += body[i + 1] ?? ''; i += 2; continue; }
        if (body[i] === '$' && body[i + 1] === '{') {
          const end = skipBalanced(body, i + 1);
          if (buf) parts.push({ text: buf }); buf = '';
          parts.push(...evalPath(f, body.slice(i + 2, end - 1), depth + 1));
          i = end; continue;
        }
        buf += body[i++];
      }
      if (buf) parts.push({ text: buf });
      return parts;
    }
    const sum = splitTop(expr, '+');
    if (sum.length > 1) return sum.flatMap(p => evalPath(f, p, depth + 1));
    if (/^\((.*)\)$/s.test(expr) && skipBalanced(expr, 0) === expr.length) return evalPath(f, expr.slice(1, -1), depth + 1);
    let m;
    if ((m = expr.match(new RegExp(`^(${ID})$`)))) {
      if (f.consts.has(m[1])) return evalPath(f, f.consts.get(m[1]), depth + 1);
      const imp = f.imports.get(m[1]);
      const t = imp && resolveModule(f.file, imp.spec);
      const value = t && exportedConst(t, imp.name, depth);
      if (value) return value;
    }
    if ((m = expr.match(new RegExp(`^(${ID})\\s*\\.\\s*(${ID})$`)))) {
      const target = f.namespaces.get(m[1]) || (f.imports.get(m[1])?.name === 'default' ? f.imports.get(m[1]).spec : null);
      const t = target && resolveModule(f.file, target);
      const value = t && exportedConst(t, m[2], depth);
      if (value) return value;
    }
    return [{ unknown: expr }];
  }

  function exportedConst(file, name, depth) {
    const f = load(file);
    const spec = f?.exports.get(name);
    if (spec?.local && f.consts.has(spec.local)) {
      const v = evalPath(f, f.consts.get(spec.local), depth + 1);
      return v.some(p => p.unknown) ? null : v;
    }
    return null;
  }

  // Un argomento di use() è un percorso se è un testo (anche da costanti) o un'espressione
  // seguita da un router (es. app.use(config.prefix, router))
  const looksLikePath = (f, expr, rest) => {
    const v = evalPath(f, expr);
    if (!v.some(p => p.unknown)) return v;
    if (/^\[/.test(expr) || /\(\s*\)?$/.test(expr) || /=>/.test(expr) || /^function\b/.test(expr)) return null;
    return rest.some(a => exprNode(f, a)) && !exprNode(f, expr) ? v : null;
  };

  // ---- grafo: mount (padre → figlio, prefisso) ----

  const edges = []; // { from, to, prefix }
  const routes = []; // { node, method, parts, file, line }
  const autoloaders = [];
  for (const file of files) {
    const f = load(file);
    if (!f) continue;
    if (f.autoload) autoloaders.push(file);
    for (const mt of f.mounts) {
      const from = localNode(f, mt.receiver);
      if (!from || !mt.args.length) continue;
      const prefix = looksLikePath(f, mt.args[0], mt.args.slice(1));
      const targets = prefix ? mt.args.slice(1) : mt.args;
      for (const a of targets) {
        const to = exprNode(f, a);
        if (to && to !== from) edges.push({ from, to, prefix: prefix || [] });
      }
    }
    for (const c of f.calls) {
      const target = calleeExport(f, c.callee);
      if (!target) continue;
      const tf = load(target.file);
      const param = !tf ? null : target.name === 'default' ? tf.defaultFn : tf.exports.get(target.name)?.fnParam;
      const from = param && localNode(f, c.arg);
      if (from) edges.push({ from, to: node(tf, `(${param})`, 'param'), prefix: [] });
    }
    for (const r of f.routes) {
      const n = localNode(f, r.receiver);
      if (n) routes.push({ node: n, method: r.method, parts: evalPath(f, r.pathExpr), file, line: r.line });
    }
  }

  // Radici: le app raggiungibili dall'avvio (tutte le app se non ce ne sono)
  let roots = [...nodes.values()].filter(n => n.kind === 'app' && reached.has(n.file));
  if (!roots.length) roots = [...nodes.values()].filter(n => n.kind === 'app');
  const prefixes = new Map(roots.map(r => [r.id, [[]]]));
  const key = parts => JSON.stringify(parts);
  const queue = [...roots];
  for (let steps = 0; queue.length && steps < 10000; steps++) {
    const n = queue.shift();
    for (const e of edges.filter(x => x.from === n)) {
      const list = prefixes.get(e.to.id) || [];
      const known = new Set(list.map(key));
      let added = false;
      for (const p of prefixes.get(n.id)) {
        const next = [...p, ...e.prefix];
        if (list.length >= MAX_PREFIXES || known.has(key(next))) continue;
        list.push(next); known.add(key(next)); added = true;
      }
      prefixes.set(e.to.id, list);
      if (added) queue.push(e.to);
    }
  }

  const rel = file => path.relative(root, file).split(path.sep).join('/');
  const out = [];
  const seen = new Set();
  for (const r of routes) {
    const attached = prefixes.get(r.node.id);
    const list = attached || [[{ unknown: '?' }]]; // router mai montato su un'app trovata
    for (const prefix of list) {
      const parts = [...prefix, ...r.parts];
      const unresolved = parts.filter(p => p.unknown).map(p => p.unknown);
      const full = joinPath(parts);
      const id = `${r.method} ${full} ${r.file}:${r.line}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        method: r.method === 'all' ? 'ALL' : r.method.toUpperCase(), path: full,
        complete: !unresolved.length, unresolved, file: rel(r.file), line: r.line, attached: !!attached,
      });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return {
    entry: entry ? { file: rel(entry.file), from: entry.from } : null,
    routes: out,
    autoloaders: autoloaders.map(rel),
    files: files.size,
  };
}

// Percorso completo: "/" tra i pezzi, niente doppie barre, le parti sconosciute come «espressione»
function joinPath(parts) {
  const text = parts.map(p => (p.unknown ? `/«${p.unknown}»/` : p.text)).join('');
  const joined = ('/' + text).replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

module.exports = { discover, parseFile, stripComments, splitTop, entryFile, joinPath };
