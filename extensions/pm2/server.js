// PM2: lista dei processi, azioni e log. Ogni chiamata esegue la CLI pm2.
const { spawn } = require('child_process');

const ACTIONS = new Set(['start', 'stop', 'restart', 'delete']);

module.exports = function createPm2(ctx) {
  const { PM2_TARGET_RE } = ctx.lib.validate;
  const npm = ctx.require('npm'); // opzionale: serve solo per avviare gli script dei progetti

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
        if (!ACTIONS.has(action)) throw ctx.error(400, 'action_unsupported', { action: String(action) });
        let args;
        if (action === 'start' && projectId) {
          if (!npm) throw ctx.error(400, 'npm_unavailable');
          const p = npm.getProject(projectId);
          if (!p) throw ctx.error(404, 'project_not_found', { id: String(projectId) });
          const scripts = npm.readPackage(p)?.scripts || {};
          if (typeof script !== 'string' || !Object.hasOwn(scripts, script)) {
            throw ctx.error(400, 'script_not_defined', { script: String(script) });
          }
          args = ['start', 'npm', '--name', `${p.id}-${script}`, '--cwd', p.path, '--', 'run', script];
        } else {
          if (typeof target !== 'string' || !PM2_TARGET_RE.test(target)) throw ctx.error(400, 'invalid_target');
          args = [action, target];
        }
        const proc = spawn('pm2', args, { env: { ...process.env } });
        let out = '', err = '';
        proc.stdout.on('data', d => out += d.toString());
        proc.stderr.on('data', d => err += d.toString());
        proc.on('error', e => { if (!res.headersSent) ctx.error.send(res, 500, 'command_failed', { output: e.message }); });
        proc.on('close', code => {
          if (res.headersSent) return;
          if (code === 0) res.json({ ok: true, out });
          // l'output di pm2 resta com'è (non si traduce)
          else ctx.error.send(res, 500, 'command_failed', { output: (err || out || `exit ${code}`).trim() });
        });
      },

      // Log in streaming (SSE); ?name= per un solo processo, ?lines= righe iniziali
      logs(req, res) {
        const { name } = req.query;
        if (name != null && !PM2_TARGET_RE.test(name)) throw ctx.error(400, 'invalid_target');
        const lines = String(Math.min(Math.max(parseInt(req.query.lines) || 50, 1), 5000));
        const send = ctx.sse(res);
        const args = name ? ['logs', name, '--lines', lines] : ['logs', '--lines', lines];
        const proc = spawn('pm2', args, { env: { ...process.env } });
        proc.stdout.on('data', d => send('stdout', d.toString()));
        proc.stderr.on('data', d => send('stderr', d.toString()));
        proc.on('close', () => { send('exit', null); send.end(); }); // il frontend scrive "stream terminato"
        proc.on('error', e => { send('error', e.message); send.end(); });
        req.on('close', () => { try { proc.kill(); } catch {} });
      },
    },
  };
};
