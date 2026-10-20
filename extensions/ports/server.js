// Porte in uso: porte TCP in ascolto con il processo, collegate a ciò che DevDock
// conosce (script npm, PM2, tunnel), e arresto del processo che occupa una porta.
const os = require('os');
const { execFile } = require('child_process');

module.exports = function createPorts(ctx) {
  const npm = ctx.require('npm');
  const pm2 = ctx.require('pm2');
  const tunnels = ctx.require('tunnels');
  const me = os.userInfo().username;
  const { listListeningPorts } = ctx.lib.ports;

  // Chi ha avviato il processo, se è DevDock (npm usa process group, ssh/autossh e PM2 il pid o il padre)
  function ownerOf(p, known) {
    if (p.pid === process.pid) return { type: 'devdock' };
    const npmProc = known.npm.find(x => x.pid === p.pgid || x.pid === p.pid);
    if (npmProc) return { type: 'npm', id: npmProc.id, label: `${npmProc.project} — ${npmProc.script}` };
    const pm2Proc = known.pm2.find(x => x.pid === p.pid || x.pid === p.ppid);
    if (pm2Proc) return { type: 'pm2', id: pm2Proc.name, label: pm2Proc.name };
    const tunnel = known.tunnels.find(x => x.pid === p.pid || x.pid === p.ppid);
    if (tunnel) return { type: 'tunnel', id: tunnel.id, label: `${tunnel.label} :${tunnel.port}` };
    return null;
  }

  async function ports() {
    const known = {
      npm: npm ? npm.processes() : [],
      pm2: pm2 ? await pm2.processes() : [],
      tunnels: tunnels ? tunnels.activeTunnels() : [],
    };
    return listListeningPorts().map(p => ({
      port: p.port, addresses: p.addresses, pid: p.pid, name: p.name, user: p.user, command: p.command,
      own: process.platform === 'win32' ? true : p.user === me, // si fermano solo i processi dell'utente
      owner: ownerOf(p, known),
    }));
  }

  const kill = (pid, force) => new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), ...(force ? ['/F'] : [])], err => (err ? reject(err) : resolve()));
    } else {
      try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); resolve(); } catch (e) { reject(e); }
    }
  });

  return {
    handlers: {
      async list(req, res) {
        res.json({ ports: await ports(), platform: process.platform });
      },

      // Ferma il processo { port, pid } se è ancora in ascolto su quella porta. I processi
      // avviati da DevDock passano dalla loro estensione, così il suo stato resta coerente.
      async stop(req, res) {
        const port = Number(req.body.port), pid = Number(req.body.pid);
        const entry = (await ports()).find(p => p.port === port && p.pid === pid);
        if (!entry) throw ctx.error(404, 'not_listening', { port: String(port), pid: String(pid) });
        if (entry.owner?.type === 'devdock') throw ctx.error(400, 'self');
        if (!entry.own) throw ctx.error(403, 'not_owner', { user: entry.user || '?' });
        const via = entry.owner?.type || 'signal';
        let ok = true;
        if (via === 'npm') ok = npm.stopProcess(entry.owner.id);
        else if (via === 'pm2') ok = await pm2.stop(entry.owner.id);
        else if (via === 'tunnel') ok = tunnels.stopTunnel(entry.owner.id);
        else {
          try { await kill(pid, req.body.force === true); }
          catch (e) { throw ctx.error(e.code === 'EPERM' ? 403 : 500, 'kill_failed', { error: e.message }); }
        }
        if (!ok) throw ctx.error(500, 'stop_failed', { via });
        res.json({ ok: true, via });
      },
    },

    mcp: {
      async list({ port } = {}) {
        const all = await ports();
        const list = port ? all.filter(p => p.port === Number(port)) : all;
        return { ports: list.map(({ own, ...p }) => p) };
      },
    },
  };
};
