// NPM: progetti (sezione "projects" di config.json), script di package.json
// eseguiti come processi tracciati in un process group dedicato, dipendenze.
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_FIELDS = ['id', 'label', 'path'];
const MAX_LOG_LINES = 500;

module.exports = function createNpm(ctx) {
  const { ConfigError, pick } = ctx.lib.config;
  const { KEY_RE, NPM_NAME_RE, isText } = ctx.lib.validate;
  const { getPortsForPgid } = ctx.lib.ports;

  const processes = new Map(); // id → { id, projectId, projectLabel, script, args, pid, process, startedAt, logs[], running, exitCode }

  // ---- progetti ----

  const getProjects = () => ctx.config.get('projects');
  const getProject = id => getProjects().find(p => p.id === id) || null;
  const saveProjects = list => ctx.config.set('projects', list);

  // package.json del progetto (null se assente o non valido)
  function readPackage(p) {
    try { return JSON.parse(fs.readFileSync(path.join(p.path, 'package.json'), 'utf8')); } catch { return null; }
  }

  function validateProject(p) {
    const where = `progetto "${p?.id}"`;
    if (!p || typeof p !== 'object') throw new ConfigError('Progetto non valido');
    if (!KEY_RE.test(p.id || '')) throw new ConfigError(`${where}: id non valido (lettere, numeri, _ e -)`);
    if (!isText(p.label)) throw new ConfigError(`${where}: nome obbligatorio`);
    if (!isText(p.path, 1024) || !path.isAbsolute(p.path)) throw new ConfigError(`${where}: il percorso deve essere assoluto`);
  }

  const config = {
    projects: {
      empty: [], idField: 'id',
      normalize: v => (Array.isArray(v) ? v.map(p => pick(p || {}, PROJECT_FIELDS)) : v),
      validate(list) {
        if (!Array.isArray(list)) throw new ConfigError('Config non valida: "projects" deve essere una lista');
        list.forEach(validateProject);
        const seen = new Set();
        for (const p of list) {
          if (seen.has(p.id)) throw new ConfigError(`Progetto duplicato: ${p.id}`);
          seen.add(p.id);
        }
      },
    },
  };

  // ---- processi tracciati ----

  function log(pd, text) {
    pd.logs.push({ ts: Date.now(), text });
    if (pd.logs.length > MAX_LOG_LINES) pd.logs.splice(0, pd.logs.length - MAX_LOG_LINES);
  }

  // Avvia (o riavvia) npm con pd.args in un process group dedicato. Gli eventi di un
  // processo sostituito da un riavvio vengono ignorati: altrimenti la sua chiusura
  // segnerebbe come terminato il processo nuovo.
  function spawnNpm(pd, cwd, header = '') {
    const proc = spawn('npm', pd.args, { cwd, env: { ...process.env }, detached: true });
    pd.process = proc; pd.pid = proc.pid;
    pd.startedAt = new Date().toISOString();
    pd.running = true; pd.exitCode = null;
    log(pd, `${header}$ npm ${pd.args.join(' ')} (pid ${proc.pid})\n`);
    const current = () => pd.process === proc;
    proc.stdout.on('data', d => log(pd, d.toString()));
    proc.stderr.on('data', d => log(pd, d.toString()));
    proc.on('close', code => {
      if (!current()) return;
      pd.running = false; pd.exitCode = code;
      log(pd, `\n[exit ${code}]`);
    });
    proc.on('error', err => { if (current()) { pd.running = false; log(pd, `\nErrore: ${err.message}`); } });
  }

  function startNpm(p, script, args) {
    const pd = {
      id: crypto.randomUUID(), projectId: p.id, projectLabel: p.label,
      script, args, pid: null, process: null,
      startedAt: null, logs: [], running: false, exitCode: null,
    };
    processes.set(pd.id, pd);
    spawnNpm(pd, p.path);
    return pd;
  }

  // Ferma l'intero process group (anche i figli che tengono occupata la porta)
  function killGroup(pd) {
    try {
      if (pd.process && pd.pid) process.kill(-pd.pid, 'SIGTERM');
    } catch {
      try { pd.process && pd.process.kill('SIGTERM'); } catch {}
    }
  }

  const notFound = (res, what) => res.status(404).json({ error: `${what} non trovato` });
  const projectOr404 = (req, res) => getProject(req.params.id) || (notFound(res, 'Progetto'), null);

  return {
    config,
    services: { getProjects, getProject, readPackage },

    handlers: {
      listProjects(req, res) {
        res.json(getProjects());
      },

      createProject(req, res) {
        const { id, label, path: projectPath } = req.body;
        if (!id || !label || !projectPath) return res.status(400).json({ error: 'id, label e path obbligatori' });
        const list = getProjects();
        if (list.some(p => p.id === id)) return res.status(409).json({ error: 'ID già esistente' });
        if (!fs.existsSync(projectPath)) return res.status(400).json({ error: `Cartella non trovata: ${projectPath}` });
        saveProjects([...list, { id, label, path: projectPath }]);
        res.json({ ok: true });
      },

      updateProject(req, res) {
        const list = getProjects();
        const idx = list.findIndex(p => p.id === req.params.id);
        if (idx === -1) return notFound(res, 'Progetto');
        const { path: projectPath } = req.body;
        if (projectPath && !fs.existsSync(projectPath)) return res.status(400).json({ error: `Cartella non trovata: ${projectPath}` });
        list[idx] = { ...list[idx], ...pick(req.body, ['label', 'path']) };
        saveProjects(list);
        res.json({ ok: true });
      },

      deleteProject(req, res) {
        saveProjects(getProjects().filter(p => p.id !== req.params.id));
        res.json({ ok: true });
      },

      packageInfo(req, res) {
        const p = projectOr404(req, res);
        if (!p) return;
        if (!fs.existsSync(path.join(p.path, 'package.json'))) {
          return res.json({ name: null, scripts: {}, dependencies: {}, devDependencies: {} });
        }
        const pkg = readPackage(p);
        if (!pkg) return res.status(500).json({ error: 'package.json non valido' });
        res.json({
          name: pkg.name || null,
          version: pkg.version || null,
          scripts: pkg.scripts || {},
          dependencies: pkg.dependencies || {},
          devDependencies: pkg.devDependencies || {},
        });
      },

      // Versioni installate (da node_modules/<pkg>/package.json); nomi non validi ignorati
      installedVersions(req, res) {
        const p = projectOr404(req, res);
        if (!p) return;
        const names = Array.isArray(req.body.packages) ? req.body.packages : [];
        const result = {};
        for (const name of names) {
          if (typeof name !== 'string' || !NPM_NAME_RE.test(name)) continue;
          try {
            result[name] = JSON.parse(fs.readFileSync(path.join(p.path, 'node_modules', name, 'package.json'), 'utf8')).version || null;
          } catch {
            result[name] = null;
          }
        }
        res.json(result);
      },

      // npm outdated --json esce con codice 1 se ci sono aggiornamenti: l'output resta valido
      outdated(req, res) {
        const p = projectOr404(req, res);
        if (!p) return;
        let out;
        try {
          out = execFileSync('npm', ['outdated', '--json'], { cwd: p.path, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (e) {
          out = e.stdout || '{}';
        }
        try { res.json(JSON.parse(out || '{}')); }
        catch { res.status(500).json({ error: 'Risposta di npm outdated non valida' }); }
      },

      // Solo "install" o script definiti in package.json
      runScript(req, res) {
        const p = projectOr404(req, res);
        if (!p) return;
        const { script } = req.body;
        if (typeof script !== 'string' || !script) return res.status(400).json({ error: 'script obbligatorio' });
        let args;
        if (script === 'install') {
          args = ['install'];
        } else {
          const scripts = readPackage(p)?.scripts || {};
          if (!Object.hasOwn(scripts, script)) return res.status(400).json({ error: `Script non definito in package.json: ${script}` });
          args = ['run', script];
        }
        const pd = startNpm(p, script, args);
        res.json({ id: pd.id, pid: pd.pid });
      },

      // npm update <pkg>: solo pacchetti dichiarati in package.json
      updatePackage(req, res) {
        const p = projectOr404(req, res);
        if (!p) return;
        const name = req.body.package;
        const pkg = readPackage(p) || {};
        const declared = { ...pkg.dependencies, ...pkg.devDependencies };
        if (typeof name !== 'string' || !NPM_NAME_RE.test(name) || !Object.hasOwn(declared, name)) {
          return res.status(400).json({ error: `Pacchetto non dichiarato in package.json: ${name}` });
        }
        const pd = startNpm(p, `update ${name}`, ['update', name]);
        res.json({ id: pd.id, pid: pd.pid });
      },

      listProcesses(req, res) {
        res.json([...processes.values()].map(pd => ({
          id: pd.id, projectId: pd.projectId, projectLabel: pd.projectLabel,
          script: pd.script, pid: pd.pid, ports: pd.running ? getPortsForPgid(pd.pid) : [],
          startedAt: pd.startedAt, running: pd.running, exitCode: pd.exitCode,
        })));
      },

      stopProcess(req, res) {
        const pd = processes.get(req.params.id);
        if (!pd) return notFound(res, 'Processo');
        killGroup(pd);
        pd.running = false;
        processes.delete(pd.id);
        res.json({ ok: true });
      },

      restartProcess(req, res) {
        const pd = processes.get(req.params.id);
        if (!pd) return notFound(res, 'Processo');
        const p = getProject(pd.projectId);
        if (!p) return res.status(400).json({ error: 'Progetto non più disponibile' });
        killGroup(pd);
        spawnNpm(pd, p.path, '\n--- Riavvio ---\n');
        res.json({ ok: true, pid: pd.pid });
      },

      // Toglie dalla lista un processo già terminato
      dismissProcess(req, res) {
        const pd = processes.get(req.params.id);
        if (!pd) return notFound(res, 'Processo');
        if (pd.running) return res.status(409).json({ error: 'Processo ancora in esecuzione' });
        processes.delete(pd.id);
        res.json({ ok: true });
      },

      processLogs(req, res) {
        const pd = processes.get(req.params.id);
        if (!pd) return notFound(res, 'Processo');
        res.json({ running: pd.running, exitCode: pd.exitCode, logs: pd.logs.slice(-200) });
      },

      // Log in streaming: prima lo storico, poi le righe nuove ogni 100ms
      processStream(req, res) {
        const pd = processes.get(req.params.id);
        if (!pd) return notFound(res, 'Processo');
        const send = ctx.sse(res);
        if (pd.logs.length) send('history', pd.logs.map(l => l.text).join(''));
        if (!pd.running) { send('exit', `[processo terminato, exit ${pd.exitCode}]`); send.end(); return; }

        let lastTs = pd.logs.length ? pd.logs[pd.logs.length - 1].ts : Date.now();
        const timer = setInterval(() => {
          const cur = processes.get(pd.id);
          if (!cur) { clearInterval(timer); send('exit', '[processo rimosso]'); send.end(); return; }
          const fresh = cur.logs.filter(l => l.ts > lastTs);
          if (fresh.length) { send('stdout', fresh.map(l => l.text).join('')); lastTs = fresh[fresh.length - 1].ts; }
          if (!cur.running) { clearInterval(timer); send('exit', `[exit ${cur.exitCode}]`); send.end(); }
        }, 100);
        req.on('close', () => clearInterval(timer));
      },
    },

    // Export/import dichiarati in setting.json → transfer
    transfer: {
      // Una cartella per riga (righe vuote e "#" ignorate): ogni cartella esistente
      // non ancora presente diventa un progetto con id e nome dal nome della cartella
      importFolders(content) {
        const list = getProjects();
        const ids = new Set(list.map(p => p.id));
        const paths = new Set(list.map(p => p.path));
        const added = [], skipped = [];
        for (const raw of content.split(/\r?\n/)) {
          const dir = raw.trim();
          if (!dir || dir.startsWith('#')) continue;
          if (!path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { skipped.push(`${dir} (cartella non trovata)`); continue; }
          if (paths.has(dir)) { skipped.push(`${dir} (già presente)`); continue; }
          const base = path.basename(dir).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'progetto';
          let id = base;
          for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
          const label = readPackage({ path: dir })?.name || path.basename(dir);
          list.push({ id, label: String(label).slice(0, 200), path: dir });
          ids.add(id); paths.add(dir); added.push(id);
        }
        if (added.length) saveProjects(list);
        return `${added.length} progetti aggiunti${skipped.length ? `, ${skipped.length} saltati: ${skipped.join('; ')}` : ''}`;
      },
    },

    shutdown() {
      for (const pd of processes.values()) killGroup(pd);
    },
  };
};
