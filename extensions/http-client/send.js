// Invio delle richieste HTTP dal backend (niente limiti CORS): variabili {{nome}} e :nome,
// timeout, limite sulla dimensione della risposta, nessun redirect seguito.
const http = require('http');
const https = require('https');
const { fileNameOf } = require('./mime');

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;   // testo mostrato
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;  // risposta binaria salvata come file
const DEFAULT_TIMEOUT_MS = 30000;
const VAR_RE = /\{\{\s*([A-Za-z_][\w.-]{0,63})\s*\}\}/g;
// :nome (come nelle rotte Express) solo dopo un carattere che non sia lettera, cifra o ":":
// http://, localhost:3000, user:pass, "chiave":valore, 10:30 e :: restano come sono
const COLON_VAR_RE = /(^|[^\w:]):([A-Za-z_]\w{0,63})/g;
const JSON_WORDS = new Set(['true', 'false', 'null']); // "ok":true nel JSON compatto non è una variabile
const TEXT_TYPE_RE = /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|x-www-form-urlencoded|graphql|yaml|x-ndjson))|^$/i;

class SendError extends Error {
  constructor(key, params = {}, status = 400) { super(key); this.key = key; this.params = params; this.status = status; }
}

const known = (vars, name) => Object.prototype.hasOwnProperty.call(vars, name);

// {{nome}} e :nome → valore; encode: trasformazione del valore (JSON, form…). {{nome}}
// sconosciuto → errore; :nome sconosciuto resta com'è (può essere testo qualsiasi)
function fill(text, vars, encode = v => v) {
  return String(text ?? '')
    .replace(VAR_RE, (m, name) => {
      if (!known(vars, name)) throw new SendError('variable_unknown', { name });
      return encode(String(vars[name]));
    })
    .replace(COLON_VAR_RE, (m, before, name) => (known(vars, name) && !JSON_WORDS.has(name) ? before + encode(String(vars[name])) : m));
}

const jsonInner = v => JSON.stringify(v).slice(1, -1);

// URL completo: variabili, poi i parametri della query (abilitati) codificati
function buildUrl(url, query, vars) {
  const filled = fill(url, vars).trim();
  let u;
  try { u = new URL(filled); } catch { throw new SendError('url_invalid', { url: filled }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SendError('url_protocol', { url: filled });
  // segmento del percorso ancora :nome (parametro di una rotta Express senza variabile)
  const param = /(?:^|\/):([A-Za-z_]\w*)(?=\/|$)/.exec(u.pathname);
  if (param) throw new SendError('param_unknown', { name: param[1] });
  for (const q of query || []) {
    if (q.enabled === false || !q.name) continue;
    u.searchParams.append(fill(q.name, vars), fill(q.value, vars));
  }
  return u;
}

const hasHeader = (headers, name) => Object.keys(headers).some(h => h.toLowerCase() === name.toLowerCase());

// Esegue la richiesta. req: { method, url (URL), headers: { nome: valore }, body: string|Buffer|null }
// → { status, statusText, headers, ms, size, body, truncated, binary, json } e, per le risposte
// binarie entro maxBinaryBytes, { base64, fileName } (il contenuto da salvare come file)
function execute(req, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES, maxBinaryBytes = 0 } = {}) {
  const lib = req.url.protocol === 'https:' ? https : http;
  const headers = { ...req.headers };
  const body = req.body == null ? null : Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body, 'utf8');
  const keep = Math.max(maxBytes, maxBinaryBytes);
  if (body && !hasHeader(headers, 'content-length')) headers['Content-Length'] = String(body.length);
  const started = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(value);
    };
    const r = lib.request(req.url, { method: req.method, headers }, res => {
      const chunks = [];
      let size = 0, kept = 0, truncated = false;
      res.on('data', chunk => {
        size += chunk.length;
        if (kept < keep) {
          const part = chunk.subarray(0, keep - kept);
          chunks.push(part);
          kept += part.length;
          if (part.length < chunk.length) truncated = true;
        } else truncated = true;
        if (size > keep * 4) { truncated = true; res.destroy(); finish(); } // risposta enorme: non serve leggerla tutta
      });
      res.on('end', finish);
      res.on('error', e => done(new SendError('network', { error: e.message }, 502)));
      function finish() {
        let buf = Buffer.concat(chunks);
        const type = String(res.headers['content-type'] || '').split(';')[0].trim();
        const binary = !TEXT_TYPE_RE.test(type) || (type === '' && buf.includes(0));
        if (!binary && buf.length > maxBytes) { buf = buf.subarray(0, maxBytes); truncated = true; }
        const text = binary ? null : buf.toString('utf8');
        const rawHeaders = res.rawHeaders.reduce((list, v, i, a) => (i % 2 ? list : [...list, [a[i], a[i + 1]]]), []);
        const file = binary && maxBinaryBytes && !truncated && buf.length ? { base64: buf.toString('base64'), fileName: fileNameOf(rawHeaders) } : {};
        let json = false;
        if (text != null && /json/i.test(type)) { try { JSON.parse(text); json = true; } catch { /* JSON non valido o troncato */ } }
        done(null, {
          status: res.statusCode, statusText: res.statusMessage || '',
          headers: rawHeaders,
          ms: Number(process.hrtime.bigint() - started) / 1e6,
          size, truncated, binary, json, body: text, ...file,
        });
      }
    });
    const timer = setTimeout(() => { r.destroy(); done(new SendError('timeout', { seconds: Math.round(timeoutMs / 1000) }, 504)); }, timeoutMs);
    r.on('error', e => done(new SendError('network', { error: e.code ? `${e.code}: ${e.message}` : e.message }, 502)));
    if (body) r.write(body);
    r.end();
  });
}

module.exports = { fill, jsonInner, buildUrl, execute, hasHeader, SendError, VAR_RE, MAX_RESPONSE_BYTES, MAX_DOWNLOAD_BYTES, DEFAULT_TIMEOUT_MS };
