// Autorizzazione per tipologia di utenza: nessuna, basic auth, token incollato, token da una
// richiesta di login, token OAuth / OpenID Connect. I token vivono solo in memoria; i segreti
// (password, client secret) sono cifrati con il vault del DB client.
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { fill, jsonInner, buildUrl, execute, SendError } = require('./send');

const MAX_AFTER_STEPS = 5;
const EXPIRY_SKEW_MS = 30 * 1000;      // un token che scade entro 30 s si considera scaduto
const LOGIN_WAIT_MS = 5 * 60 * 1000;   // tempo massimo per il login nel browser
const AUTH_TYPES = ['none', 'basic', 'manual', 'login', 'oauth'];
const OAUTH_FLOWS = ['pkce', 'code', 'implicit'];

const b64url = buf => Buffer.from(buf).toString('base64url');

// Scadenza (ms) di un JWT dal claim exp, null se il token non è un JWT o non ha exp
function jwtExpiry(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}

// Valore in un oggetto JSON dal percorso "data.token" o "items.0.token"
function atPath(obj, p) {
  return String(p).split('.').filter(Boolean).reduce((v, k) => (v == null ? undefined : v[k]), obj);
}

const earliest = (...values) => {
  const list = values.filter(v => Number.isFinite(v));
  return list.length ? Math.min(...list) : null;
};

