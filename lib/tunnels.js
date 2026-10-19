// Tunnel SSH (ssh -L o autossh) con riconnessione automatica
const { spawn } = require('child_process');

const activeTunnels = new Map(); // id → { serverKey, label, port, remote, alias, type, pid, process, logs, stopping, reconnectDelay, reconnectTimer }

// Parametri reconnect
const RECONNECT_INITIAL_DELAY = 5000;   // 5s primo tentativo
const RECONNECT_MAX_DELAY     = 60000;  // max 60s tra un tentativo e l'altro
const RECONNECT_BACKOFF       = 1.5;    // moltiplicatore backoff

function spawnTunnel(id, sshArgs, useAuto) {
  const td = activeTunnels.get(id);
  if (!td || td.stopping) return;

  const proc = useAuto
    ? spawn('autossh', ['-M', '0', ...sshArgs])
    : spawn('ssh', sshArgs);

  td.process = proc;
  td.pid     = proc.pid;

  const log = text => {
    td.logs.push({ ts: Date.now(), text });
    if (td.logs.length > 200) td.logs.splice(0, td.logs.length - 200);
  };

  const mode = useAuto ? 'autossh' : 'ssh';
  log(`Connessione a ${td.alias} → 127.0.0.1:${td.port} ↔ ${td.remote} [${mode}, pid ${proc.pid}]`);

  proc.stdout.on('data', d => log(d.toString()));
  proc.stderr.on('data', d => log(d.toString()));

  proc.on('error', err => log(`Errore spawn: ${err.message}`));

  proc.on('close', code => {
    if (!activeTunnels.has(id)) return; // già rimosso manualmente
    const t = activeTunnels.get(id);
    if (t.stopping) { activeTunnels.delete(id); return; }

    const delay = Math.min(t.reconnectDelay, RECONNECT_MAX_DELAY);
    log(`Tunnel chiuso (exit ${code}). Riconnessione tra ${Math.round(delay/1000)}s...`);
    t.reconnectDelay = Math.round(delay * RECONNECT_BACKOFF);
    t.reconnectTimer = setTimeout(() => {
      if (!activeTunnels.has(id) || activeTunnels.get(id).stopping) return;
      activeTunnels.get(id).reconnectTimer = null;
      spawnTunnel(id, sshArgs, useAuto);
    }, delay);
  });
}

function stopTunnel(t) {
  t.stopping = true;
  if (t.reconnectTimer) clearTimeout(t.reconnectTimer);
  try { t.process && t.process.kill('SIGTERM'); } catch {}
}

function stopAllTunnels() {
  for (const [, t] of activeTunnels) stopTunnel(t);
  activeTunnels.clear();
}

module.exports = { activeTunnels, spawnTunnel, stopTunnel, stopAllTunnels, RECONNECT_INITIAL_DELAY };
