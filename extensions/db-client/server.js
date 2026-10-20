// Database: connessioni MySQL/MariaDB (sezione "dbConnections"), password cifrate
// con una master password (sezione "vault"), query con timeout e limite di righe.
const crypto = require('crypto');
const mysqlCb = require('mysql2');
const mysql = require('mysql2/promise');
const vaultLib = require('./vault');
const { classify } = require('./sql');

const DEFAULT_LOCK_MINUTES = 30;

const CONNECTION_FIELDS = ['id', 'label', 'type', 'host', 'port', 'database', 'user', 'password', 'projectId', 'tunnel', 'readOnly'];
const HOST_RE = /^(\[[0-9a-f:.]+\]|[A-Za-z0-9._-]{1,253})$/i;  // nome host, IPv4 o [IPv6]
const DB_NAME_RE = /^[^`\\/\x00]{1,64}$/;                       // nome database MySQL (niente backtick, slash, NUL)
const CONNECT_TIMEOUT_MS = 8000;
const QUERY_TIMEOUT_MS = 30000;
const DEFAULT_ROW_LIMIT = 1000;
const MAX_ROW_LIMIT = 10000;

const PAGE_SIZES = [25, 50, 100, 250, 500];
// Operatori dei filtri dell'anteprima: SQL con il valore come parametro
const FILTER_OPS = {
  eq:       { sql: '= ?' },
  ne:       { sql: '<> ?' },
  contains: { sql: 'LIKE ?', like: v => `%${v}%` },
  starts:   { sql: 'LIKE ?', like: v => `${v}%` },
  lt:       { sql: '< ?' },
  gt:       { sql: '> ?' },
  null:     { sql: 'IS NULL', noValue: true },
  notnull:  { sql: 'IS NOT NULL', noValue: true },
};
const escapeLike = v => String(v).replace(/[\\%_]/g, m => '\\' + m);
const quoteId = name => '`' + String(name).replace(/`/g, '``') + '`';

// Nome del tipo MySQL dal codice numerico del protocollo
const TYPE_NAMES = Object.fromEntries(Object.entries(mysqlCb.Types).map(([name, code]) => [code, name]));

// Valori pronti per il JSON: i binari diventano esadecimale (troncato)
function cell(v) {
  if (Buffer.isBuffer(v)) return v.length <= 64 ? `0x${v.toString('hex')}` : `0x${v.subarray(0, 64).toString('hex')}… (${v.length} byte)`;
  return v;
}

module.exports = function createDbClient(ctx) {
  const { ConfigError, pick } = ctx.lib.config;
  const { KEY_RE, isPort, isText } = ctx.lib.validate;
  const tunnels = ctx.require('tunnels'); // opzionale: senza, niente connessioni via tunnel

  const vault = () => ctx.config.get('vault');
  const connections = () => ctx.config.get('dbConnections');

  // ---- sessione del vault: la chiave vive solo in memoria ----

  const session = { key: null, lastUse: 0 };
  const lockAfterMs = () => (vault()?.lockAfterMinutes ?? DEFAULT_LOCK_MINUTES) * 60000;

  function lock() { session.key = null; closePools(); } // senza vault niente connessioni aperte

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

  // ---- pool e query ----

  const pools = new Map(); // "id\0database" → { pool, signature }
  const confirmSecret = crypto.randomBytes(32); // i token di conferma valgono solo fino al riavvio

  function closePools(id) {
    for (const [k, p] of pools) {
      if (id && !k.startsWith(id + '\0')) continue;
      p.pool.end(() => {});
      pools.delete(k);
    }
  }

  async function poolFor(conn, database) {
    const k = `${conn.id}\0${database || ''}`;
    const signature = JSON.stringify(conn);
    const cached = pools.get(k);
    if (cached && cached.signature === signature) return cached.pool;
    if (cached) { cached.pool.end(() => {}); pools.delete(k); }
    const { options } = await connectionTarget(conn);
    const pool = mysqlCb.createPool({ ...options, database: database || options.database, connectionLimit: 3, waitForConnections: true });
    // Sola lettura anche lato server: una scrittura sfuggita al controllo fallisce comunque
    if (conn.readOnly) pool.on('connection', c => c.query('SET SESSION TRANSACTION READ ONLY'));
    pools.set(k, { pool, signature });
    return pool;
  }

  // Token di conferma legato a connessione, database e testo esatto dell'istruzione
  const confirmToken = (conn, database, sql) =>
    crypto.createHmac('sha256', confirmSecret).update(`${conn.id}\0${database || ''}\0${sql}`).digest('hex');

  // Esegue l'istruzione: le righe arrivano in streaming e oltre il limite si interrompe
  function execute(pool, sql, limit) {
    return new Promise((resolve, reject) => {
      pool.getConnection((err, connection) => {
        if (err) return reject(err);
        const started = Date.now();
        let fields = null, header = null, truncated = false, settled = false;
        const rows = [];
        const finish = (error, destroy) => {
          if (settled) return;
          settled = true;
          if (destroy) connection.destroy(); else connection.release();
          if (error) return reject(error);
          const ms = Date.now() - started;
          if (fields) {
            resolve({
              kind: 'rows', ms, truncated, rowCount: rows.length,
              columns: fields.map(f => ({ name: f.name, table: f.orgTable || null, type: TYPE_NAMES[f.columnType] || String(f.columnType) })),
              rows,
            });
          } else {
            resolve({
              kind: 'result', ms,
              affectedRows: header?.affectedRows ?? 0, changedRows: header?.changedRows ?? null,
              insertId: header?.insertId ?? null, warningStatus: header?.warningStatus ?? 0, info: header?.info || '',
            });
          }
        };
        const q = connection.query({ sql, timeout: QUERY_TIMEOUT_MS, rowsAsArray: true });
        q.on('error', e => finish(e, true));
        q.on('fields', f => { fields = f; });
        q.on('result', r => {
          if (!fields) { header = r; return; }
          if (rows.length >= limit) { truncated = true; finish(null, true); return; } // il resto non serve: si chiude la connessione
          rows.push(r.map(cell));
        });
        q.on('end', () => finish(null, false));
      });
    });
  }

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
        closePools(req.params.id);
        res.json({ ok: true, connection: publicConnection(list[idx]) });
      },

      deleteConnection(req, res) {
        ctx.config.set('dbConnections', connections().filter(c => c.id !== req.params.id));
        closePools(req.params.id);
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

      // Elenco dei database visibili dalla connessione (per il selettore)
      async databases(req, res) {
        const conn = findConnection(req.params.id);
        if (!conn) return res.status(404).json({ error: 'Connessione non trovata' });
        try {
          const r = await execute(await poolFor(conn), 'SHOW DATABASES', MAX_ROW_LIMIT);
          res.json({ databases: r.rows.map(row => row[0]), default: conn.database || null });
        } catch (e) {
          res.status(e.status || 502).json({ error: e.message });
        }
      },

      // Tabelle e viste di un database (letture su information_schema, con parametri)
      async tables(req, res) {
        const conn = findConnection(req.params.id);
        if (!conn) return res.status(404).json({ error: 'Connessione non trovata' });
        if (!DB_NAME_RE.test(req.params.db)) return res.status(400).json({ error: 'Nome database non valido' });
        try {
          const [rows] = await (await poolFor(conn)).promise().query(
            `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS rowsEstimate, TABLE_COMMENT AS comment
               FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [req.params.db]);
          res.json({ tables: rows.map(t => ({ ...t, view: t.type === 'VIEW' })) });
        } catch (e) {
          res.status(e.status || 502).json({ error: e.message });
        }
      },

      // Struttura di una tabella: colonne, indici, chiavi esterne
      async tableInfo(req, res) {
        const conn = findConnection(req.params.id);
        if (!conn) return res.status(404).json({ error: 'Connessione non trovata' });
        const { db, table } = req.params;
        if (!DB_NAME_RE.test(db) || !DB_NAME_RE.test(table)) return res.status(400).json({ error: 'Nome non valido' });
        try {
          const q = (await poolFor(conn)).promise();
          const [[columns], [indexes], [foreignKeys]] = await Promise.all([
            q.query(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE = 'YES' AS nullable, COLUMN_KEY AS \`key\`,
                            COLUMN_DEFAULT AS \`default\`, EXTRA AS extra, COLUMN_COMMENT AS comment
                       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, table]),
            q.query(`SELECT INDEX_NAME AS name, NON_UNIQUE = 0 AS \`unique\`, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
                       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY INDEX_NAME, NON_UNIQUE`, [db, table]),
            q.query(`SELECT CONSTRAINT_NAME AS name, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) AS columns,
                            REFERENCED_TABLE_SCHEMA AS refDatabase, REFERENCED_TABLE_NAME AS refTable,
                            GROUP_CONCAT(REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION) AS refColumns
                       FROM information_schema.KEY_COLUMN_USAGE
                      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
                      GROUP BY CONSTRAINT_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME`, [db, table]),
          ]);
          if (!columns.length) return res.status(404).json({ error: 'Tabella non trovata' });
          const split = list => list.map(x => ({ ...x, columns: String(x.columns).split(','), ...(x.refColumns ? { refColumns: String(x.refColumns).split(',') } : {}) }));
          res.json({
            columns: columns.map(c => ({ ...c, nullable: !!Number(c.nullable) })),
            indexes: split(indexes).map(i => ({ ...i, unique: !!Number(i.unique) })),
            foreignKeys: split(foreignKeys),
          });
        } catch (e) {
          res.status(e.status || 502).json({ error: e.message });
        }
      },

      // Anteprima dei dati di una tabella: pagina, ricerca, filtri, ordinamento.
      // Colonne e operatori sono verificati, i valori passano come parametri.
      async rows(req, res) {
        const conn = findConnection(req.params.id);
        if (!conn) return res.status(404).json({ error: 'Connessione non trovata' });
        const { db, table } = req.params;
        if (!DB_NAME_RE.test(db) || !DB_NAME_RE.test(table)) return res.status(400).json({ error: 'Nome non valido' });
        const pageSize = PAGE_SIZES.includes(Number(req.body.pageSize)) ? Number(req.body.pageSize) : 50;
        const page = Math.max(1, parseInt(req.body.page) || 1);
        try {
          const q = (await poolFor(conn)).promise();
          const [columns] = await q.query(
            `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, DATA_TYPE AS dataType, IS_NULLABLE = 'YES' AS nullable,
                    COLUMN_KEY AS \`key\`, COLUMN_DEFAULT AS \`default\`, EXTRA AS extra
               FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, table]);
          if (!columns.length) return res.status(404).json({ error: 'Tabella non trovata' });
          const names = new Set(columns.map(c => c.name));

          const where = [], params = [];
          const search = typeof req.body.search === 'string' ? req.body.search.trim() : '';
          if (search) {
            where.push('(' + columns.map(c => `CAST(${quoteId(c.name)} AS CHAR) LIKE ?`).join(' OR ') + ')');
            columns.forEach(() => params.push(`%${escapeLike(search)}%`));
          }
          for (const f of Array.isArray(req.body.filters) ? req.body.filters : []) {
            const op = FILTER_OPS[f?.op];
            if (!op || !names.has(f.column)) return res.status(400).json({ error: `Filtro non valido: ${f?.column} ${f?.op}` });
            where.push(`${quoteId(f.column)} ${op.sql}`);
            if (!op.noValue) params.push(op.like ? op.like(escapeLike(f.value ?? '')) : f.value ?? '');
          }
          const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
          let orderSql = '';
          const sort = req.body.sort;
          if (sort?.column) {
            if (!names.has(sort.column)) return res.status(400).json({ error: `Colonna sconosciuta: ${sort.column}` });
            orderSql = ` ORDER BY ${quoteId(sort.column)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'}`;
          }
          const from = `${quoteId(db)}.${quoteId(table)}`;
          const [[{ total }]] = await q.query(`SELECT COUNT(*) AS total FROM ${from}${whereSql}`, params);
          const sql = `SELECT * FROM ${from}${whereSql}${orderSql} LIMIT ? OFFSET ?`;
          const [rows] = await q.query({ sql, rowsAsArray: true }, [...params, pageSize, (page - 1) * pageSize]);
          res.json({
            columns: columns.map(c => ({ ...c, nullable: !!Number(c.nullable) })),
            primaryKey: columns.filter(c => c.key === 'PRI').map(c => c.name),
            rows: rows.map(r => r.map(cell)),
            total: Number(total), page, pageSize, pageSizes: PAGE_SIZES,
          });
        } catch (e) {
          res.status(e.status || 400).json({ error: e.message, code: e.code || null });
        }
      },

      // Inserimento, modifica o eliminazione di una riga. L'istruzione è generata qui
      // (valori escapati da mysql2) e, come ogni modifica, eseguita solo dopo la conferma
      // del testo esatto: la prima risposta è 428 con l'SQL e il token.
      async row(req, res) {
        const conn = findConnection(req.params.id);
        if (!conn) return res.status(404).json({ error: 'Connessione non trovata' });
        const { db, table } = req.params;
        if (!DB_NAME_RE.test(db) || !DB_NAME_RE.test(table)) return res.status(400).json({ error: 'Nome non valido' });
        const { op, key, values, confirm } = req.body;
        if (!['insert', 'update', 'delete'].includes(op)) return res.status(400).json({ error: 'Operazione non valida' });
        if (conn.readOnly) return res.status(403).json({ error: 'Connessione in sola lettura' });
        try {
          const q = (await poolFor(conn, db)).promise();
          const [columns] = await q.query(
            `SELECT COLUMN_NAME AS name, COLUMN_KEY AS \`key\` FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, table]);
          if (!columns.length) return res.status(404).json({ error: 'Tabella non trovata' });
          const names = new Set(columns.map(c => c.name));
          const pk = columns.filter(c => c.key === 'PRI').map(c => c.name);
          const from = `${quoteId(db)}.${quoteId(table)}`;

          const vals = values && typeof values === 'object' ? values : {};
          const unknown = Object.keys(vals).filter(k => !names.has(k));
          if (unknown.length) return res.status(400).json({ error: `Colonne sconosciute: ${unknown.join(', ')}` });
          const scalar = v => v === null || ['string', 'number', 'boolean'].includes(typeof v);
          if (!Object.values(vals).every(scalar)) return res.status(400).json({ error: 'Valori non validi' });

          // WHERE sulla chiave primaria completa (niente modifiche senza)
          let whereSql = '', whereParams = [];
          if (op !== 'insert') {
            if (!pk.length) return res.status(400).json({ error: 'La tabella non ha una chiave primaria: modifica non disponibile' });
            if (!key || typeof key !== 'object' || pk.some(k => !(k in key) || !scalar(key[k]) || key[k] === null)) {
              return res.status(400).json({ error: `Chiave primaria mancante: ${pk.join(', ')}` });
            }
            whereSql = pk.map(k => `${quoteId(k)} = ?`).join(' AND ');
            whereParams = pk.map(k => key[k]);
          }

          let template, params;
          const cols = Object.keys(vals);
          if (op === 'insert') {
            template = cols.length
              ? `INSERT INTO ${from} (${cols.map(quoteId).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
              : `INSERT INTO ${from} () VALUES ()`;
            params = cols.map(c => vals[c]);
          } else if (op === 'update') {
            if (!cols.length) return res.status(400).json({ error: 'Nessun valore da modificare' });
            template = `UPDATE ${from} SET ${cols.map(c => `${quoteId(c)} = ?`).join(', ')} WHERE ${whereSql} LIMIT 1`;
            params = [...cols.map(c => vals[c]), ...whereParams];
          } else {
            template = `DELETE FROM ${from} WHERE ${whereSql} LIMIT 1`;
            params = whereParams;
          }
          const sql = mysqlCb.format(template, params);

          const token = confirmToken(conn, db, sql);
          const given = typeof confirm === 'string' ? Buffer.from(confirm) : Buffer.alloc(0);
          if (given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) {
            return res.status(428).json({ needsConfirmation: true, token, verb: op.toUpperCase(), database: db, sql });
          }
          const result = await execute(await poolFor(conn, db), sql, 1);
          res.json({ ...result, sql });
        } catch (e) {
          res.status(e.status || 400).json({ error: e.message, code: e.code || null });
        }
      },

      // Esegue una istruzione. Le letture partono subito; tutto ciò che può modificare
      // dati o schema richiede il token di conferma di quella esatta istruzione (428).
      async query(req, res) {
        const conn = findConnection(req.params.id);
        if (!conn) return res.status(404).json({ error: 'Connessione non trovata' });
        const { sql, confirm } = req.body;
        const database = req.body.database || conn.database || null;
        if (database && !DB_NAME_RE.test(database)) return res.status(400).json({ error: 'Nome database non valido' });
        const limit = Math.min(Math.max(parseInt(req.body.limit) || DEFAULT_ROW_LIMIT, 1), MAX_ROW_LIMIT);

        const c = classify(sql);
        if (c.kind === 'invalid' || c.kind === 'empty') return res.status(400).json({ error: c.reason });
        if (c.kind === 'write') {
          if (conn.readOnly) return res.status(403).json({ error: `Connessione in sola lettura: ${c.verb || 'istruzione'} non consentito` });
          const token = confirmToken(conn, database, sql);
          const given = typeof confirm === 'string' ? Buffer.from(confirm) : Buffer.alloc(0);
          if (given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) {
            return res.status(428).json({ needsConfirmation: true, token, verb: c.verb, reason: c.reason || null, database, sql });
          }
        }
        try {
          const result = await execute(await poolFor(conn, database), sql, limit);
          res.json({ ...result, statement: c.kind, database, limit });
        } catch (e) {
          res.status(e.status || 400).json({ error: e.message, code: e.code || null });
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

    shutdown() { closePools(); },
  };
};
