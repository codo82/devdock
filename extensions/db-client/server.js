// Database: connessioni MySQL/MariaDB (sezione "dbConnections"), password cifrate
// con una master password (sezione "vault"), query con timeout e limite di righe.
const mysql = require('mysql2/promise');
const vaultLib = require('./vault');

const DEFAULT_LOCK_MINUTES = 30;

const CONNECTION_FIELDS = ['id', 'label', 'type', 'host', 'port', 'database', 'user', 'password', 'projectId', 'tunnel', 'readOnly'];
const HOST_RE = /^(\[[0-9a-f:.]+\]|[A-Za-z0-9._-]{1,253})$/i;  // nome host, IPv4 o [IPv6]
const DB_NAME_RE = /^[^`\\/\x00]{1,64}$/;                       // nome database MySQL (niente backtick, slash, NUL)
const CONNECT_TIMEOUT_MS = 8000;

module.exports = function createDbClient(ctx) {
  const { ConfigError, pick } = ctx.lib.config;
  const { KEY_RE, isPort, isText } = ctx.lib.validate;
  const tunnels = ctx.require('tunnels'); // opzionale: senza, niente connessioni via tunnel

  const vault = () => ctx.config.get('vault');
  const connections = () => ctx.config.get('dbConnections');

  // ---- sessione del vault: la chiave vive solo in memoria ----

  const session = { key: null, lastUse: 0 };
  const lockAfterMs = () => (vault()?.lockAfterMinutes ?? DEFAULT_LOCK_MINUTES) * 60000;

  function lock() { session.key = null; }

  // Chiave di cifratura se il vault è sbloccato e non scaduto per inattività
  function currentKey() {
    if (session.key && Date.now() - session.lastUse > lockAfterMs()) lock();
    if (session.key) session.lastUse = Date.now();
    return session.key;
  }

  function vaultState() {
    if (!vault()) return 'uninitialized';
    return currentKey() ? 'unlocked' : 'locked';
  }

  // Protezione dai tentativi ripetuti: dal terzo errore attesa doppia ogni volta (max 30s)
  const throttle = { failures: 0, retryAt: 0 };
  function registerFailure() {
    throttle.failures++;
    const delay = throttle.failures < 3 ? 0 : Math.min(1000 * 2 ** (throttle.failures - 3), 30000);
    throttle.retryAt = Date.now() + delay;
  }

  // Password in chiaro di una connessione (solo lato server, al momento di connettersi)
  function decryptPassword(conn) {
    if (!conn.password) return '';
    const key = currentKey();
    if (!key) throw Object.assign(new Error('Vault bloccato: inserisci la master password'), { status: 423 });
    return vaultLib.decrypt(key, conn.password);
  }

  // ---- connessioni ----

  function validateConnection(c) {
    const where = `connessione "${c?.id}"`;
    if (!c || typeof c !== 'object') throw new ConfigError('Connessione non valida');
    if (!KEY_RE.test(c.id || '')) throw new ConfigError(`${where}: id non valido (lettere, numeri, _ e -)`);
    if (!isText(c.label)) throw new ConfigError(`${where}: nome obbligatorio`);
    if ((c.type ?? 'mysql') !== 'mysql') throw new ConfigError(`${where}: tipo non supportato`);
    if (c.tunnel != null) {
      if (!KEY_RE.test(c.tunnel)) throw new ConfigError(`${where}: tunnel non valido`);
    } else {
      if (!HOST_RE.test(c.host || '')) throw new ConfigError(`${where}: host non valido`);
      if (!isPort(c.port)) throw new ConfigError(`${where}: porta non valida (1-65535)`);
    }
    if (c.database != null && c.database !== '' && !DB_NAME_RE.test(c.database)) throw new ConfigError(`${where}: nome database non valido`);
    if (!isText(c.user, 80)) throw new ConfigError(`${where}: utente obbligatorio`);
    if (c.password != null && !vaultLib.isBox(c.password)) throw new ConfigError(`${where}: password non cifrata`);
    if (c.projectId != null && !KEY_RE.test(c.projectId)) throw new ConfigError(`${where}: progetto non valido`);
    if (c.readOnly != null && typeof c.readOnly !== 'boolean') throw new ConfigError(`${where}: readOnly deve essere true o false`);
  }

  // Ciò che vede il frontend: mai la password, solo se c'è
  const publicConnection = c => ({ ...pick(c, CONNECTION_FIELDS.filter(f => f !== 'password')), hasPassword: !!c.password });

  const fail = (message, status = 400) => Object.assign(new Error(message), { status });

  // Dati dal form → connessione da salvare. password: stringa = nuova (cifrata subito),
  // '' o assente = invariata, null = rimossa
  function buildConnection(body, existing = {}) {
    const c = { ...existing, ...pick(body || {}, ['label', 'host', 'port', 'database', 'user', 'projectId', 'tunnel', 'readOnly']) };
    if (!existing.id) c.id = body.id;
    c.type = 'mysql';
    if (c.port !== undefined && c.port !== null && c.port !== '') c.port = Number(c.port);
    for (const k of ['database', 'projectId', 'tunnel']) if (c[k] === '') c[k] = null;
    c.readOnly = !!c.readOnly;
    if (c.tunnel) {
      if (!tunnels) throw fail('Estensione Tunnels SSH non attiva: connessione via tunnel non disponibile');
      if (!tunnels.getServer(c.tunnel)) throw fail(`Server tunnel inesistente: ${c.tunnel}`);
      delete c.host; delete c.port; // host e porta vengono dal tunnel
    }
    if (typeof body.password === 'string' && body.password !== '') {
      const key = currentKey();
      if (!key) throw fail('Vault bloccato: inserisci la master password', 423);
      c.password = vaultLib.encrypt(key, body.password);
    } else if (body.password === null) {
      c.password = null;
    } else if (c.password === undefined) {
      c.password = null;
    }
    return c;
  }

  // Parametri di connessione per mysql2 (avvia il tunnel se la connessione lo usa)
  async function connectionTarget(conn) {
    let host = conn.host, port = conn.port, via = null;
    if (conn.tunnel) {
      if (!tunnels) throw fail('Estensione Tunnels SSH non attiva: connessione via tunnel non disponibile');
      const t = await tunnels.ensureTunnel(conn.tunnel);
      host = '127.0.0.1'; port = t.port; via = t.label;
    }
    return {
      options: {
        host, port, user: conn.user, password: decryptPassword(conn),
        database: conn.database || undefined,
        connectTimeout: CONNECT_TIMEOUT_MS,
        multipleStatements: false, // una sola istruzione per richiesta
        dateStrings: true,
        supportBigNumbers: true, bigNumberStrings: true,
      },
      via,
    };
  }

  const findConnection = id => connections().find(c => c.id === id) || null;

  // ---- regole delle sezioni di config ----

  const config = {
    vault: {
      empty: null,
      validate(record) {
        try { vaultLib.validateRecord(record); } catch (e) { throw new ConfigError(e.message); }
        if (record && record.lockAfterMinutes != null
            && !(Number.isInteger(record.lockAfterMinutes) && record.lockAfterMinutes >= 1 && record.lockAfterMinutes <= 1440)) {
          throw new ConfigError('vault: lockAfterMinutes deve essere tra 1 e 1440');
        }
      },
    },
    dbConnections: {
      empty: [], idField: 'id',
      normalize: v => (Array.isArray(v) ? v.map(c => pick(c || {}, CONNECTION_FIELDS)) : v),
      validate(list, cfg) {
        if (!Array.isArray(list)) throw new ConfigError('Config non valida: "dbConnections" deve essere una lista');
        const seen = new Set();
        for (const c of list) {
          validateConnection(c);
          if (seen.has(c.id)) throw new ConfigError(`Connessione duplicata: ${c.id}`);
          seen.add(c.id);
          if (c.password != null && !cfg.vault) throw new ConfigError(`connessione "${c.id}": password cifrata senza vault`);
        }
      },
    },
  };

  const vaultError = (res, status, error) => res.status(status).json({ error });

  return {
    config,

    handlers: {
      info(req, res) {
        res.json({ driver: 'mysql2', version: require('mysql2/package.json').version, ready: typeof mysql.createPool === 'function' });
      },

      // ---- connessioni ----

      listConnections(req, res) {
        res.json({ connections: connections().map(publicConnection), tunnelsAvailable: !!tunnels });
      },

      createConnection(req, res) {
        if (findConnection(req.body.id)) return res.status(409).json({ error: 'ID già esistente' });
        const c = buildConnection(req.body);
        ctx.config.set('dbConnections', [...connections(), c]);
        res.json({ ok: true, connection: publicConnection(c) });
      },

      updateConnection(req, res) {
        const list = connections();
        const idx = list.findIndex(c => c.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Connessione non trovata' });
        list[idx] = buildConnection(req.body, list[idx]);
        ctx.config.set('dbConnections', list);
        res.json({ ok: true, connection: publicConnection(list[idx]) });
      },

      deleteConnection(req, res) {
        ctx.config.set('dbConnections', connections().filter(c => c.id !== req.params.id));
        res.json({ ok: true });
      },

      // Prova di connessione: versione del server e utente effettivo
      async testConnection(req, res) {
        const conn = findConnection(req.params.id);
        if (!conn) return res.status(404).json({ error: 'Connessione non trovata' });
        let db;
        try {
          const { options, via } = await connectionTarget(conn);
          const started = Date.now();
          db = await mysql.createConnection(options);
          const [[row]] = await db.query('SELECT VERSION() AS version, CURRENT_USER() AS user, DATABASE() AS db');
          res.json({ ok: true, ...row, via, ms: Date.now() - started });
        } catch (e) {
          res.status(e.status || 502).json({ error: e.message });
        } finally {
          db?.end().catch(() => {});
        }
      },

      // ---- vault ----

      vaultStatus(req, res) {
        res.json({
          state: vaultState(),
          lockAfterMinutes: vault()?.lockAfterMinutes ?? DEFAULT_LOCK_MINUTES,
          minLength: vaultLib.MIN_PASSWORD,
          retryAfter: Math.max(0, Math.ceil((throttle.retryAt - Date.now()) / 1000)),
        });
      },

      async vaultInit(req, res) {
        if (vault()) return vaultError(res, 409, 'La master password è già stata creata');
        let created;
        try { created = await vaultLib.createVault(req.body.password); }
        catch (e) { return vaultError(res, 400, e.message); }
        ctx.config.set('vault', created.record);
        session.key = created.encKey;
        session.lastUse = Date.now();
        res.json({ ok: true, state: 'unlocked' });
      },

      async vaultUnlock(req, res) {
        const record = vault();
        if (!record) return vaultError(res, 409, 'Master password non ancora creata');
        const wait = Math.ceil((throttle.retryAt - Date.now()) / 1000);
        if (wait > 0) {
          res.setHeader('Retry-After', String(wait));
          return vaultError(res, 429, `Troppi tentativi: riprova tra ${wait}s`);
        }
        const key = await vaultLib.openVault(record, req.body.password);
        if (!key) {
          registerFailure();
          return vaultError(res, 401, 'Master password errata');
        }
        throttle.failures = 0;
        throttle.retryAt = 0;
        session.key = key;
        session.lastUse = Date.now();
        res.json({ ok: true, state: 'unlocked' });
      },

      vaultLock(req, res) {
        lock();
        res.json({ ok: true, state: vault() ? 'locked' : 'uninitialized' });
      },

      // Nuova master password: tutte le password vengono ri-cifrate e salvate insieme al vault
      async vaultChange(req, res) {
        const record = vault();
        if (!record) return vaultError(res, 409, 'Master password non ancora creata');
        const oldKey = await vaultLib.openVault(record, req.body.oldPassword);
        if (!oldKey) { registerFailure(); return vaultError(res, 401, 'Master password attuale errata'); }
        let created;
        try { created = await vaultLib.createVault(req.body.newPassword); }
        catch (e) { return vaultError(res, 400, e.message); }
        const reencrypted = connections().map(c => c.password
          ? { ...c, password: vaultLib.encrypt(created.encKey, vaultLib.decrypt(oldKey, c.password)) }
          : c);
        const lockAfterMinutes = record.lockAfterMinutes;
        ctx.config.update({
          vault: lockAfterMinutes ? { ...created.record, lockAfterMinutes } : created.record,
          dbConnections: reencrypted,
        });
        session.key = created.encKey;
        session.lastUse = Date.now();
        res.json({ ok: true, reencrypted: reencrypted.filter(c => c.password).length });
      },

      // Password dimenticata: si cancellano vault e password salvate (le connessioni restano)
      vaultReset(req, res) {
        if (req.body.confirm !== 'RESET') return vaultError(res, 400, 'Conferma mancante');
        const cleared = connections().map(c => ({ ...c, password: null }));
        ctx.config.update({ dbConnections: cleared, vault: null });
        lock();
        res.json({ ok: true, state: 'uninitialized' });
      },

      vaultSettings(req, res) {
        const record = vault();
        if (!record) return vaultError(res, 409, 'Master password non ancora creata');
        const minutes = Number(req.body.lockAfterMinutes);
        ctx.config.set('vault', { ...record, lockAfterMinutes: minutes });
        res.json({ ok: true, lockAfterMinutes: minutes });
      },
    },

    services: { decryptPassword },
  };
};