// Apre l'URL nel browser: Firefox nel container indicato (componente aggiuntivo "Open external
// links in a container", URL ext+container:) oppure il browser predefinito
function openBrowser(url, container) {
  if (process.env.DEVDOCK_NO_BROWSER === '1') return false;
  const target = container ? `ext+container:name=${encodeURIComponent(container)}&url=${encodeURIComponent(url)}` : url;
  let cmd, args;
  if (process.platform === 'darwin') {
    [cmd, args] = container ? ['open', ['-a', 'Firefox', target]] : ['open', [target]];
  } else if (process.platform === 'win32') {
    if (container) {
      const exe = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
        .map(dir => path.join(dir, 'Mozilla Firefox', 'firefox.exe')).find(f => fs.existsSync(f)) || 'firefox.exe';
      [cmd, args] = [exe, [target]];
    } else {
      [cmd, args] = ['rundll32', ['url.dll,FileProtocolHandler', target]]; // niente cmd.exe: & nell'URL
    }
  } else {
    [cmd, args] = container ? ['firefox', [target]] : ['xdg-open', [target]];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

function createAuth({ ctx, vault, pageText, varsOf }) {
  const tokens = new Map();   // "sezione\0utenza" → { token, expiresAt, refreshToken, source }
  const logins = new Map();   // "sezione\0utenza" → login OAuth in corso { authUrl, promise, cancel }
  const discovery = new Map(); // issuer → documento .well-known (in memoria)
  const keyOf = (section, user) => `${section.id}\0${user.id}`;

  const err = e => {
    if (e instanceof SendError) return ctx.error(e.status, e.key, e.params);
    return e;
  };

  const secret = box => {
    if (!box) return '';
    return vault.decrypt(box);
  };

  const valid = entry => entry && (!entry.expiresAt || Date.now() < entry.expiresAt - EXPIRY_SKEW_MS);

  // Token ottenuto: azioni dopo il token (richieste che usano il nuovo token e ne estraggono
  // valori), poi salvato in memoria. Se un'azione fallisce il token non viene tenuto.
  async function store(section, user, { token, expiresAt = null, refreshToken = null, source }) {
    const entry = { token, expiresAt: earliest(expiresAt, jwtExpiry(token)), refreshToken, source, obtainedAt: Date.now(), vars: {} };
    tokens.delete(keyOf(section, user));
    await afterToken(section, user, entry);
    tokens.set(keyOf(section, user), entry);
    return entry;
  }

  async function afterToken(section, user, entry) {
    const steps = user.afterToken || [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const vars = { ...varsOf(section), ...entry.vars, token: entry.token };
      let res;
      try {
        const headers = { [user.header || 'Authorization']: (user.format || 'Bearer {token}').split('{token}').join(entry.token) };
        for (const h of step.headers || []) if (h.name) headers[fill(h.name, vars)] = fill(h.value, vars);
        let body = null;
        if (step.bodyType === 'json' || step.bodyType === 'text') {
          body = fill(step.body, vars, step.bodyType === 'json' ? jsonInner : v => v);
          if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) headers['Content-Type'] = step.bodyType === 'json' ? 'application/json' : 'text/plain';
        }
        res = await execute({ method: step.method, url: buildUrl(step.url, [], vars), headers, body });
      } catch (e) { throw ctx.error(e.status || 502, 'after_token_failed', { step: i + 1, error: err(e).message }); }
      if (res.status < 200 || res.status >= 300) {
        throw ctx.error(502, 'after_token_status', { step: i + 1, status: res.status, body: (res.body || '').slice(0, 300) });
      }
      let json;
      for (const x of step.extract || []) {
        let value;
        if (x.from.startsWith('header:')) {
          const name = x.from.slice(7).trim().toLowerCase();
          value = res.headers.find(([h]) => h.toLowerCase() === name)?.[1];
        } else {
          if (json === undefined) { try { json = JSON.parse(res.body); } catch { json = null; } }
          value = json == null ? undefined : atPath(json, x.from.replace(/^json:/, ''));
        }
        if (value === undefined || value === null || typeof value === 'object') {
          throw ctx.error(502, 'after_token_extract', { step: i + 1, name: x.name, from: x.from });
        }
        if (x.name === 'token') { // secondo token (es. scambio): prende il posto del primo
          entry.token = String(value);
          entry.expiresAt = earliest(jwtExpiry(entry.token));
        } else entry.vars[x.name] = String(value);
      }
    }
  }

  function forget(section, user) {
    tokens.delete(keyOf(section, user));
    const pending = logins.get(keyOf(section, user));
    if (pending) pending.cancel();
  }

  // Tutti i token di una sezione (utenze cambiate o eliminate, sezione eliminata)
  function forgetSection(sectionId, userId = null) {
    for (const k of [...tokens.keys(), ...logins.keys()]) {
      const [s, u] = k.split('\0');
      if (s === sectionId && (!userId || u === userId)) {
        tokens.delete(k);
        logins.get(k)?.cancel();
      }
    }
  }

  function state(section, user) {
    const entry = tokens.get(keyOf(section, user));
    const pending = logins.get(keyOf(section, user));
    return {
      id: user.id,
      vars: entry ? Object.keys(entry.vars) : [],
      hasToken: !!entry,
      expired: !!entry && !valid(entry),
      expiresAt: entry?.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
      obtainedAt: entry ? new Date(entry.obtainedAt).toISOString() : null,
      refreshable: !!entry?.refreshToken,
      pendingLogin: pending ? pending.authUrl : null,
    };
  }

  // Header di autorizzazione per l'invio (vuoti senza tipologia o con "nessuna") e variabili
  // ricavate dalle azioni dopo il token
  async function headersFor(section, user) {
    const auth = user?.auth || { type: 'none' };
    if (auth.type === 'none') return { headers: {}, vars: {} };
    if (auth.type === 'basic') {
      const value = 'Basic ' + Buffer.from(`${auth.username || ''}:${secret(auth.password)}`, 'utf8').toString('base64');
      return { headers: { [user.header || 'Authorization']: value }, vars: {} };
    }
    const entry = await tokenFor(section, user);
    return { headers: { [user.header || 'Authorization']: (user.format || 'Bearer {token}').split('{token}').join(entry.token) }, vars: entry.vars };
  }

  async function tokenFor(section, user) {
    const entry = tokens.get(keyOf(section, user));
    if (valid(entry)) return entry;
    const { type } = user.auth;
    if (type === 'manual') throw ctx.error(409, entry ? 'token_expired' : 'token_missing', { user: user.label });
    if (type === 'login') return loginRequest(section, user);
    if (type === 'oauth') {
      if (entry?.refreshToken) {
        try { return await refresh(section, user, entry.refreshToken); } catch { /* refresh scaduto: di nuovo nel browser */ }
      }
      return startOAuth(section, user).promise;
    }
    throw ctx.error(400, 'auth_type_invalid');
  }

  // ---- token da una richiesta di login ----

  async function loginRequest(section, user) {
    const a = user.auth;
    const creds = { ...varsOf(section), username: a.username || '', password: secret(a.password) };
    const encode = a.contentType === 'json' ? jsonInner : a.contentType === 'form' ? encodeURIComponent : v => v;
    let res;
    try {
      const url = buildUrl(a.url, [], creds);
      const headers = { Accept: 'application/json' };
      const body = a.method === 'GET' ? null : fill(a.body, creds, encode);
      if (body != null) headers['Content-Type'] = a.contentType === 'json' ? 'application/json' : a.contentType === 'form' ? 'application/x-www-form-urlencoded' : 'text/plain';
      res = await execute({ method: a.method, url, headers, body });
    } catch (e) { throw err(e); }
    if (res.status < 200 || res.status >= 300) throw ctx.error(502, 'login_failed', { status: res.status, body: (res.body || '').slice(0, 300) });
    let token = null, expiresIn = null;
    const tokenPath = a.tokenPath || 'token';
    if (tokenPath.startsWith('header:')) {
      const name = tokenPath.slice(7).trim().toLowerCase();
      token = res.headers.find(([h]) => h.toLowerCase() === name)?.[1] || null;
      if (token && /^bearer\s+/i.test(token)) token = token.replace(/^bearer\s+/i, '');
    } else {
      let json;
      try { json = JSON.parse(res.body); } catch { throw ctx.error(502, 'login_not_json'); }
      token = atPath(json, tokenPath);
      expiresIn = a.expiresPath ? Number(atPath(json, a.expiresPath)) : null;
    }
    if (typeof token !== 'string' || !token) throw ctx.error(502, 'login_no_token', { path: tokenPath });
    return store(section, user, { token, expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null, source: 'login' });
  }

  // ---- OAuth / OpenID Connect ----

  async function endpoints(auth) {
    if (auth.authorizationEndpoint && (auth.tokenEndpoint || auth.flow === 'implicit')) {
      return { authorization: auth.authorizationEndpoint, token: auth.tokenEndpoint };
    }
    if (!auth.issuer) throw ctx.error(400, 'oauth_endpoints_missing');
    const doc = await discover(auth.issuer);
    return { authorization: auth.authorizationEndpoint || doc.authorization_endpoint, token: auth.tokenEndpoint || doc.token_endpoint };
  }

  // Documento /.well-known/openid-configuration dell'issuer
  async function discover(issuer) {
    if (discovery.has(issuer)) return discovery.get(issuer);
    let res;
    try {
      res = await execute({ method: 'GET', url: buildUrl(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, [], {}), headers: { Accept: 'application/json' } }, { timeoutMs: 10000 });
    } catch (e) { throw err(e); }
    let doc = null;
    try { doc = res.status === 200 ? JSON.parse(res.body) : null; } catch { /* non JSON */ }
    if (!doc?.authorization_endpoint) throw ctx.error(502, 'oidc_discovery_failed', { issuer, status: res.status });
    discovery.set(issuer, doc);
    return doc;
  }

  async function tokenRequest(auth, tokenEndpoint, params) {
    const form = new URLSearchParams({ ...params, client_id: auth.clientId });
    if (auth.flow === 'code' && auth.clientSecret) form.set('client_secret', secret(auth.clientSecret));
    let res;
    try {
      res = await execute({
        method: 'POST', url: buildUrl(tokenEndpoint, [], {}),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form.toString(),
      }, { timeoutMs: 15000 });
    } catch (e) { throw err(e); }
    let json = null;
    try { json = JSON.parse(res.body); } catch { /* non JSON */ }
    if (res.status !== 200 || !json?.access_token) {
      throw ctx.error(502, 'oauth_token_failed', { status: res.status, error: json?.error_description || json?.error || (res.body || '').slice(0, 200) });
    }
    return json;
  }

  const fromTokenResponse = (section, user, json) => store(section, user, {
    token: json.access_token,
    expiresAt: Number(json.expires_in) > 0 ? Date.now() + Number(json.expires_in) * 1000 : null,
    refreshToken: json.refresh_token || null,
    source: 'oauth',
  });

  async function refresh(section, user, refreshToken) {
    const ep = await endpoints(user.auth);
    if (!ep.token) throw ctx.error(400, 'oauth_endpoints_missing');
    const json = await tokenRequest(user.auth, ep.token, { grant_type: 'refresh_token', refresh_token: refreshToken });
    if (!json.refresh_token) json.refresh_token = refreshToken;
    return fromTokenResponse(section, user, json);
  }

  // Login nel browser: DevDock ascolta sulla porta del redirect URI solo per la durata del
  // login, riceve il codice (o il token nel frammento, flusso implicit) e lo scambia
  function startOAuth(section, user, { open = true } = {}) {
    const k = keyOf(section, user);
    if (logins.has(k)) return logins.get(k);
    const auth = user.auth;
    const redirect = new URL(auth.redirectUri);
    const stateParam = b64url(crypto.randomBytes(16));
    const verifier = b64url(crypto.randomBytes(32));
    const servers = [];
    let resolveFn, rejectFn, timer;
    const pending = { authUrl: null, promise: null, cancel: () => finish(ctx.error(409, 'oauth_cancelled')) };
    pending.promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
    pending.promise.catch(() => {}); // chi attende gestisce l'errore; nessun "unhandled rejection"
    logins.set(k, pending);

    function finish(error, entry) {
      if (logins.get(k) !== pending) return;
      logins.delete(k);
      clearTimeout(timer);
      for (const s of servers) s.close();
      if (error) rejectFn(error); else resolveFn(entry);
    }

    const page = (req, res, key, params = {}, status = 200, script = '') => {
      const text = pageText(req.headers['accept-language'], key, params);
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><title>DevDock</title><body style="font-family:system-ui;padding:40px"><p id="m">${text.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)}</p>${script}</body>`);
    };

    async function onRequest(req, res) {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (u.pathname !== redirect.pathname) { res.writeHead(404); res.end(); return; }
      try {
        let params = u.searchParams;
        if (req.method === 'POST') { // flusso implicit: la pagina rimanda il frammento
          let body = '';
          for await (const chunk of req) { body += chunk; if (body.length > 16384) break; }
          params = new URLSearchParams(body);
        }
        if (params.get('error')) {
          const e = ctx.error(401, 'oauth_denied', { error: params.get('error'), description: params.get('error_description') || '' });
          page(req, res, 'oauthPage.failed', { error: e.message }, 400);
          return finish(e);
        }
        if (auth.flow === 'implicit' && req.method === 'GET' && !params.get('access_token')) {
          // il token è nel frammento (#access_token=…), che il browser non invia: lo rimanda la pagina
          return page(req, res, 'oauthPage.wait', {}, 200,
            '<script>fetch(location.pathname,{method:"POST",body:location.hash.slice(1)}).then(r=>r.text()).then(t=>{document.open();document.write(t);document.close()})</script>');
        }
        if (params.get('state') !== stateParam) {
          page(req, res, 'oauthPage.failed', { error: ctx.error.message('oauth_state') }, 400);
          return finish(ctx.error(401, 'oauth_state'));
        }
        let entry;
        if (auth.flow === 'implicit') {
          entry = await fromTokenResponse(section, user, { access_token: params.get('access_token'), expires_in: params.get('expires_in') });
        } else {
          const ep = await endpoints(auth);
          const json = await tokenRequest(auth, ep.token, {
            grant_type: 'authorization_code', code: params.get('code') || '', redirect_uri: auth.redirectUri,
            ...(auth.flow === 'pkce' ? { code_verifier: verifier } : {}),
          });
          entry = await fromTokenResponse(section, user, json);
        }
        page(req, res, 'oauthPage.done', { user: user.label });
        finish(null, entry);
      } catch (e) {
        page(req, res, 'oauthPage.failed', { error: e.message }, 500);
        finish(e);
      }
    }

    (async () => {
      const ep = await endpoints(auth);
      const authUrl = new URL(ep.authorization);
      const p = authUrl.searchParams;
      p.set('response_type', auth.flow === 'implicit' ? 'token' : 'code');
      p.set('client_id', auth.clientId);
      p.set('redirect_uri', auth.redirectUri);
      if (auth.scope) p.set('scope', auth.scope);
      p.set('state', stateParam);
      if (auth.flow === 'pkce') {
        p.set('code_challenge', b64url(crypto.createHash('sha256').update(verifier).digest()));
        p.set('code_challenge_method', 'S256');
      }
      if (auth.flow === 'implicit') p.set('nonce', b64url(crypto.randomBytes(12)));
      // in ascolto su 127.0.0.1 (e ::1 quando c'è): "localhost" del redirect può essere l'uno o l'altro
      const port = Number(redirect.port || 80);
      await new Promise((resolve, reject) => {
        const s = http.createServer(onRequest);
        s.once('error', e => reject(e.code === 'EADDRINUSE' ? ctx.error(409, 'oauth_port_busy', { port }) : e));
        s.listen(port, '127.0.0.1', () => { servers.push(s); resolve(); });
      });
      if (redirect.hostname !== '127.0.0.1') {
        const s6 = http.createServer(onRequest);
        s6.once('error', () => {});
        s6.listen(port, '::1', () => (logins.get(k) === pending ? servers.push(s6) : s6.close()));
      }
      if (logins.get(k) !== pending) { for (const s of servers) s.close(); return; } // annullato nel frattempo
      pending.authUrl = authUrl.toString();
      timer = setTimeout(() => finish(ctx.error(408, 'oauth_timeout')), LOGIN_WAIT_MS);
      if (open) openBrowser(pending.authUrl, auth.container);
    })().catch(e => finish(e));
    return pending;
  }

  // Login avviato dalla UI (login e OAuth): per OAuth restituisce subito l'URL di autorizzazione
  async function login(section, user) {
    const { type } = user.auth;
    if (type === 'login') { await loginRequest(section, user); return state(section, user); }
    if (type === 'oauth') {
      const entry = tokens.get(keyOf(section, user));
      tokens.delete(keyOf(section, user));
      if (entry?.refreshToken) {
        try { await refresh(section, user, entry.refreshToken); return state(section, user); } catch { /* di nuovo nel browser */ }
      }
      const pending = startOAuth(section, user);
      // l'URL è pronto appena il listener è in ascolto (o il login fallisce subito)
      for (let i = 0; i < 100 && !pending.authUrl && logins.get(keyOf(section, user)) === pending; i++) await new Promise(r => setTimeout(r, 20));
      if (!pending.authUrl) await pending.promise; // lancia l'errore di avvio
      return state(section, user);
    }
    throw ctx.error(400, 'login_not_supported');
  }

  function shutdown() { for (const p of [...logins.values()]) p.cancel(); }

  return { headersFor, state, store, forget, forgetSection, login, discover, shutdown };
}

module.exports = { createAuth, jwtExpiry, atPath, AUTH_TYPES, OAUTH_FLOWS, MAX_AFTER_STEPS, openBrowser };
