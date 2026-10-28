// Cartella di Kelbo fuori dal repository (estensioni installate, lock file, backup).
// Fino alla 2.12 era ~/.devdock: al primo avvio diventa ~/.kelbo, con tutto quello che
// contiene, così le estensioni scaricate restano installate, aggiornabili e con la loro
// versione precedente. Mai a metà: un rename sullo stesso disco, altrimenti copia, verifica
// e solo dopo cancellazione della vecchia; a qualsiasi errore si resta su ~/.devdock.
const fs = require('fs');
const os = require('os');
const path = require('path');

const NEW_NAME = '.kelbo';
const OLD_NAME = '.devdock';

// Elenco ricorsivo di file e link con la loro dimensione (per verificare una copia)
function inventory(dir) {
  const out = new Map();
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isSymbolicLink()) out.set(r, `link:${fs.readlinkSync(path.join(dir, r))}`);
      else if (e.isDirectory()) { out.set(r, 'dir'); walk(r); }
      else out.set(r, fs.statSync(path.join(dir, r)).size);
    }
  };
  walk('');
  return out;
}

function sameContent(a, b) {
  const x = inventory(a), y = inventory(b);
  return x.size === y.size && [...x].every(([k, v]) => y.get(k) === v);
}

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// Cartella da usare, senza toccare nulla: KELBO_HOME (o DEVDOCK_HOME), poi ~/.kelbo se c'è,
// ~/.devdock se c'è solo quella (spostamento non riuscito), altrimenti ~/.kelbo
function homeDir({ env = process.env, homedir = os.homedir() } = {}) {
  const explicit = env.KELBO_HOME || env.DEVDOCK_HOME;
  if (explicit) return explicit;
  const next = path.join(homedir, NEW_NAME), old = path.join(homedir, OLD_NAME);
  return isDir(next) || !isDir(old) ? next : old;
}

// Spostamento di ~/.devdock in ~/.kelbo: lo chiamano server e comandi all'avvio, prima di
// leggere la cartella (mai al caricamento di un modulo: i test non devono toccare la home
// vera). → { dir, moved, notice }: notice è il motivo quando si resta sulla vecchia cartella
function migrateHome({ env = process.env, homedir = os.homedir(), log = msg => console.warn(`[kelbo] ${msg}`) } = {}) {
  const explicit = env.KELBO_HOME || env.DEVDOCK_HOME;
  if (explicit) return { dir: explicit, moved: false };
  const next = path.join(homedir, NEW_NAME), old = path.join(homedir, OLD_NAME);
  const exists = isDir;
  if (exists(next)) {
    if (exists(old)) log(`ci sono sia ${next} sia ${old}: si usa ${next} (la vecchia cartella resta com'è)`);
    return { dir: next, moved: false };
  }
  if (!exists(old)) return { dir: next, moved: false };
  try {
    fs.renameSync(old, next);
    log(`cartella spostata: ${old} → ${next}`);
    return { dir: next, moved: true };
  } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM' && e.code !== 'EACCES') return stay(e);
  }
  // dischi diversi (o rename non permesso): copia in una cartella temporanea, verifica, poi scambio
  const tmp = `${next}.tmp-${process.pid}`;
  try {
    fs.cpSync(old, tmp, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    if (!sameContent(old, tmp)) throw new Error('la copia non corrisponde all\'originale');
    fs.renameSync(tmp, next);
    fs.rmSync(old, { recursive: true, force: true });
    log(`cartella copiata: ${old} → ${next}`);
    return { dir: next, moved: true };
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* niente da togliere */ }
    return stay(e);
  }

  function stay(e) {
    log(`impossibile spostare ${old} in ${next} (${e.message}): si continua con ${old}`);
    return { dir: old, moved: false, notice: e.message };
  }
}

module.exports = { homeDir, migrateHome, NEW_NAME, OLD_NAME };
