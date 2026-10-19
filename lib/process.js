// Processi npm tracciati (process group dedicato) e rilevamento delle porte
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const { getTools } = require('./system');

const activeProcesses = new Map(); // id → { id, projectId, projectLabel, script, pid, process, startedAt, logs[], running, exitCode }

function procLog(pd, text) {
  pd.logs.push({ ts: Date.now(), text });
  if (pd.logs.length > 500) pd.logs.splice(0, pd.logs.length - 500);
}

// Esegue un comando senza shell; restituisce stdout ('' se fallisce o esce con codice ≠ 0)
function runQuiet(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch (e) {
    return e.stdout || '';
  }
}

// Porte TCP in LISTEN dei PID dati — lsof (macOS/Linux) con fallback a ss (Linux)
function getListeningPorts(pids) {
  const ports = new Set();
  if (getTools().lsof) {
    // -F n: una riga per socket nel formato "n<indirizzo>:<porta>", es. "n*:3000", "n[::1]:5173"
    const out = runQuiet('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(','), '-Fn']);
    for (const line of out.split('\n')) {
      const m = line.match(/^n.*:(\d+)$/);
      if (m && Number(m[1]) > 0) ports.add(Number(m[1]));
    }
  } else if (getTools().ss) {
    // formato: "LISTEN 0 511 0.0.0.0:3000 ... users:(("node",pid=1234,fd=20))"
    const pidSet = new Set(pids.map(String));
    for (const line of runQuiet('ss', ['-tlnpH']).split('\n')) {
      const owners = [...line.matchAll(/pid=(\d+),/g)].map(m => m[1]);
      if (!owners.some(p => pidSet.has(p))) continue;
      const m = line.match(/:(\d+)\s/);
      if (m && Number(m[1]) > 0) ports.add(Number(m[1]));
    }
  }
  return [...ports].sort((a, b) => a - b);
}

// Trova le porte usate da un process group (pgid → tutti i PID → socket in LISTEN)
function getPortsForPgid(rootPid) {
  if (process.platform === 'win32') return []; // process group POSIX non disponibili
  // PGID del processo root (di solito coincide col PID dato che usiamo detached)
  const pgid = parseInt(runQuiet('ps', ['-o', 'pgid=', '-p', String(rootPid)]).trim());
  if (!pgid) return [];

  // Tutti i PID nel process group
  const allPids = runQuiet('pgrep', ['-g', String(pgid)]).trim().split(/\s+/).filter(Boolean).map(Number);
  if (!allPids.length) return [];

  return getListeningPorts(allPids);
}

// Avvia (o riavvia) npm con pd.args nel process group di pd. Gli eventi di un
// processo sostituito da un riavvio vengono ignorati: altrimenti la sua chiusura
// segnerebbe come terminato il processo nuovo.
function spawnTrackedNpm(pd, cwd, header = '') {
  const proc = spawn('npm', pd.args, { cwd, env: { ...process.env }, detached: true });
  pd.process = proc; pd.pid = proc.pid;
  pd.startedAt = new Date().toISOString();
  pd.running = true; pd.exitCode = null;
  procLog(pd, `${header}$ npm ${pd.args.join(' ')} (pid ${proc.pid})\n`);
  const current = () => pd.process === proc;
  proc.stdout.on('data', d => procLog(pd, d.toString()));
  proc.stderr.on('data', d => procLog(pd, d.toString()));
  proc.on('close', code => {
    if (!current()) return;
    pd.running = false; pd.exitCode = code;
    procLog(pd, `\n[exit ${code}]`);
  });
  proc.on('error', err => { if (current()) { pd.running = false; procLog(pd, `\nErrore: ${err.message}`); } });
}

function startTrackedNpm(p, script, args) {
  const pd = {
    id: crypto.randomUUID(), projectId: p.id, projectLabel: p.label,
    script, args, pid: null, process: null,
    startedAt: null, logs: [], running: false, exitCode: null,
  };
  activeProcesses.set(pd.id, pd);
  spawnTrackedNpm(pd, p.path);
  return pd;
}

// Ferma processo (killa l'intero process group per liberare la porta)
function killProcessGroup(pd) {
  try {
    if (pd.process && pd.pid) {
      process.kill(-pd.pid, 'SIGTERM');
    }
  } catch {
    // fallback se il process group non esiste più
    try { pd.process && pd.process.kill('SIGTERM'); } catch {}
  }
}

function stopAllProcesses() {
  for (const [, pd] of activeProcesses) killProcessGroup(pd);
}

module.exports = {
  activeProcesses, procLog, getPortsForPgid,
  spawnTrackedNpm, startTrackedNpm, killProcessGroup, stopAllProcesses,
};
