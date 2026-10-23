// SemVer minimo, senza dipendenze: versioni "X.Y.Z" (con "-pre" e "+build" opzionali) e
// intervalli come in npm: "^2.0", "~1.4.2", ">=2.1 <3", "2.x", "*", alternative con "||".
// Le pre-release del core contano come la versione finale (2.0.0-dev soddisfa ^2.0).

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PARTIAL_RE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?$/;

function parse(v) {
  const m = VERSION_RE.exec(String(v ?? '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null } : null;
}

const valid = v => !!parse(v);

// Confronto (le pre-release vengono prima della versione finale)
function compare(a, b) {
  const x = typeof a === 'string' ? parse(a) : a, y = typeof b === 'string' ? parse(b) : b;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const num = (v, k) => (v[k] === null ? 0 : v[k]);

// "2", "2.1", "2.x", "*" → { major, minor, patch } con null per le parti libere
function partial(text) {
  const m = PARTIAL_RE.exec(text);
  if (!m) return null;
  const n = s => (s === undefined || /^[xX*]$/.test(s) ? null : +s);
  return { major: n(m[1]), minor: n(m[2]), patch: n(m[3]) };
}

// Un comparatore → funzione (versione) → bool
function comparator(text) {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(text);
  if (!m) return null;
  const op = m[1] || '';
  const p = partial(m[2]);
  if (!p) return null;
  const lo = { major: num(p, 'major'), minor: num(p, 'minor'), patch: num(p, 'patch'), pre: null };
  const cmp = v => compare(v, lo);
  // limite superiore escluso di un intervallo
  const upper = (major, minor, patch) => v => compare(v, { major, minor, patch, pre: null }) < 0;
  if (op === '^') {
    if (p.major === null) return () => true;
    const below = lo.major > 0 || p.minor === null ? upper(lo.major + 1, 0, 0)
      : lo.minor > 0 || p.patch === null ? upper(0, lo.minor + 1, 0) : upper(0, 0, lo.patch + 1);
    return v => cmp(v) >= 0 && below(v);
  }
  if (op === '~') {
    if (p.major === null) return () => true;
    const below = p.minor === null ? upper(lo.major + 1, 0, 0) : upper(lo.major, lo.minor + 1, 0);
    return v => cmp(v) >= 0 && below(v);
  }
  if (op === '>=') return v => cmp(v) >= 0;
  if (op === '>') {
    if (p.minor === null) return v => compare(v, { major: lo.major + 1, minor: 0, patch: 0, pre: null }) >= 0;
    if (p.patch === null) return v => compare(v, { major: lo.major, minor: lo.minor + 1, patch: 0, pre: null }) >= 0;
    return v => cmp(v) > 0;
  }
  if (op === '<') return v => cmp(v) < 0;
  if (op === '<=') {
    if (p.minor === null) return upper(lo.major + 1, 0, 0);
    if (p.patch === null) return upper(lo.major, lo.minor + 1, 0);
    return v => cmp(v) <= 0;
  }
  // senza operatore: "2" = 2.x.x, "2.1" = 2.1.x, "2.1.3" = esatta, "*" = tutte
  if (p.major === null) return () => true;
  if (p.minor === null) return v => v.major === lo.major;
  if (p.patch === null) return v => v.major === lo.major && v.minor === lo.minor;
  return v => cmp(v) === 0;
}

// Intervallo → funzione, null se non valido
function range(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 200) return null;
  const alternatives = text.split('||').map(alt => {
    const parts = alt.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    const fns = parts.map(comparator);
    return fns.every(Boolean) ? v => fns.every(fn => fn(v)) : null;
  });
  return alternatives.every(Boolean) ? v => alternatives.some(fn => fn(v)) : null;
}

const validRange = text => !!range(text);

// La versione (anche pre-release, contata come finale) è nell'intervallo?
function satisfies(version, text) {
  const v = parse(version);
  const fn = range(text);
  if (!v || !fn) return false;
  return fn({ ...v, pre: null });
}

// La più alta tra le versioni valide (null se nessuna)
const max = list => list.filter(valid).sort(compare).pop() || null;

module.exports = { parse, valid, compare, satisfies, validRange, max };
