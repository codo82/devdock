const express = require('express');
const { spawn } = require('child_process');
const { getProjects } = require('../lib/config');
const { PM2_TARGET_RE } = require('../lib/validate');
const { readProjectPackage } = require('../lib/projects');

const router = express.Router();

const PM2_ACTIONS = new Set(['start', 'stop', 'restart', 'delete']);

// PM2 — lista processi (json)
router.get('/pm2/list', (req, res) => {
  const proc = spawn('pm2', ['jlist'], { env: { ...process.env } });
  let out = '';
  proc.stdout.on('data', d => out += d.toString());
  proc.stderr.on('data', d => out += d.toString());
  proc.on('close', () => {
    try {
      const list = JSON.parse(out);
      if (res.headersSent) return;
      res.json(list.map(p => ({
        id: p.pm_id, name: p.name, status: p.pm2_env?.status,
        pid: p.pid, cpu: p.monit?.cpu, memory: p.monit?.memory,
        uptime: p.pm2_env?.pm_uptime, restarts: p.pm2_env?.restart_time,
      })));
    } catch {
      if (!res.headersSent) res.json([]);
    }
  });
  proc.on('error', () => { if (!res.headersSent) res.json([]); });
});

// PM2 — azione su processo (start/stop/restart/delete).
// Con projectId + script avvia "npm run <script>" del progetto sotto pm2.
router.post('/pm2/action', (req, res) => {
  const { action, target, projectId, script } = req.body;
  if (!PM2_ACTIONS.has(action)) return res.status(400).json({ error: 'Azione PM2 non supportata' });
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
  // Se pm2 non esiste arrivano sia 'error' sia 'close': si risponde una volta sola
  proc.on('close', code => {
    if (res.headersSent) return;
    if (code === 0) res.json({ ok: true, out });
    else res.status(500).json({ error: err || out || `exit ${code}` });
  });
  proc.on('error', e => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
});

// PM2 — log streaming via SSE
router.get('/pm2/logs', (req, res) => {
  const { name } = req.query;
  if (name != null && !PM2_TARGET_RE.test(name)) return res.status(400).json({ error: 'Processo PM2 non valido' });
  const lines = String(Math.min(Math.max(parseInt(req.query.lines) || 50, 1), 5000));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, data })}\n\n`); };

  const args = name
    ? ['logs', name, '--lines', lines, '--nostream=false']
    : ['logs', '--lines', lines, '--nostream=false'];

  const proc = spawn('pm2', args, { env: { ...process.env } });

  proc.stdout.on('data', d => send('stdout', d.toString()));
  proc.stderr.on('data', d => send('stderr', d.toString()));
  proc.on('close', () => { send('exit', 'Stream terminato'); if (!res.writableEnded) res.end(); });
  proc.on('error', err => { send('error', err.message); if (!res.writableEnded) res.end(); });

  req.on('close', () => { try { proc.kill(); } catch {} });
});

module.exports = router;
