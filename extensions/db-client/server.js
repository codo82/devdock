// Database: connessioni MySQL/MariaDB (sezione "dbConnections"), password cifrate
// con una master password (sezione "vault"), query con timeout e limite di righe.
const crypto = require('crypto');
const mysqlCb = require('mysql2');
const mysql = require('mysql2/promise');
const vaultLib = require('./vault');
const { classify } = require('./sql');
const ddl = require('./ddl');

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
// Formati di export
const EXPORT_FORMATS = {
  csv:  { type: 'text/csv; charset=utf-8' },
  json: { type: 'application/json; charset=utf-8' },
  sql:  { type: 'application/sql; charset=utf-8' },
};
// CSV RFC 4180: virgolette se servono; la stringa vuota è "" (il campo vuoto è NULL)
const csvField = v => {
  const str = String(v);
  return str === '' || /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};
// Binari in esadecimale nei file (senza troncamento), il resto invariato
const exportValue = v => Buffer.isBuffer(v) ? `0x${v.toString('hex')}` : v;
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
  const { pick } = ctx.lib.config;
  const { ApiError, errorBody } = ctx.lib.errors;
  const { KEY_RE, isPort, isText } = ctx.lib.validate;
  const tunnels = ctx.require('tunnels'); // opzionale: senza, niente connessioni via tunnel

  const vault = () => ctx.config.get('vault');
  let allowVaultSwitch = false; // vero solo durante il cambio della master password
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
    if (!key) throw ctx.error(423, 'vault_locked');
    return vaultLib.decrypt(key, conn.password);
  }

  // ---- connessioni ----

  function validateConnection(c) {
    if (!c || typeof c !== 'object') throw ctx.error.config('connection_invalid');
    const bad = field => ctx.error.config(`connection_${field}`, { id: String(c.id ?? '') });
    if (!KEY_RE.test(c.id || '')) throw bad('id');
    if (!isText(c.label)) throw bad('label');
    if ((c.type ?? 'mysql') !== 'mysql') throw bad('type');
    if (c.tunnel != null) {
      if (!KEY_RE.test(c.tunnel)) throw bad('tunnel');
    } else {
      if (!HOST_RE.test(c.host || '')) throw bad('host');
      if (!isPort(c.port)) throw bad('port');
    }
    if (c.database != null && c.database !== '' && !DB_NAME_RE.test(c.database)) throw bad('database');
    if (!isText(c.user, 80)) throw bad('user');
    if (c.password != null && !vaultLib.isBox(c.password)) throw bad('password');
    if (c.projectId != null && !KEY_RE.test(c.projectId)) throw bad('project');
    if (c.readOnly != null && typeof c.readOnly !== 'boolean') throw bad('read_only');
  }

  // Ciò che vede il frontend: mai la password, solo se c'è
  const publicConnection = c => ({ ...pick(c, CONNECTION_FIELDS.filter(f => f !== 'password')), hasPassword: !!c.password });

  // Risposta di errore: gli errori con codice (anche di altre estensioni, es. tunnel non
  // pronto) passano com'erano; quelli di MySQL o di sistema diventano db-client.mysql
  // con il messaggio originale (non tradotto) e il codice MySQL in params.mysqlCode
  function sendFailure(res, e, status = 400, extra = {}) {
    if (e instanceof ApiError) return res.status(e.status).json({ ...errorBody(e), ...extra });
    if (e?.key) e = ctx.error(400, e.key, e.params); // vault.js
    else e = ctx.error(e?.status || status, 'mysql', { error: e?.message || String(e), ...(e?.code ? { mysqlCode: e.code } : {}) });
    return res.status(e.status).json({ ...errorBody(e), ...extra });
  }
  const connectionOr404 = id => {
    const conn = findConnection(id);
    if (!conn) throw ctx.error(404, 'connection_not_found', { id: String(id) });
    return conn;
  };

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
      if (!tunnels) throw ctx.error(400, 'tunnels_unavailable');
      if (!tunnels.getServer(c.tunnel)) throw ctx.error(400, 'tunnel_unknown', { tunnel: String(c.tunnel) });
      delete c.host; delete c.port; // host e porta vengono dal tunnel
    }
    if (typeof body.password === 'string' && body.password !== '') {
      const key = currentKey();
      if (!key) throw ctx.error(423, 'vault_locked');
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
      if (!tunnels) throw ctx.error(400, 'tunnels_unavailable');
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

  // Parti comuni di anteprima ed export di una tabella: colonne verificate, WHERE con
  // parametri (ricerca su tutte le colonne + filtri), ORDER BY su una colonna esistente
  async function tableQuery(q, db, table, { search, filters, sort } = {}) {
    if (!DB_NAME_RE.test(db || '') || !DB_NAME_RE.test(table || '')) throw ctx.error(400, 'name_invalid');
    const [cols] = await q.query(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, DATA_TYPE AS dataType, IS_NULLABLE = 'YES' AS nullable,
              COLUMN_KEY AS \`key\`, COLUMN_DEFAULT AS \`default\`, EXTRA AS extra
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, table]);
    if (!cols.length) throw ctx.error(404, 'table_not_found', { table });
    const columns = cols.map(c => ({ ...c, nullable: !!Number(c.nullable) }));
    const names = new Set(columns.map(c => c.name));
    const where = [], params = [];
    const text = typeof search === 'string' ? search.trim() : '';
    if (text) {
      where.push('(' + columns.map(c => `CAST(${quoteId(c.name)} AS CHAR) LIKE ?`).join(' OR ') + ')');
      columns.forEach(() => params.push(`%${escapeLike(text)}%`));
    }
    for (const f of Array.isArray(filters) ? filters : []) {
      const op = FILTER_OPS[f?.op];
      if (!op || !names.has(f.column)) throw ctx.error(400, 'filter_invalid', { column: String(f?.column), op: String(f?.op) });
      where.push(`${quoteId(f.column)} ${op.sql}`);
      if (!op.noValue) params.push(op.like ? op.like(escapeLike(f.value ?? '')) : f.value ?? '');
    }
    let orderSql = '';
    if (sort?.column) {
      if (!names.has(sort.column)) throw ctx.error(400, 'column_unknown', { columns: String(sort.column) });
      orderSql = ` ORDER BY ${quoteId(sort.column)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'}`;
    }
    return { columns, from: `${quoteId(db)}.${quoteId(table)}`, whereSql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params, orderSql };
  }

  // ---- export ----

  const pendingExports = new Map(); // id → { connId, format, spec, filename, expires }

  // Scrive su res rispettando il backpressure (attende 'drain' se il buffer è pieno)
  const writeOut = (res, text) => res.write(text) ? null : new Promise(r => res.once('drain', r));

  function streamExport(pool, job, res) {
    return new Promise((resolve, reject) => {
      pool.getConnection(async (err, connection) => {
        if (err) return reject(err);
        const { format, spec } = job;
        let header = '';
        if (spec.withCreate) {
          try {
            const [[row]] = await connection.promise().query(`SHOW CREATE TABLE ${quoteId(spec.db)}.${quoteId(spec.table)}`);
            header = `-- Structure\nDROP TABLE IF EXISTS ${quoteId(spec.table)};\n${row['Create Table']};\n\n`;
          } catch (e) { connection.release(); return reject(e); }
        }
        res.setHeader('Content-Type', EXPORT_FORMATS[format].type);
        res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);
        res.write(format === 'sql' ? `-- Export DevDock ${new Date().toISOString()}\n${header}` : '');

        let fields = null, count = 0, batch = [];
        const flushSql = () => {
          if (!batch.length) return null;
          const cols = fields.map(f => quoteId(f.name)).join(', ');
          const text = `INSERT INTO ${quoteId(spec.table)} (${cols}) VALUES\n${batch.join(',\n')};\n`;
          batch = [];
          return writeOut(res, text);
        };
        const q = connection.query({ sql: spec.sql, values: spec.params, rowsAsArray: true });
        const stream = q.stream({ highWaterMark: 100 });
        stream.on('fields', f => {
          fields = f;
          if (format === 'csv') res.write(f.map(x => csvField(x.name)).join(',') + '\r\n');
          if (format === 'json') res.write('[');
        });
        stream.on('data', async row => {
          const values = format === 'sql' ? row : row.map(exportValue); // in SQL i binari diventano X'..' con escape()
          let wait = null;
          if (format === 'csv') wait = writeOut(res, values.map(v => v === null ? '' : csvField(v)).join(',') + '\r\n');
          else if (format === 'json') wait = writeOut(res, (count ? ',\n' : '\n') + JSON.stringify(Object.fromEntries(fields.map((f, i) => [f.name, values[i]]))));
          else { batch.push('(' + values.map(v => mysqlCb.escape(v)).join(', ') + ')'); if (batch.length >= 100) wait = flushSql(); }
          count++;
          if (wait) { stream.pause(); await wait; stream.resume(); }
        });
        stream.on('error', e => { connection.destroy(); res.destroy(e); reject(e); });
        stream.on('end', async () => {
          if (format === 'json') res.write(count ? '\n]\n' : ']\n');
          if (format === 'sql') { await flushSql(); res.write(`-- ${count} rows\n`); }
          connection.release();
          res.end();
          resolve(count);
        });
        res.on('close', () => { if (!res.writableEnded) { connection.destroy(); } }); // download interrotto
      });
    });
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
      // Import in modalità unione: lo stesso vault (stesso verificatore) o nessuno attuale
      merge(current, incoming) {
        if (current && incoming && current.verifier !== incoming.verifier) {
          throw ctx.error.config('vault_other_password');
        }
        return current ?? incoming;
      },
      validate(record) {
        try { vaultLib.validateRecord(record); } catch (e) { throw ctx.error.config(e.key || 'vault_record_invalid'); }
        // Un'altra master password renderebbe illeggibili le password salvate: si cambia
        // solo con /vault/change (che ri-cifra tutto) o si importa con /connections/import
        const current = vault();
        if (current && record && current.verifier !== record.verifier && !allowVaultSwitch) {
          throw ctx.error.config('vault_other_password');
        }
        if (record && record.lockAfterMinutes != null
            && !(Number.isInteger(record.lockAfterMinutes) && record.lockAfterMinutes >= 1 && record.lockAfterMinutes <= 1440)) {
          throw ctx.error.config('vault_lock_minutes');
        }
      },
    },
    dbConnections: {
      empty: [], idField: 'id',
      normalize: v => (Array.isArray(v) ? v.map(c => pick(c || {}, CONNECTION_FIELDS)) : v),
      validate(list, cfg) {
        if (!Array.isArray(list)) throw ctx.error.config('not_a_list', { section: 'dbConnections' });
        const seen = new Set();
        for (const c of list) {
          validateConnection(c);
          if (seen.has(c.id)) throw ctx.error.config('duplicate_connection', { id: c.id });
          seen.add(c.id);
          if (c.password != null && !cfg.vault) throw ctx.error.config('password_without_vault', { id: c.id });
        }
      },
    },
  };


  return {
    config,

    handlers: {
      info(req, res) {
        res.json({
          driver: 'mysql2', version: require('mysql2/package.json').version, ready: typeof mysql.createPool === 'function',
          ddl: { types: ddl.TYPES, fkActions: ddl.FK_ACTIONS, engines: ddl.ENGINES },
        });
      },

      // ---- connessioni ----

      listConnections(req, res) {
        res.json({ connections: connections().map(publicConnection), tunnelsAvailable: !!tunnels });
      },

      createConnection(req, res) {
        if (findConnection(req.body.id)) throw ctx.error(409, 'id_exists', { id: String(req.body.id) });
        const c = buildConnection(req.body);
        ctx.config.set('dbConnections', [...connections(), c]);
        res.json({ ok: true, connection: publicConnection(c) });
      },

      updateConnection(req, res) {
        const list = connections();
        const idx = list.findIndex(c => c.id === req.params.id);
        if (idx === -1) throw ctx.error(404, 'connection_not_found', { id: req.params.id });
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
        const conn = connectionOr404(req.params.id);
        let db;
        try {
          const { options, via } = await connectionTarget(conn);
          const started = Date.now();
          db = await mysql.createConnection(options);
          const [[row]] = await db.query('SELECT VERSION() AS version, CURRENT_USER() AS user, DATABASE() AS db');
          res.json({ ok: true, ...row, via, ms: Date.now() - started });
        } catch (e) {
          sendFailure(res, e, 502);
        } finally {
          db?.end().catch(() => {});
        }
      },

      // Elenco dei database visibili dalla connessione (per il selettore)
      async databases(req, res) {
        const conn = connectionOr404(req.params.id);
        try {
          const r = await execute(await poolFor(conn), 'SHOW DATABASES', MAX_ROW_LIMIT);
          res.json({ databases: r.rows.map(row => row[0]), default: conn.database || null });
        } catch (e) {
          sendFailure(res, e, 502);
        }
      },

      // Tabelle e viste di un database (letture su information_schema, con parametri)
      async tables(req, res) {
        const conn = connectionOr404(req.params.id);
        if (!DB_NAME_RE.test(req.params.db)) throw ctx.error(400, 'database_invalid');
        try {
          const [rows] = await (await poolFor(conn)).promise().query(
            `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS rowsEstimate, TABLE_COMMENT AS comment
               FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [req.params.db]);
          res.json({ tables: rows.map(t => ({ ...t, view: t.type === 'VIEW' })) });
        } catch (e) {
          sendFailure(res, e, 502);
        }
      },

      // Struttura di una tabella: colonne, indici, chiavi esterne
      async tableInfo(req, res) {
        const conn = connectionOr404(req.params.id);
        const { db, table } = req.params;
        if (!DB_NAME_RE.test(db) || !DB_NAME_RE.test(table)) throw ctx.error(400, 'name_invalid');
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
          if (!columns.length) throw ctx.error(404, 'table_not_found', { table });
          const split = list => list.map(x => ({ ...x, columns: String(x.columns).split(','), ...(x.refColumns ? { refColumns: String(x.refColumns).split(',') } : {}) }));
          res.json({
            columns: columns.map(c => ({ ...c, nullable: !!Number(c.nullable) })),
            indexes: split(indexes).map(i => ({ ...i, unique: !!Number(i.unique) })),
            foreignKeys: split(foreignKeys),
          });
        } catch (e) {
          sendFailure(res, e, 502);
        }
      },

      // Anteprima dei dati di una tabella: pagina, ricerca, filtri, ordinamento.
      // Colonne e operatori sono verificati, i valori passano come parametri.
      async rows(req, res) {
        const conn = connectionOr404(req.params.id);
        const { db, table } = req.params;
        const pageSize = PAGE_SIZES.includes(Number(req.body.pageSize)) ? Number(req.body.pageSize) : 50;
        const page = Math.max(1, parseInt(req.body.page) || 1);
        try {
          const q = (await poolFor(conn)).promise();
          const t = await tableQuery(q, db, table, req.body);
          const [[{ total }]] = await q.query(`SELECT COUNT(*) AS total FROM ${t.from}${t.whereSql}`, t.params);
          const [rows] = await q.query({ sql: `SELECT * FROM ${t.from}${t.whereSql}${t.orderSql} LIMIT ? OFFSET ?`, rowsAsArray: true },
            [...t.params, pageSize, (page - 1) * pageSize]);
          res.json({
            columns: t.columns,
            primaryKey: t.columns.filter(c => c.key === 'PRI').map(c => c.name),
            rows: rows.map(r => r.map(cell)),
            total: Number(total), page, pageSize, pageSizes: PAGE_SIZES,
          });
        } catch (e) {
          sendFailure(res, e);
        }
      },

      // Export (passo 1): valida sorgente e formato e restituisce un id usa e getta
      async createExport(req, res) {
        const conn = connectionOr404(req.params.id);
        const { format, source } = req.body;
        if (!EXPORT_FORMATS[format]) throw ctx.error(400, 'format_invalid');
        try {
          let spec, name;
          if (source?.type === 'table') {
            const q = (await poolFor(conn)).promise();
            const t = await tableQuery(q, source.db, source.table, source);
            spec = { sql: `SELECT * FROM ${t.from}${t.whereSql}${t.orderSql}`, params: t.params, database: null,
                     table: source.table, db: source.db, withCreate: format === 'sql' && source.withCreate !== false };
            name = source.table;
          } else if (source?.type === 'query') {
            const c = classify(source.sql);
            if (c.kind !== 'read') throw ctx.error(400, 'export_read_only');
            const database = source.database || conn.database || null;
            if (database && !DB_NAME_RE.test(database)) throw ctx.error(400, 'database_invalid');
            spec = { sql: source.sql, params: [], database, table: 'result', db: null, withCreate: false };
            name = 'query';
          } else {
            throw ctx.error(400, 'source_invalid');
          }
          const id = crypto.randomUUID();
          const filename = `${String(name).replace(/[^A-Za-z0-9_.-]+/g, '_')}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${format}`;
          pendingExports.set(id, { connId: conn.id, format, spec, filename, expires: Date.now() + 60000 });
          res.json({ id, filename });
        } catch (e) {
          sendFailure(res, e);
        }
      },

      // Export (passo 2): il file viene generato riga per riga dal flusso di MySQL
      async downloadExport(req, res) {
        const job = pendingExports.get(req.params.exportId);
        pendingExports.delete(req.params.exportId);
        if (!job || job.expires < Date.now()) throw ctx.error(404, 'export_expired');
        const conn = connectionOr404(job.connId);
        try {
          const pool = await poolFor(conn, job.spec.database);
          await streamExport(pool, job, res);
        } catch (e) {
          if (!res.headersSent) sendFailure(res, e);
          else res.destroy(e);
        }
      },

      // Inserimento, modifica o eliminazione di una riga. L'istruzione è generata qui
      // (valori escapati da mysql2) e, come ogni modifica, eseguita solo dopo la conferma
      // del testo esatto: la prima risposta è 428 con l'SQL e il token.
      async row(req, res) {
        const conn = connectionOr404(req.params.id);
        const { db, table } = req.params;
        if (!DB_NAME_RE.test(db) || !DB_NAME_RE.test(table)) throw ctx.error(400, 'name_invalid');
        const { op, key, keys, values, confirm } = req.body;
        if (!['insert', 'update', 'delete', 'delete-many'].includes(op)) throw ctx.error(400, 'operation_invalid');
        if (conn.readOnly) throw ctx.error(403, 'read_only');
        try {
          const q = (await poolFor(conn, db)).promise();
          const [columns] = await q.query(
            `SELECT COLUMN_NAME AS name, COLUMN_KEY AS \`key\` FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, table]);
          if (!columns.length) throw ctx.error(404, 'table_not_found', { table });
          const names = new Set(columns.map(c => c.name));
          const pk = columns.filter(c => c.key === 'PRI').map(c => c.name);
          const from = `${quoteId(db)}.${quoteId(table)}`;

          const vals = values && typeof values === 'object' ? values : {};
          const unknown = Object.keys(vals).filter(k => !names.has(k));
          if (unknown.length) throw ctx.error(400, 'column_unknown', { columns: unknown.join(', ') });
          const scalar = v => v === null || ['string', 'number', 'boolean'].includes(typeof v);
          if (!Object.values(vals).every(scalar)) throw ctx.error(400, 'values_invalid');

          // WHERE sulla chiave primaria completa (niente modifiche senza)
          let whereSql = '', whereParams = [];
          if (op === 'delete-many') {
            if (!pk.length) throw ctx.error(400, 'no_primary_key');
            if (!Array.isArray(keys) || !keys.length || keys.length > 1000) throw ctx.error(400, 'rows_range');
            const valid = k => k && typeof k === 'object' && pk.every(c => c in k && scalar(k[c]) && k[c] !== null);
            if (!keys.every(valid)) throw ctx.error(400, 'primary_key_missing', { columns: pk.join(', ') });
            const tuple = pk.length > 1 ? `(${pk.map(quoteId).join(', ')})` : quoteId(pk[0]);
            const one = pk.length > 1 ? `(${pk.map(() => '?').join(', ')})` : '?';
            whereSql = `${tuple} IN (${keys.map(() => one).join(', ')})`;
            whereParams = keys.flatMap(k => pk.map(c => k[c]));
          } else if (op !== 'insert') {
            if (!pk.length) throw ctx.error(400, 'no_primary_key');
            if (!key || typeof key !== 'object' || pk.some(k => !(k in key) || !scalar(key[k]) || key[k] === null)) {
              throw ctx.error(400, 'primary_key_missing', { columns: pk.join(', ') });
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
            if (!cols.length) throw ctx.error(400, 'nothing_to_update');
            template = `UPDATE ${from} SET ${cols.map(c => `${quoteId(c)} = ?`).join(', ')} WHERE ${whereSql} LIMIT 1`;
            params = [...cols.map(c => vals[c]), ...whereParams];
          } else if (op === 'delete-many') {
            template = `DELETE FROM ${from} WHERE ${whereSql} LIMIT ${keys.length}`;
            params = whereParams;
          } else {
            template = `DELETE FROM ${from} WHERE ${whereSql} LIMIT 1`;
            params = whereParams;
          }
          const sql = mysqlCb.format(template, params);

          const token = confirmToken(conn, db, sql);
          const given = typeof confirm === 'string' ? Buffer.from(confirm) : Buffer.alloc(0);
          if (given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) {
            return res.status(428).json({ needsConfirmation: true, token, verb: op === 'delete-many' ? 'DELETE' : op.toUpperCase(), database: db, sql });
          }
          const result = await execute(await poolFor(conn, db), sql, 1);
          res.json({ ...result, sql });
        } catch (e) {
          sendFailure(res, e);
        }
      },

      // Creazione di una tabella da una definizione strutturata: il CREATE TABLE è
      // generato qui e, come ogni modifica, eseguito solo dopo la conferma del testo esatto
      // (la risposta 428 fa anche da anteprima per il designer)
      async createTable(req, res) {
        const conn = connectionOr404(req.params.id);
        const { db } = req.params;
        if (!DB_NAME_RE.test(db)) throw ctx.error(400, 'database_invalid');
        if (conn.readOnly) throw ctx.error(403, 'read_only');
        let sql;
        try { sql = ddl.createTableSql(db, req.body.definition); }
        catch (e) { if (e instanceof ddl.DdlError) throw ctx.error(400, `ddl_${e.key}`, e.params); throw e; }
        const token = confirmToken(conn, db, sql);
        const given = typeof req.body.confirm === 'string' ? Buffer.from(req.body.confirm) : Buffer.alloc(0);
        if (given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) {
          return res.status(428).json({ needsConfirmation: true, token, verb: 'CREATE', database: db, sql });
        }
        try {
          const result = await execute(await poolFor(conn, db), sql, 1);
          res.json({ ...result, sql });
        } catch (e) {
          sendFailure(res, e, 400, { sql });
        }
      },

      // Esegue una istruzione. Le letture partono subito; tutto ciò che può modificare
      // dati o schema richiede il token di conferma di quella esatta istruzione (428).
      async query(req, res) {
        const conn = connectionOr404(req.params.id);
        const { sql, confirm } = req.body;
        const database = req.body.database || conn.database || null;
        if (database && !DB_NAME_RE.test(database)) throw ctx.error(400, 'database_invalid');
        const limit = Math.min(Math.max(parseInt(req.body.limit) || DEFAULT_ROW_LIMIT, 1), MAX_ROW_LIMIT);

        const c = classify(sql);
        if (c.kind === 'invalid' || c.kind === 'empty') throw ctx.error(400, `sql_${c.reason}`);
        if (c.kind === 'write') {
          if (conn.readOnly) throw ctx.error(403, 'read_only_statement', { verb: c.verb || '?' });
          const token = confirmToken(conn, database, sql);
          const given = typeof confirm === 'string' ? Buffer.from(confirm) : Buffer.alloc(0);
          if (given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) {
            return res.status(428).json({ needsConfirmation: true, token, verb: c.verb, reason: c.reason || null, word: c.word || null, database, sql });
          }
        }
        try {
          const result = await execute(await poolFor(conn, database), sql, limit);
          res.json({ ...result, statement: c.kind, database, limit });
        } catch (e) {
          sendFailure(res, e);
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
        if (vault()) throw ctx.error(409, 'vault_exists');
        let created;
        try { created = await vaultLib.createVault(req.body.password); }
        catch (e) { return sendFailure(res, e); }
        ctx.config.set('vault', created.record);
        session.key = created.encKey;
        session.lastUse = Date.now();
        res.json({ ok: true, state: 'unlocked' });
      },

      async vaultUnlock(req, res) {
        const record = vault();
        if (!record) throw ctx.error(409, 'vault_missing');
        const wait = Math.ceil((throttle.retryAt - Date.now()) / 1000);
        if (wait > 0) {
          res.setHeader('Retry-After', String(wait));
          throw ctx.error(429, 'too_many_attempts', { seconds: wait });
        }
        const key = await vaultLib.openVault(record, req.body.password);
        if (!key) {
          registerFailure();
          throw ctx.error(401, 'wrong_password');
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
        if (!record) throw ctx.error(409, 'vault_missing');
        const oldKey = await vaultLib.openVault(record, req.body.oldPassword);
        if (!oldKey) { registerFailure(); throw ctx.error(401, 'wrong_current_password'); }
        let created;
        try { created = await vaultLib.createVault(req.body.newPassword); }
        catch (e) { return sendFailure(res, e); }
        const reencrypted = connections().map(c => c.password
          ? { ...c, password: vaultLib.encrypt(created.encKey, vaultLib.decrypt(oldKey, c.password)) }
          : c);
        const lockAfterMinutes = record.lockAfterMinutes;
        allowVaultSwitch = true;
        try {
          ctx.config.update({
            vault: lockAfterMinutes ? { ...created.record, lockAfterMinutes } : created.record,
            dbConnections: reencrypted,
          });
        } finally { allowVaultSwitch = false; }
        session.key = created.encKey;
        session.lastUse = Date.now();
        res.json({ ok: true, reencrypted: reencrypted.filter(c => c.password).length });
      },

      // Connessioni da un file esportato altrove: le password vengono decifrate con la
      // master password di quel file e ri-cifrate con la chiave attuale (vault sbloccato)
      async importConnections(req, res) {
        const key = currentKey();
        if (!key) throw ctx.error(423, 'vault_locked');
        const { config: file, password, mode } = req.body;
        if (mode !== 'merge' && mode !== 'replace') throw ctx.error(400, 'mode_invalid');
        const incoming = file?.dbConnections;
        if (!Array.isArray(incoming)) throw ctx.error(400, 'file_no_connections');
        const withPassword = incoming.filter(c => c?.password);
        let fileKey = null;
        if (withPassword.length) {
          try { vaultLib.validateRecord(file.vault); } catch { throw ctx.error(400, 'file_no_vault'); }
          if (!file.vault) throw ctx.error(400, 'file_no_vault');
          fileKey = await vaultLib.openVault(file.vault, password);
          if (!fileKey) { registerFailure(); throw ctx.error(401, 'wrong_file_password'); }
        }
        let converted;
        try {
          converted = incoming.map(c => {
            const conn = pick(c || {}, CONNECTION_FIELDS);
            conn.password = c?.password ? vaultLib.encrypt(key, vaultLib.decrypt(fileKey, c.password)) : null;
            return conn;
          });
        } catch { throw ctx.error(400, 'file_passwords_unreadable'); }
        const current = connections();
        const ids = new Set(current.map(c => c.id));
        const next = mode === 'replace' ? converted : [...current, ...converted.filter(c => !ids.has(c.id))];
        ctx.config.set('dbConnections', next); // valida tutte le connessioni
        closePools();
        res.json({ ok: true, imported: mode === 'replace' ? converted.length : next.length - current.length, skipped: mode === 'replace' ? 0 : converted.filter(c => ids.has(c.id)).length });
      },

      // Password dimenticata: si cancellano vault e password salvate (le connessioni restano)
      vaultReset(req, res) {
        if (req.body.confirm !== 'RESET') throw ctx.error(400, 'confirm_missing');
        const cleared = connections().map(c => ({ ...c, password: null }));
        ctx.config.update({ dbConnections: cleared, vault: null });
        lock();
        res.json({ ok: true, state: 'uninitialized' });
      },

      vaultSettings(req, res) {
        const record = vault();
        if (!record) throw ctx.error(409, 'vault_missing');
        const minutes = Number(req.body.lockAfterMinutes);
        ctx.config.set('vault', { ...record, lockAfterMinutes: minutes });
        res.json({ ok: true, lockAfterMinutes: minutes });
      },
    },

    services: { decryptPassword },

    shutdown() { closePools(); },
  };
};
