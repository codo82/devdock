// Porte TCP in ascolto di un process group (lsof su macOS/Linux, ss su Linux)
const { execFileSync } = require('child_process');
const { getTools } = require('./system');

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

module.exports = { getPortsForPgid };
