const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { pick, getProjects, saveProjects } = require('../lib/config');
const { NPM_NAME_RE } = require('../lib/validate');
const { readProjectPackage } = require('../lib/projects');
const {
  activeProcesses, getPortsForPgid, spawnTrackedNpm, startTrackedNpm, killProcessGroup,
} = require('../lib/process');

const router = express.Router();

// Progetti — CRUD
router.get('/projects', (req, res) => {
  res.json(getProjects());
});

router.post('/projects', (req, res) => {
  const { id, label, path: projectPath } = req.body;
  if (!id || !label || !projectPath) return res.status(400).json({ error: 'id, label e path obbligatori' });
  const projects = getProjects();
  if (projects.find(p => p.id === id)) return res.status(409).json({ error: 'ID già esistente' });
  if (!fs.existsSync(projectPath)) return res.status(400).json({ error: `Cartella non trovata: ${projectPath}` });
  projects.push({ id, label, path: projectPath });
  saveProjects(projects);
  res.json({ ok: true });
});

router.put('/projects/:id', (req, res) => {
  const projects = getProjects();
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Progetto non trovato' });
  const { label, path: projectPath } = req.body;
  if (projectPath && !fs.existsSync(projectPath)) return res.status(400).json({ error: `Cartella non trovata: ${projectPath}` });
  projects[idx] = { ...projects[idx], ...pick(req.body, ['label', 'path']) };
  saveProjects(projects);
  res.json({ ok: true });
});

router.delete('/projects/:id', (req, res) => {
  const projects = getProjects().filter(p => p.id !== req.params.id);
  saveProjects(projects);
  res.json({ ok: true });
});

// Legge package.json di un progetto
router.get('/projects/:id/package', (req, res) => {
  const p = getProjects().find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Progetto non trovato' });
  const pkgPath = path.join(p.path, 'package.json');
  if (!fs.existsSync(pkgPath)) return res.json({ name: null, scripts: {}, dependencies: {}, devDependencies: {} });
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    res.json({
      name: pkg.name || null,
      version: pkg.version || null,
      scripts: pkg.scripts || {},
      dependencies: pkg.dependencies || {},
      devDependencies: pkg.devDependencies || {},
    });
  } catch (e) {
    res.status(500).json({ error: 'package.json non valido' });
  }
});

// Versioni installate (legge da node_modules/<pkg>/package.json)
router.post('/projects/:id/installed-versions', (req, res) => {
  const p = getProjects().find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Progetto non trovato' });
  const packages = Array.isArray(req.body.packages) ? req.body.packages : [];
  const result = {};
  for (const name of packages) {
    if (typeof name !== 'string' || !NPM_NAME_RE.test(name)) continue;
    try {
      const pkgFile = path.join(p.path, 'node_modules', name, 'package.json');
      if (fs.existsSync(pkgFile)) {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        result[name] = pkg.version || null;
      } else {
        result[name] = null;
      }
    } catch {
      result[name] = null;
    }
  }
  res.json(result);
});

