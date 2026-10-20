// Porte TCP in ascolto: di un process group (lsof su macOS/Linux, ss su Linux) e di tutta
// la macchina (anche netstat su Windows)
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

// ---- tutte le porte in ascolto della macchina ----

// Dettagli dei processi (Unix): pid → { ppid, pgid, user, command }
function processInfo(pids) {
  const info = new Map();
  if (!pids.length || process.platform === 'win32') return info;
  const out = runQuiet('ps', ['-o', 'pid=,ppid=,pgid=,user=,command=', '-p', pids.join(',')]);
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) info.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]), user: m[4], command: m[5] });
  }
  return info;
}

// "*:3000", "127.0.0.1:5432", "[::1]:5173" → { address, port }
function splitAddress(text) {
  const m = String(text).match(/^(.*):(\d+)$/);
  return m ? { address: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) } : null;
}

// Socket TCP in LISTEN: [{ port, address, pid, name }]
function listeningSockets() {
  const out = [];
  if (process.platform === 'win32') {
    // "  TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    1234"
    const names = new Map();
    for (const line of runQuiet('tasklist', ['/FO', 'CSV', '/NH']).split('\n')) {
      const m = line.match(/^"([^"]*)","(\d+)"/);
      if (m) names.set(Number(m[2]), m[1]);
    }
    for (const line of runQuiet('netstat', ['-ano', '-p', 'tcp']).split('\n')) {
      const m = line.trim().match(/^TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      const a = m && splitAddress(m[1]);
      if (a) out.push({ ...a, pid: Number(m[2]), name: names.get(Number(m[2])) || null });
    }
  } else if (getTools().lsof) {
    // -F pcn: righe "p<pid>", "c<comando>", "n<indirizzo>:<porta>" per ogni socket
    let pid = null, name = null;
    for (const line of runQuiet('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']).split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1));
      else if (line[0] === 'c') name = line.slice(1);
      else if (line[0] === 'n') { const a = splitAddress(line.slice(1)); if (a) out.push({ ...a, pid, name }); }
    }
  } else if (getTools().ss) {
    for (const line of runQuiet('ss', ['-tlnpH']).split('\n')) {
      const cols = line.trim().split(/\s+/);
      const a = cols[3] && splitAddress(cols[3]);
      const owner = line.match(/\(\("([^"]+)",pid=(\d+)/);
      if (a) out.push({ ...a, pid: owner ? Number(owner[2]) : null, name: owner ? owner[1] : null });
    }
  }
  return out;
}

// Porte in ascolto con il processo: [{ port, addresses, pid, name, user, command, ppid, pgid }]
// (IPv4 e IPv6 dello stesso processo sulla stessa porta diventano una voce)
function listListeningPorts() {
  const byKey = new Map();
  for (const s of listeningSockets()) {
    const k = `${s.port}:${s.pid}`;
    if (!byKey.has(k)) byKey.set(k, { port: s.port, addresses: [], pid: s.pid, name: s.name });
    const e = byKey.get(k);
    if (!e.addresses.includes(s.address)) e.addresses.push(s.address);
  }
  const list = [...byKey.values()];
  const info = processInfo([...new Set(list.map(e => e.pid).filter(Boolean))]);
  for (const e of list) Object.assign(e, { user: null, command: null, ppid: null, pgid: null }, info.get(e.pid) || {});
  return list.sort((a, b) => a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0));
}

module.exports = { getPortsForPgid, listListeningPorts, processInfo };
