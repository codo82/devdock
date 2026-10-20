// CREATE TABLE da una definizione strutturata. Nessun SQL arriva dal client:
// tipi, azioni ed engine da elenchi ammessi, identificatori tra backtick, valori
// (default, ENUM, commenti) escapati da mysql2.
const mysql = require('mysql2');

const quoteId = name => '`' + String(name).replace(/`/g, '``') + '`';
const NAME_RE = /^[^\x00]{1,64}$/;
const CHARSET_RE = /^[a-z0-9_]{1,64}$/i;

// tipo → quali parametri accetta
const TYPES = {
  TINYINT: 'int', SMALLINT: 'int', MEDIUMINT: 'int', INT: 'int', BIGINT: 'int',
  DECIMAL: 'decimal', FLOAT: 'float', DOUBLE: 'float',
  CHAR: 'length', VARCHAR: 'length', BINARY: 'length', VARBINARY: 'length',
  TEXT: 'plain', MEDIUMTEXT: 'plain', LONGTEXT: 'plain', TINYTEXT: 'plain',
  BLOB: 'plain', MEDIUMBLOB: 'plain', LONGBLOB: 'plain',
  DATE: 'plain', TIME: 'plain', YEAR: 'plain', DATETIME: 'temporal', TIMESTAMP: 'temporal',
  BOOLEAN: 'plain', JSON: 'plain', ENUM: 'values', SET: 'values',
};
const FK_ACTIONS = new Set(['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION']);
const ENGINES = new Set(['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE']);
const NO_DEFAULT = new Set(['TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'TINYTEXT', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'JSON']);

class DdlError extends Error {}
const fail = msg => { throw new DdlError(msg); };
const int = (v, min, max) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;

function columnSql(c) {
  const where = `colonna "${c?.name}"`;
  if (!c || !NAME_RE.test(c.name || '')) fail('Nome di colonna non valido');
  const type = String(c.type || '').toUpperCase();
  const kind = TYPES[type];
  if (!kind) fail(`${where}: tipo non ammesso (${c.type})`);

  let t = type;
  if (kind === 'length') {
    if (!int(c.length, 1, type.startsWith('VAR') ? 65535 : 255)) fail(`${where}: lunghezza obbligatoria`);
    t += `(${Number(c.length)})`;
  } else if (kind === 'decimal') {
    const p = c.length ?? 10, s = c.scale ?? 0;
    if (!int(p, 1, 65) || !int(s, 0, 30) || Number(s) > Number(p)) fail(`${where}: precisione/scala non valide`);
    t += `(${Number(p)},${Number(s)})`;
  } else if (kind === 'temporal' && c.length != null && c.length !== '') {
    if (!int(c.length, 0, 6)) fail(`${where}: frazioni di secondo da 0 a 6`);
    t += `(${Number(c.length)})`;
  } else if (kind === 'values') {
    if (!Array.isArray(c.values) || !c.values.length) fail(`${where}: elenco di valori obbligatorio`);
    t += `(${c.values.map(v => mysql.escape(String(v))).join(', ')})`;
  }
  if (c.unsigned) {
    if (!['int', 'decimal', 'float'].includes(kind)) fail(`${where}: UNSIGNED solo per i numeri`);
    t += ' UNSIGNED';
  }

  let sql = `${quoteId(c.name)} ${t}${c.nullable ? ' NULL' : ' NOT NULL'}`;
  if (c.autoIncrement) {
    if (kind !== 'int') fail(`${where}: AUTO_INCREMENT solo per i tipi interi`);
    sql += ' AUTO_INCREMENT';
  }
  // default: nessuno | NULL | valore | CURRENT_TIMESTAMP (date/ora)
  const d = c.default;
  if (d && d.kind && d.kind !== 'none') {
    if (NO_DEFAULT.has(type)) fail(`${where}: ${type} non ammette un valore predefinito`);
    if (d.kind === 'null') { if (!c.nullable) fail(`${where}: default NULL su una colonna NOT NULL`); sql += ' DEFAULT NULL'; }
    else if (d.kind === 'current_timestamp') { if (kind !== 'temporal') fail(`${where}: CURRENT_TIMESTAMP solo per DATETIME/TIMESTAMP`); sql += ' DEFAULT CURRENT_TIMESTAMP'; }
    else if (d.kind === 'value') sql += ` DEFAULT ${mysql.escape(String(d.value ?? ''))}`;
    else fail(`${where}: default non valido`);
  }
  if (c.onUpdateCurrentTimestamp) {
    if (kind !== 'temporal') fail(`${where}: ON UPDATE CURRENT_TIMESTAMP solo per DATETIME/TIMESTAMP`);
    sql += ' ON UPDATE CURRENT_TIMESTAMP';
  }
  if (c.comment) sql += ` COMMENT ${mysql.escape(String(c.comment))}`;
  return sql;
}

function createTableSql(db, def) {
  if (!def || !NAME_RE.test(def.name || '')) fail('Nome della tabella obbligatorio');
  const cols = Array.isArray(def.columns) ? def.columns : [];
  if (!cols.length) fail('Serve almeno una colonna');
  const names = cols.map(c => c?.name);
  if (new Set(names).size !== names.length) fail('Nomi di colonna duplicati');
  const has = n => names.includes(n);
  const colList = (list, what) => {
    if (!Array.isArray(list) || !list.length || !list.every(has)) fail(`${what}: colonne non valide`);
    return list.map(quoteId).join(', ');
  };

  const lines = cols.map(columnSql);
  const pk = Array.isArray(def.primaryKey) ? def.primaryKey : [];
  if (pk.length) lines.push(`PRIMARY KEY (${colList(pk, 'chiave primaria')})`);
  const ai = cols.filter(c => c.autoIncrement);
  if (ai.length > 1) fail('Una sola colonna AUTO_INCREMENT');
  if (ai.length && !pk.includes(ai[0].name) && !(def.indexes || []).some(i => i.columns?.[0] === ai[0].name)) {
    fail('La colonna AUTO_INCREMENT deve essere nella chiave primaria o in un indice');
  }
  for (const ix of def.indexes || []) {
    if (ix.name != null && ix.name !== '' && !NAME_RE.test(ix.name)) fail('Nome di indice non valido');
    lines.push(`${ix.unique ? 'UNIQUE ' : ''}KEY ${ix.name ? quoteId(ix.name) + ' ' : ''}(${colList(ix.columns, `indice ${ix.name || ''}`)})`);
  }
  for (const fk of def.foreignKeys || []) {
    if (fk.name != null && fk.name !== '' && !NAME_RE.test(fk.name)) fail('Nome di chiave esterna non valido');
    if (!NAME_RE.test(fk.refTable || '') || !Array.isArray(fk.refColumns) || !fk.refColumns.every(n => NAME_RE.test(n || ''))) fail('Riferimento della chiave esterna non valido');
    if ((fk.refColumns || []).length !== (fk.columns || []).length) fail('Chiave esterna: colonne e colonne riferite devono essere lo stesso numero');
    const refDb = fk.refDatabase ? `${quoteId(fk.refDatabase)}.` : '';
    let sql = `${fk.name ? `CONSTRAINT ${quoteId(fk.name)} ` : ''}FOREIGN KEY (${colList(fk.columns, 'chiave esterna')}) REFERENCES ${refDb}${quoteId(fk.refTable)} (${fk.refColumns.map(quoteId).join(', ')})`;
    for (const [k, label] of [['onDelete', 'ON DELETE'], ['onUpdate', 'ON UPDATE']]) {
      if (!fk[k]) continue;
      const action = String(fk[k]).toUpperCase();
      if (!FK_ACTIONS.has(action)) fail(`Chiave esterna: azione non ammessa (${fk[k]})`);
      sql += ` ${label} ${action}`;
    }
    lines.push(sql);
  }

  let options = '';
  if (def.engine) { if (!ENGINES.has(def.engine)) fail('Engine non ammesso'); options += ` ENGINE=${def.engine}`; }
  if (def.charset) { if (!CHARSET_RE.test(def.charset)) fail('Charset non valido'); options += ` DEFAULT CHARSET=${def.charset}`; }
  if (def.collation) { if (!CHARSET_RE.test(def.collation)) fail('Collation non valida'); options += ` COLLATE=${def.collation}`; }
  if (def.comment) options += ` COMMENT=${mysql.escape(String(def.comment))}`;

  return `CREATE TABLE ${quoteId(db)}.${quoteId(def.name)} (\n  ${lines.join(',\n  ')}\n)${options}`;
}

module.exports = { createTableSql, DdlError, TYPES: Object.keys(TYPES), FK_ACTIONS: [...FK_ACTIONS], ENGINES: [...ENGINES] };