// npm outdated (eseguito nel cwd del progetto, output JSON)
router.get('/projects/:id/outdated', (req, res) => {
  const p = getProjects().find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Progetto non trovato' });
  try {
    // npm outdated --json esce con codice 1 se ci sono pacchetti obsoleti — ignoriamo il codice
    let out = '';
    try {
      out = execSync('npm outdated --json', { cwd: p.path, encoding: 'utf8', timeout: 30000 });
    } catch (e) {
      out = e.stdout || '{}'; // npm outdated restituisce exit 1 ma stdout è valido
    }
    res.json(JSON.parse(out || '{}'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// PROCESSI NPM TRACCIATI
// ============================================================================

// Lista processi attivi
router.get('/processes', (req, res) => {
  const list = [];
  for (const [id, pd] of activeProcesses) {
    const ports = pd.running ? getPortsForPgid(pd.pid) : [];
    list.push({
      id, projectId: pd.projectId, projectLabel: pd.projectLabel,
      script: pd.script, pid: pd.pid, ports,
      startedAt: pd.startedAt, running: pd.running, exitCode: pd.exitCode,
    });
  }
  res.json(list);
});

// Avvia processo npm tracciato: solo "install" o script definiti in package.json
router.post('/projects/:id/npm/start', (req, res) => {
  const p = getProjects().find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Progetto non trovato' });
  const { script } = req.body;
  if (typeof script !== 'string' || !script) return res.status(400).json({ error: 'script obbligatorio' });

  let args;
  if (script === 'install') {
    args = ['install'];
  } else {
    const scripts = readProjectPackage(p)?.scripts || {};
    if (!Object.hasOwn(scripts, script)) return res.status(400).json({ error: `Script non definito in package.json: ${script}` });
    args = ['run', script];
  }

  const pd = startTrackedNpm(p, script, args);
  res.json({ id: pd.id, pid: pd.pid });
});

// Aggiorna una dipendenza (npm update <pkg>): solo pacchetti dichiarati in package.json
router.post('/projects/:id/npm/update', (req, res) => {
  const p = getProjects().find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Progetto non trovato' });
  const name = req.body.package;
  const pkg = readProjectPackage(p) || {};
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  if (typeof name !== 'string' || !NPM_NAME_RE.test(name) || !Object.hasOwn(declared, name)) {
    return res.status(400).json({ error: `Pacchetto non dichiarato in package.json: ${name}` });
  }
  const pd = startTrackedNpm(p, `update ${name}`, ['update', name]);
  res.json({ id: pd.id, pid: pd.pid });
});

router.delete('/processes/:id', (req, res) => {
  const pd = activeProcesses.get(req.params.id);
  if (!pd) return res.status(404).json({ error: 'Processo non trovato' });
  killProcessGroup(pd);
  pd.running = false;
  activeProcesses.delete(req.params.id);
  res.json({ ok: true });
});

// Rimuove processo terminato dalla lista (pulizia manuale)
router.delete('/processes/:id/dismiss', (req, res) => {
  const pd = activeProcesses.get(req.params.id);
  if (!pd) return res.status(404).json({ error: 'Processo non trovato' });
  if (pd.running) return res.status(409).json({ error: 'Processo ancora in esecuzione' });
  activeProcesses.delete(req.params.id);
  res.json({ ok: true });
});

// Riavvia processo (kill + respawn)
router.post('/processes/:id/restart', (req, res) => {
  const pd = activeProcesses.get(req.params.id);
  if (!pd) return res.status(404).json({ error: 'Processo non trovato' });
  const p = getProjects().find(x => x.id === pd.projectId);
  if (!p) return res.status(400).json({ error: 'Progetto non più disponibile' });

  killProcessGroup(pd);
  spawnTrackedNpm(pd, p.path, '\n--- Riavvio ---\n');
  res.json({ ok: true, pid: pd.pid });
});

// Log SSE di un processo tracciato (streaming live)
router.get('/processes/:id/stream', (req, res) => {
  const pd = activeProcesses.get(req.params.id);
  if (!pd) { res.status(404).end(); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, data })}\n\n`); } catch {} };

  // Prima invia tutti i log accumulati
  if (pd.logs.length) send('history', pd.logs.map(l => l.text).join(''));
  if (!pd.running) { send('exit', `[processo terminato, exit ${pd.exitCode}]`); res.end(); return; }

  // Poi invia i nuovi log ogni 100ms
  let lastSentTs = pd.logs.length ? pd.logs[pd.logs.length - 1].ts : Date.now();
  const interval = setInterval(() => {
    const current = activeProcesses.get(req.params.id);
    if (!current) { clearInterval(interval); send('exit', '[processo rimosso]'); res.end(); return; }
    const newLogs = current.logs.filter(l => l.ts > lastSentTs);
    if (newLogs.length) { send('stdout', newLogs.map(l => l.text).join('')); lastSentTs = newLogs[newLogs.length - 1].ts; }
    if (!current.running) { clearInterval(interval); send('exit', `[exit ${current.exitCode}]`); res.end(); }
  }, 100);

  req.on('close', () => clearInterval(interval));
});

// Log snapshot (ultimi N, per polling leggero)
router.get('/processes/:id/logs', (req, res) => {
  const pd = activeProcesses.get(req.params.id);
  if (!pd) return res.status(404).json({ error: 'Processo non trovato' });
  res.json({ running: pd.running, exitCode: pd.exitCode, logs: pd.logs.slice(-200) });
});

module.exports = router;
