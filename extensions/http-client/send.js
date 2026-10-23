// Invio delle richieste HTTP dal backend (niente limiti CORS): variabili {{nome}},
// timeout, limite sulla dimensione della risposta, nessun redirect seguito.
const http = require('http');
const https = require('https');

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const VAR_RE = /\{\{\s*([A-Za-z_][\w.-]{0,63})\s*\}\}/g;
const TEXT_TYPE_RE = /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|x-www-form-urlencoded|graphql|yaml|x-ndjson))|^$/i;

class SendError extends Error {
  constructor(key, params = {}, status = 400) { super(key); this.key = key; this.params = params; this.status = status; }
}

// {{nome}} → valore; encode: trasformazione del valore (JSON, form…); nome sconosciuto → errore
function fill(text, vars, encode = v => v) {
  return String(text ?? '').replace(VAR_RE, (m, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new SendError('variable_unknown', { name });
    return encode(String(vars[name]));
  });
}

const jsonInner = v => JSON.stringify(v).slice(1, -1);

// URL completo: variabili, poi i parametri della query (abilitati) codificati
function buildUrl(url, query, vars) {
  const filled = fill(url, vars).trim();
  let u;
  try { u = new URL(filled); } catch { throw new SendError('url_invalid', { url: filled }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SendError('url_protocol', { url: filled });
  for (const q of query || []) {
    if (q.enabled === false || !q.name) continue;
    u.searchParams.append(fill(q.name, vars), fill(q.value, vars));
  }
  return u;
}

const hasHeader = (headers, name) => Object.keys(headers).some(h => h.toLowerCase() === name.toLowerCase());

// Esegue la richiesta. req: { method, url (URL), headers: { nome: valore }, body: string|null }
// → { status, statusText, headers, ms, size, body, truncated, binary, json }
function execute(req, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  const lib = req.url.protocol === 'https:' ? https : http;
  const headers = { ...req.headers };
  const body = req.body == null ? null : Buffer.from(req.body, 'utf8');
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
        if (kept < maxBytes) {
          const part = chunk.subarray(0, maxBytes - kept);
          chunks.push(part);
          kept += part.length;
          if (part.length < chunk.length) truncated = true;
        } else truncated = true;
        if (size > maxBytes * 4) { truncated = true; res.destroy(); finish(); } // risposta enorme: non serve leggerla tutta
      });
      res.on('end', finish);
      res.on('error', e => done(new SendError('network', { error: e.message }, 502)));
      function finish() {
        const buf = Buffer.concat(chunks);
        const type = String(res.headers['content-type'] || '').split(';')[0].trim();
        const binary = !TEXT_TYPE_RE.test(type) || (type === '' && buf.includes(0));
        const text = binary ? null : buf.toString('utf8');
        let json = false;
        if (text != null && /json/i.test(type)) { try { JSON.parse(text); json = true; } catch { /* JSON non valido o troncato */ } }
        done(null, {
          status: res.statusCode, statusText: res.statusMessage || '',
          headers: res.rawHeaders.reduce((list, v, i, a) => (i % 2 ? list : [...list, [a[i], a[i + 1]]]), []),
          ms: Number(process.hrtime.bigint() - started) / 1e6,
          size, truncated, binary, json, body: text,
        });
      }
    });
    const timer = setTimeout(() => { r.destroy(); done(new SendError('timeout', { seconds: Math.round(timeoutMs / 1000) }, 504)); }, timeoutMs);
    r.on('error', e => done(new SendError('network', { error: e.code ? `${e.code}: ${e.message}` : e.message }, 502)));
    if (body) r.write(body);
    r.end();
  });
}

module.exports = { fill, jsonInner, buildUrl, execute, hasHeader, SendError, VAR_RE, MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS };
