// Sicurezza — l'API esegue ssh/npm/git/pm2: accetta solo richieste dalla UI locale
const { PORT } = require('./env');

function applySecurity(app) {
  const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
  const UNSAFE_METHODS  = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  const ALLOWED_HOSTS   = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

  function originOf(url) {
    try { return new URL(url).origin; } catch { return null; }
  }

  // Anti DNS rebinding: un dominio esterno può risolvere a 127.0.0.1 e diventare
  // "same-origin" con l'API. Il suo nome resta però nell'header Host, quindi si
  // accettano solo gli host locali.
  app.use((req, res, next) => {
    if (!ALLOWED_HOSTS.has((req.get('Host') || '').toLowerCase())) {
      return res.status(421).json({ error: 'Host non consentito' });
    }
    next();
  });

  // Anti-CSRF: una pagina web qualsiasi aperta nel browser può inviare richieste a
  // localhost. I browser aggiungono sempre Origin alle richieste cross-site non-GET,
  // quindi si rifiuta ogni Origin (o in mancanza Referer) che non sia la UI stessa.
  // Richieste senza nessuno dei due (curl, script locali) sono ammesse.
  app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: 'Origine non consentita' });
    }
    if (!origin && UNSAFE_METHODS.has(req.method)) {
      const referer = req.get('Referer');
      if (referer && !ALLOWED_ORIGINS.has(originOf(referer))) {
        return res.status(403).json({ error: 'Origine non consentita' });
      }
    }
    next();
  });

  app.disable('x-powered-by');

  // Header di sicurezza. La CSP ammette script inline (la UI usa onclick inline)
  // e cdnjs per Swagger UI; connect-src resta aperto per il "Try it out" di Swagger.
  const CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' http: https:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });

  // I form HTML cross-site possono inviare solo tipi "semplici" (form, text/plain):
  // esigere JSON chiude anche il caso di browser che non inviano Origin
  app.use('/api', (req, res, next) => {
    if ((req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') && !req.is('application/json')) {
      return res.status(415).json({ error: 'Content-Type deve essere application/json' });
    }
    next();
  });
}

module.exports = { applySecurity };
