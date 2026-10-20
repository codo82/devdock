// Classificazione delle istruzioni SQL (MySQL) prima di eseguirle.
// Solo le letture riconosciute possono partire senza conferma: tutto il resto,
// istruzioni sconosciute comprese, è trattato come scrittura.

const READ_START = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'TABLE', 'VALUES', 'HELP']);
const WRITE_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME',
  'GRANT', 'REVOKE', 'LOAD', 'CALL', 'DO', 'HANDLER', 'IMPORT', 'INSTALL', 'UNINSTALL',
  'LOCK', 'UNLOCK', 'SET', 'KILL', 'SHUTDOWN', 'FLUSH', 'RESET', 'PURGE', 'OPTIMIZE', 'REPAIR', 'ANALYZE',
]);

// Sostituisce stringhe, identificatori quotati e commenti con spazi (stessa lunghezza
// non serve): restano solo parole chiave, nomi e simboli. I commenti eseguibili
// /*! ... */ di MySQL vengono mantenuti, perché il server li esegue.
function mask(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === '\\' && q !== '`') { i += 2; continue; }
        if (sql[i] === q) { if (sql[i + 1] === q) { i += 2; continue; } break; }
        i++;
      }
      i++;
      out += q === '`' ? ' `ident` ' : " 'str' ";
    } else if (c === '-' && n === '-' && /\s/.test(sql[i + 2] ?? ' ') || c === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && n === '*') {
      if (sql[i + 2] === '!') {          // /*!50000 ... */ → contenuto eseguito
        i += 3;
        while (/\d/.test(sql[i] ?? '')) i++;
        out += ' ';
        continue;
      }
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
    } else if (c === '*' && n === '/') { // chiusura di un /*! ... */
      i += 2;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// { kind: 'read' | 'write' | 'empty' | 'invalid', verb, reason?, word? }
// reason è un codice (tradotto dalla UI): missing, empty, single_statement, use_unsupported,
// explain_analyze_write, into, row_lock, write_word (con word = la parola trovata)
function classify(sql) {
  if (typeof sql !== 'string') return { kind: 'invalid', reason: 'missing' };
  const masked = mask(sql).trim().replace(/;\s*$/, '');
  if (!masked) return { kind: 'empty', reason: 'empty' };
  if (masked.includes(';')) return { kind: 'invalid', reason: 'single_statement' };

  const words = masked.toUpperCase().match(/[A-Z_][A-Z0-9_$]*/g) || [];
  const verb = words[0] || '';
  const has = w => words.includes(w);
  const write = (reason, word) => ({ kind: 'write', verb, ...(reason ? { reason } : {}), ...(word ? { word } : {}) });

  if (verb === 'USE') return { kind: 'invalid', verb, reason: 'use_unsupported' };
  if (!READ_START.has(verb)) return write();
  if (verb === 'SHOW' || verb === 'HELP') return { kind: 'read', verb }; // SHOW CREATE TABLE ecc. sono letture

  // EXPLAIN senza ANALYZE non esegue l'istruzione; con ANALYZE la esegue
  if (verb === 'EXPLAIN' || verb === 'DESCRIBE' || verb === 'DESC') {
    if (!has('ANALYZE')) return { kind: 'read', verb };
    return [...WRITE_WORDS].some(w => w !== 'ANALYZE' && has(w)) ? write('explain_analyze_write') : { kind: 'read', verb };
  }
  // SELECT ... INTO (variabili o file) e i lock in lettura non sono letture pure
  if (has('INTO')) return write('into');
  if (/\bFOR\s+(UPDATE|SHARE)\b|\bLOCK\s+IN\s+SHARE\s+MODE\b/i.test(masked)) return write('row_lock');
  // Una CTE può precedere UPDATE/DELETE; in generale nessuna parola di scrittura in una lettura
  // (REPLACE(...) e INSERT(...) seguiti da parentesi sono funzioni di stringa, non istruzioni)
  const writeWord = [...masked.toUpperCase().matchAll(/\b([A-Z_][A-Z0-9_$]*)\b(\s*\()?/g)]
    .filter(m => !m[2]).map(m => m[1])
    .find(w => WRITE_WORDS.has(w) && !['SET', 'DO', 'ANALYZE', 'LOCK', 'RESET', 'LOAD', 'CALL', 'HANDLER', 'KILL'].includes(w));
  if (writeWord) return write('write_word', writeWord);
  return { kind: 'read', verb };
}

module.exports = { classify, mask };
