const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../extensions/db-client/sql');

const kind = sql => classify(sql).kind;

test('letture eseguibili senza conferma', () => {
  for (const sql of [
    'SELECT * FROM clienti',
    'select id, nome from clienti where nome = \'DELETE FROM x\' -- update y',
    'SELECT REPLACE(nome, "a", "b"), INSERT(nome, 1, 2, "x") FROM t',
    'SHOW TABLES', 'SHOW CREATE TABLE clienti', 'DESCRIBE clienti', 'DESC clienti',
    'EXPLAIN SELECT 1', 'EXPLAIN DELETE FROM clienti', 'EXPLAIN ANALYZE SELECT * FROM t',
    'WITH x AS (SELECT 1) SELECT * FROM x', 'TABLE clienti', 'VALUES ROW(1, 2)',
    '  /* commento */ SELECT 1 ;  ', 'SELECT `update`, `delete` FROM `insert`',
  ]) assert.equal(kind(sql), 'read', sql);
});

test('scritture e istruzioni sconosciute richiedono conferma', () => {
  for (const sql of [
    'INSERT INTO clienti (nome) VALUES ("x")', 'UPDATE clienti SET nome = "x"', 'DELETE FROM clienti',
    'REPLACE INTO t VALUES (1)', 'CREATE TABLE t (id INT)', 'ALTER TABLE t ADD c INT', 'DROP TABLE t',
    'TRUNCATE t', 'RENAME TABLE a TO b', 'GRANT ALL ON *.* TO x', 'CALL proc()', 'SET @a = 1',
    'LOCK TABLES t WRITE', 'BEGIN', 'COMMIT', 'START TRANSACTION', 'OPTIMIZE TABLE t', 'qualcosa di strano',
    'WITH x AS (SELECT 1) DELETE FROM t', 'SELECT * INTO OUTFILE "/tmp/x" FROM t', 'SELECT 1 INTO @v',
    'SELECT * FROM t FOR UPDATE', 'SELECT * FROM t LOCK IN SHARE MODE', 'EXPLAIN ANALYZE DELETE FROM t',
    '/*!40101 DELETE FROM t */', 'SELECT 1 /*! , (DELETE FROM t) */',
    '-- commento\nDELETE FROM t',
  ]) assert.equal(kind(sql), 'write', sql);
});

test('più istruzioni, USE e testo vuoto vengono rifiutati', () => {
  assert.equal(kind('SELECT 1; DELETE FROM t'), 'invalid');
  assert.equal(kind('SELECT 1;'), 'read');
  assert.equal(kind('SELECT ";"'), 'read');
  assert.equal(kind('USE altro_db'), 'invalid');
  assert.equal(kind('   -- solo commento'), 'empty');
  assert.equal(kind(null), 'invalid');
});
