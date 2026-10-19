// PM2: lista dei processi, azioni e log. Ogni chiamata esegue la CLI pm2.
const { spawn } = require('child_process');

const ACTIONS = new Set(['start', 'stop', 'restart', 'delete']);

module.exports = function createPm2(ctx) {
  const { PM2_TARGET_RE } = ctx.lib.validate;
  const { getProjects } = ctx.lib.config;
  const { readProjectPackage } = ctx.lib.projects;

  return {
    handlers: {
      // Lista processi (pm2 jlist); vuota se pm2 non è installato
      list(req, res) {
        const proc = spawn('pm2', ['jlist'], { env: { ...process.env } });
        let out = '';
        proc.stdout.on('data', d => out += d.toString());
        // Se pm2 non esiste arrivano sia 'error' sia 'close': si risponde una volta sola
        proc.on('error', () => { if (!res.headersSent) res.json([]); });
        proc.on('close', () => {
          if (res.headersSent) return;
          try {
            res.json(JSON.parse(out).map(p => ({
              id: p.pm_id, name: p.name, status: p.pm2_env?.status,
              pid: p.pid, cpu: p.monit?.cpu, memory: p.monit?.memory,
              uptime: p.pm2_env?.pm_uptime, restarts: p.pm2_env?.restart_time,
            })));
          } catch {
            res.json([]);
          }
        });
      },

      // start/stop/restart/delete su un processo; con projectId + script avvia
      // "npm run <script>" del progetto sotto pm2
      action(req, res) {
        const { action, target, projectId, script } = req.body;
        if (!ACTIONS.has(action)) return res.status(400).json({ error: 'Azione PM2 non supportata' });
        let args;
        if (action === 'start' && projectId) {
          const p = getProjects().find(x => x.id === projectId);
          if (!p) return res.status(404).json({ error: 'Progetto non trovato' });
          const scripts = readProjectPackage(p)?.scripts || {};
          if (typeof script !== 'string' || !Object.hasOwn(scripts, script)) {
            return res.status(400).json({ error: `Script non definito in package.json: ${script}` });
          }
          args = ['start', 'npm', '--name', `${p.id}-${script}`, '--cwd', p.path, '--', 'run', script];
        } else {
          if (typeof target !== 'string' || !PM2_TARGET_RE.test(target)) return res.status(400).json({ error: 'Processo PM2 non valido' });
          args = [action, target];
        }
        const proc = spawn('pm2', args, { env: { ...process.env } });
        let out = '', err = '';
        proc.stdout.on('data', d => out += d.toString());
        proc.stderr.on('data', d => err += d.toString());
        proc.on('error', e => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
        proc.on('close', code => {
          if (res.headersSent) return;
          if (code === 0) res.json({ ok: true, out });
          else res.status(500).json({ error: err || out || `exit ${code}` });
        });
      },

      // Log in streaming (SSE); ?name= per un solo processo, ?lines= righe iniziali
      logs(req, res) {
        const { name } = req.query;
        if (name != null && !PM2_TARGET_RE.test(name)) return res.status(400).json({ error: 'Processo PM2 non valido' });
        const lines = String(Math.min(Math.max(parseInt(req.query.lines) || 50, 1), 5000));
        const send = ctx.sse(res);
        const args = name ? ['logs', name, '--lines', lines] : ['logs', '--lines', lines];
        const proc = spawn('pm2', args, { env: { ...process.env } });
        proc.stdout.on('data', d => send('stdout', d.toString()));
        proc.stderr.on('data', d => send('stderr', d.toString()));
        proc.on('close', () => { send('exit', 'Stream terminato'); send.end(); });
        proc.on('error', e => { send('error', e.message); send.end(); });
        req.on('close', () => { try { proc.kill(); } catch {} });
      },
    },
  };
};
