// File .env: lettura e riscrittura che conserva commenti, righe vuote e ordine.
// Il file è un elenco di righe; le voci (CHIAVE=valore) ricordano le righe che occupano
// (un valore tra virgolette doppie può andare a capo), così una modifica tocca solo quelle.

const ENTRY_RE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

class EnvError extends Error {
  constructor(key, params = {}) { super(key); this.key = key; this.params = params; }
}

// Valore dopo "=": tra virgolette (doppie con escape \n \" \\, singole e backtick letterali)
// o semplice (fino a " #", spazi tolti). rest: righe successive per i valori su più righe.
function parseValue(text, rest) {
  const q = text[0];
  if (q === '"' || q === "'" || q === '`') {
    let body = text.slice(1), extra = 0;
    for (;;) {
      const end = q === '"' ? findClosing(body) : body.indexOf(q);
      if (end !== -1) {
        let value = body.slice(0, end);
        if (q === '"') value = value.replace(/\\(n|r|t|"|\\)/g, (m, c) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[c]);
        const comment = /^\s+(#.*)$/.exec(body.slice(end + 1).split('\n').pop())?.[1] || '';
        return { value, quote: q, extra, comment };
      }
      if (extra >= rest.length) return { value: body, quote: q, extra, unterminated: true };
      body += '\n' + rest[extra++];
    }
  }
  const comment = /\s+(#.*)$/.exec(text)?.[1] || '';
  return { value: text.replace(/\s+#.*$/, '').trim(), quote: '', extra: 0, comment };
}

function findClosing(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '"') return i;
  }
  return -1;
}

// { lines, entries: [{ key, value, quote, exported, start, end }] } (end inclusa)
function parse(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // a capo finale
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ENTRY_RE.exec(lines[i]);
    if (!m || lines[i].trim().startsWith('#')) continue;
    const v = parseValue(m[4], lines.slice(i + 1));
    entries.push({ key: m[3], value: v.value, quote: v.quote, exported: !!m[2], comment: v.comment || '', start: i, end: i + v.extra });
    i += v.extra;
  }
  return { lines, entries };
}

// Valore scritto nel file: semplice se possibile, altrimenti tra virgolette
function formatValue(value, preferQuote = '') {
  const v = String(value ?? '');
  if (preferQuote === "'" && !/['\n]/.test(v)) return `'${v}'`;
  if (!preferQuote && /^[A-Za-z0-9_./:@+,%=-]*$/.test(v)) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

// Riga di una voce: export e commento in linea dell'originale restano
const entryLine = (e, key, value) => `${e?.exported ? 'export ' : ''}${key}=${formatValue(value, e?.quote === '"' ? '' : e?.quote)}${e?.comment ? ` ${e.comment}` : ''}`;

// Applica le modifiche: { op: 'set', key, value } (aggiunge in fondo se manca),
// { op: 'rename', key, to }, { op: 'delete', key }. Restituisce il nuovo testo.
function apply(text, changes) {
  const { lines, entries } = parse(text);
  const out = [...lines];
  const replace = new Map(); // indice di riga iniziale → { end, lines }
  const appended = [];
  const byKey = new Map(entries.map(e => [e.key, e])); // l'ultima voce con quella chiave vince (come dotenv)
  const pending = new Map(); // modifiche alle voci esistenti, per chiave: { value?, to?, delete? }
  for (const ch of changes) {
    if (!ch || !['set', 'rename', 'delete'].includes(ch.op)) throw new EnvError('change_invalid');
    if (!KEY_RE.test(ch.key || '')) throw new EnvError('key_invalid', { key: String(ch.key ?? '') });
    if (ch.op === 'rename' && !KEY_RE.test(ch.to || '')) throw new EnvError('key_invalid', { key: String(ch.to ?? '') });
    if (ch.op === 'set' && typeof ch.value !== 'string') throw new EnvError('value_invalid', { key: ch.key });
    const e = byKey.get(ch.key);
    if (ch.op === 'set' && !e) { appended.push(entryLine(null, ch.key, ch.value)); continue; }
    if (!e) throw new EnvError('key_missing', { key: ch.key });
    if (ch.op === 'rename' && ch.to !== ch.key && byKey.has(ch.to)) throw new EnvError('key_exists', { key: ch.to });
    const state = pending.get(ch.key) || {};
    if (ch.op === 'set') state.value = ch.value;
    else if (ch.op === 'rename') state.to = ch.to;
    else state.delete = true;
    pending.set(ch.key, state);
  }
  for (const [key, st] of pending) {
    const e = byKey.get(key);
    const lead = /^(\s*)/.exec(lines[e.start])[1];
    const line = st.delete ? [] : [lead + entryLine(e, st.to || key, 'value' in st ? st.value : e.value)];
    replace.set(e.start, { end: e.end, lines: line });
  }
  for (const start of [...replace.keys()].sort((a, b) => b - a)) {
    const r = replace.get(start);
    out.splice(start, r.end - start + 1, ...r.lines);
  }
  if (appended.length) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(...appended);
  }
  return out.length ? out.join('\n') + '\n' : '';
}

module.exports = { parse, apply, formatValue, EnvError, KEY_RE };
