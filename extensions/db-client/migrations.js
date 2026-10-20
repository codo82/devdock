// Migration collegate a un repository: cartella dentro il repository, file
// NNN_<tabella>_<operazione>.sql con NNN incrementale (almeno 3 cifre).
// Funzioni pure per nomi e numerazione, più l'accesso controllato alle cartelle.
const fs = require('fs');
const path = require('path');

const FILE_RE = /^(\d+)_([a-z0-9_]+)\.sql$/;          // migration nel formato
const SQL_RE = /\.sql$/i;
const DIR_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/; // niente ".", "..", nascoste
const SLUG_RE = /^[a-z0-9]+(_[a-z0-9]+)*$/;
const MIN_WIDTH = 3;
const SKIP_DIRS = new Set(['node_modules', 'vendor']);

class MigrationError extends Error {
  constructor(key, params = {}) { super(key); this.key = key; this.params = params; }
}

// Cartella relativa al repository: segmenti semplici separati da "/", niente assoluti né ".."
function isValidDir(dir) {
  return typeof dir === 'string' && dir.length <= 255 && (dir === '' || dir.split('/').every(s => DIR_SEGMENT_RE.test(s)));
}

// Percorso assoluto di dir dentro root; null se esce dal repository (anche tramite link)
function resolveInside(root, dir) {
  if (!isValidDir(dir)) return null;
  const target = path.join(root, dir);
  let realRoot, realTarget;
  try { realRoot = fs.realpathSync(root); } catch { return null; }
  try { realTarget = fs.realpathSync(target); } catch { realTarget = path.join(realRoot, dir); } // non esiste ancora
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep) ? target : null;
}

// Sottocartelle visibili (niente nascoste, node_modules, vendor), in ordine alfabetico
function listFolders(root, dir) {
  const abs = resolveInside(root, dir);
  if (!abs) throw new MigrationError('dir_invalid', { dir });
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
  catch { throw new MigrationError('dir_not_found', { dir }); }
  const folders = entries
    .filter(e => e.isDirectory() && DIR_SEGMENT_RE.test(e.name) && !SKIP_DIRS.has(e.name))
    .map(e => e.name).sort((a, b) => a.localeCompare(b));
  const sqlFiles = entries.filter(e => e.isFile() && SQL_RE.test(e.name)).length;
  return { dir, folders, sqlFiles };
}

// Nuova cartella name dentro parent (anche parent deve stare nel repository)
function createFolder(root, parent, name) {
  if (!DIR_SEGMENT_RE.test(name || '')) throw new MigrationError('folder_name_invalid', { name: String(name ?? '') });
  const dir = parent ? `${parent}/${name}` : name;
  const abs = resolveInside(root, dir);
  if (!abs || !resolveInside(root, parent)) throw new MigrationError('dir_invalid', { dir });
  if (fs.existsSync(abs)) throw new MigrationError('folder_exists', { dir });
  fs.mkdirSync(abs);
  return dir;
}

// Numerazione da un elenco di nomi file: migration valide, file ignorati, numero attuale
// e larghezza (le cifre più lunghe trovate, almeno 3)
function scan(names) {
  const files = [], ignored = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (m) files.push({ name, number: Number(m[1]), digits: m[1].length });
    else if (SQL_RE.test(name)) ignored.push(name);
  }
  files.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
  const current = files.reduce((max, f) => Math.max(max, f.number), 0);
  const width = files.reduce((w, f) => Math.max(w, f.digits), MIN_WIDTH);
  // numeri ripetuti (es. due rami che hanno creato lo stesso numero)
  const seen = new Map();
  for (const f of files) seen.set(f.number, (seen.get(f.number) || 0) + 1);
  const duplicates = [...seen].filter(([, n]) => n > 1).map(([num]) => num);
  return { files: files.map(({ name, number }) => ({ name, number })), ignored, current, width, duplicates };
}

const pad = (n, width) => String(n).padStart(Math.max(width, MIN_WIDTH), '0');

// Nome del file: NNN_<tabella>_<operazione>.sql (tabella e operazione come slug)
function slug(text) {
  return String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

function fileName(number, width, table, operation) {
  const t = slug(table), op = slug(operation);
  if (!SLUG_RE.test(t)) throw new MigrationError('table_slug_invalid', { table: String(table ?? '') });
  if (!SLUG_RE.test(op)) throw new MigrationError('operation_slug_invalid', { operation: String(operation ?? '') });
  return `${pad(number, width)}_${t}_${op}.sql`;
}

// Nomi dei file SQL presenti nella cartella (vuoto se non esiste ancora)
function folderFiles(root, dir) {
  const abs = resolveInside(root, dir);
  if (!abs) throw new MigrationError('dir_invalid', { dir });
  try { return fs.readdirSync(abs, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name); }
  catch { return []; }
}

module.exports = {
  FILE_RE, MIN_WIDTH, MigrationError,
  isValidDir, resolveInside, listFolders, createFolder, scan, pad, slug, fileName, folderFiles,
};

// ---- scrittura dei file ----

// Scrittura atomica (file temporaneo + rename): chi legge vede il vecchio o il nuovo contenuto
function writeAtomic(abs, content) {
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, abs);
}

// Nuovo file name nella cartella, mai sovrascritto: il contenuto va in un file temporaneo
// che poi viene collegato con il nome finale (link fallisce se il nome esiste già)
function writeExclusive(dirAbs, name, content) {
  const final = path.join(dirAbs, name);
  const tmp = path.join(dirAbs, `.${name}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, { flag: 'wx' });
  try { fs.linkSync(tmp, final); }
  catch (e) { if (e.code === 'EEXIST') throw new MigrationError('file_exists', { name }); throw e; }
  finally { fs.rmSync(tmp, { force: true }); }
  return final;
}

const SNAPSHOT = '.devdock-schema.json';

// Snapshot dello schema nel repository: chiavi ordinate, così i diff in git restano leggibili
function snapshotContent(database, lastMigration, schema) {
  const tables = Object.fromEntries(Object.keys(schema.tables).sort().map(t => [t, schema.tables[t]]));
  return JSON.stringify({ version: 1, database, lastMigration, tables }, null, 2) + '\n';
}

function readSnapshot(dirAbs) {
  try { return JSON.parse(fs.readFileSync(path.join(dirAbs, SNAPSHOT), 'utf8')); } catch { return null; }
}

// Contenuto del file di migration: intestazione e istruzioni separate da ";"
function migrationContent(name, { connection, database, date = new Date() }, statements) {
  const header = [`-- ${name}`, `-- DevDock · ${connection} · ${database} · ${date.toISOString()}`, ''];
  return header.join('\n') + '\n' + statements.map(s => `${s};`).join('\n\n') + '\n';
}

Object.assign(module.exports, { writeAtomic, writeExclusive, SNAPSHOT, snapshotContent, readSnapshot, migrationContent });
