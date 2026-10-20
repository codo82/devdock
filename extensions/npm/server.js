// NPM: progetti (sezione "projects" di config.json), script di package.json
// eseguiti come processi tracciati in un process group dedicato, dipendenze.
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_FIELDS = ['id', 'label', 'path'];
const MAX_LOG_LINES = 500;

module.exports = function createNpm(ctx) {
  const { pick } = ctx.lib.config;
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
    if (!p || typeof p !== 'object') throw ctx.error.config('project_invalid');
    const bad = name => ctx.error.config(name, { id: String(p.id ?? '') });
    if (!KEY_RE.test(p.id || '')) throw bad('project_id');
    if (!isText(p.label)) throw bad('project_label');
    if (!isText(p.path, 1024) || !path.isAbsolute(p.path)) throw bad('project_path');
  }

  const config = {
    projects: {
      empty: [], idField: 'id',
      normalize: v => (Array.isArray(v) ? v.map(p => pick(p || {}, PROJECT_FIELDS)) : v),
      validate(list) {
        if (!Array.isArray(list)) throw ctx.error.config('not_a_list', { section: 'projects' });
        list.forEach(validateProject);
        const seen = new Set();
        for (const p of list) {
          if (seen.has(p.id)) throw ctx.error.config('duplicate_project', { id: p.id });
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
    proc.on('error', err => { if (current()) { pd.running = false; log(pd, `\n[error: ${err.message}]`); } });
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

  const publicProcess = pd => ({
    id: pd.id, projectId: pd.projectId, projectLabel: pd.projectLabel,
    script: pd.script, pid: pd.pid, ports: pd.running ? getPortsForPgid(pd.pid) : [],
    startedAt: pd.startedAt, running: pd.running, exitCode: pd.exitCode,
  });

  const projectOr404 = req => {
    const p = getProject(req.params.id);
    if (!p) throw ctx.error(404, 'project_not_found', { id: req.params.id });
    return p;
  };
  const processOr404 = req => {
    const pd = processes.get(req.params.id);
    if (!pd) throw ctx.error(404, 'process_not_found');
    return pd;
  };

  return {
    config,
    services: {
      getProjects, getProject, readPackage,
      // per l'estensione ports: processi avviati da DevDock (pid = process group) e arresto
      processes: () => [...processes.values()].filter(pd => pd.running).map(pd => ({ id: pd.id, pid: pd.pid, project: pd.projectLabel, script: pd.script })),
      stopProcess(id) {
        const pd = processes.get(id);
        if (!pd) return false;
        killGroup(pd);
        pd.running = false;
        processes.delete(pd.id);
        return true;
      },
    },

    // Strumenti MCP: lettura, più avvio e arresto degli script (come dall'interfaccia)
    mcp: {
      projects() {
        return {
          projects: getProjects().map(p => {
            const pkg = readPackage(p);
            return { id: p.id, label: p.label, path: p.path, name: pkg?.name || null, scripts: pkg?.scripts || {} };
          }),
        };
      },
      processes() {
        return { processes: [...processes.values()].map(publicProcess) };
      },
      run({ project, script }) {
        const p = getProject(project);
        if (!p) throw ctx.error(404, 'project_not_found', { id: String(project) });
        if (typeof script !== 'string' || !script) throw ctx.error(400, 'script_required');
        let args;
        if (script === 'install') args = ['install'];
        else {
          if (!Object.hasOwn(readPackage(p)?.scripts || {}, script)) throw ctx.error(400, 'script_not_defined', { script });
          args = ['run', script];
        }
        const pd = startNpm(p, script, args);
        return { started: true, process: publicProcess(pd) };
      },
      stop({ process: id }) {
        const pd = processes.get(id);
        if (!pd) throw ctx.error(404, 'process_not_found');
        killGroup(pd);
        pd.running = false;
        processes.delete(pd.id);
        return { stopped: true, id };
      },
      output({ process: id, lines = 100 }) {
        const pd = processes.get(id);
        if (!pd) throw ctx.error(404, 'process_not_found');
        const n = Math.min(Math.max(parseInt(lines) || 100, 1), 2000);
        const text = pd.logs.map(l => l.text).join('').split('\n');
        return { ...publicProcess(pd), output: text.slice(-n).join('\n'), truncated: text.length > n };
      },
    },

    handlers: {
      listProjects(req, res) {
        res.json(getProjects());
      },

      createProject(req, res) {
        const { id, label, path: projectPath } = req.body;
        if (!id || !label || !projectPath) throw ctx.error(400, 'fields_required');
        const list = getProjects();
        if (list.some(p => p.id === id)) throw ctx.error(409, 'id_exists', { id: String(id) });
        if (!fs.existsSync(projectPath)) throw ctx.error(400, 'folder_not_found', { path: String(projectPath) });
        saveProjects([...list, { id, label, path: projectPath }]);
        res.json({ ok: true });
      },

      updateProject(req, res) {
        const list = getProjects();
        const idx = list.findIndex(p => p.id === req.params.id);
        if (idx === -1) throw ctx.error(404, 'project_not_found', { id: req.params.id });
        const { path: projectPath } = req.body;
        if (projectPath && !fs.existsSync(projectPath)) throw ctx.error(400, 'folder_not_found', { path: String(projectPath) });
        list[idx] = { ...list[idx], ...pick(req.body, ['label', 'path']) };
        saveProjects(list);
        res.json({ ok: true });
      },

      deleteProject(req, res) {
        saveProjects(getProjects().filter(p => p.id !== req.params.id));
        res.json({ ok: true });
      },

      packageInfo(req, res) {
        const p = projectOr404(req);
        if (!fs.existsSync(path.join(p.path, 'package.json'))) {
          return res.json({ name: null, scripts: {}, dependencies: {}, devDependencies: {} });
        }
        const pkg = readPackage(p);
        if (!pkg) throw ctx.error(500, 'package_invalid');
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
        const p = projectOr404(req);
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
        const p = projectOr404(req);
        let out;
        try {
          out = execFileSync('npm', ['outdated', '--json'], { cwd: p.path, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (e) {
          out = e.stdout || '{}';
        }
        try { res.json(JSON.parse(out || '{}')); }
        catch { ctx.error.send(res, 500, 'outdated_invalid'); }
      },

      // Solo "install" o script definiti in package.json
      runScript(req, res) {
        const p = projectOr404(req);
        const { script } = req.body;
        if (typeof script !== 'string' || !script) throw ctx.error(400, 'script_required');
        let args;
        if (script === 'install') {
          args = ['install'];
        } else {
          const scripts = readPackage(p)?.scripts || {};
          if (!Object.hasOwn(scripts, script)) throw ctx.error(400, 'script_not_defined', { script });
          args = ['run', script];
        }
        const pd = startNpm(p, script, args);
        res.json({ id: pd.id, pid: pd.pid });
      },

      // npm update <pkg>: solo pacchetti dichiarati in package.json
      updatePackage(req, res) {
        const p = projectOr404(req);
        const name = req.body.package;
        const pkg = readPackage(p) || {};
        const declared = { ...pkg.dependencies, ...pkg.devDependencies };
        if (typeof name !== 'string' || !NPM_NAME_RE.test(name) || !Object.hasOwn(declared, name)) {
          throw ctx.error(400, 'package_not_declared', { name: String(name) });
        }
        const pd = startNpm(p, `update ${name}`, ['update', name]);
        res.json({ id: pd.id, pid: pd.pid });
      },

      listProcesses(req, res) {
        res.json([...processes.values()].map(publicProcess));
      },

      stopProcess(req, res) {
        const pd = processOr404(req);
        killGroup(pd);
        pd.running = false;
        processes.delete(pd.id);
        res.json({ ok: true });
      },

      restartProcess(req, res) {
        const pd = processOr404(req);
        const p = getProject(pd.projectId);
        if (!p) throw ctx.error(400, 'project_gone');
        killGroup(pd);
        spawnNpm(pd, p.path, '\n--- ↻ ---\n');
        res.json({ ok: true, pid: pd.pid });
      },

      // Toglie dalla lista un processo già terminato
      dismissProcess(req, res) {
        const pd = processOr404(req);
        if (pd.running) throw ctx.error(409, 'process_running');
        processes.delete(pd.id);
        res.json({ ok: true });
      },

      processLogs(req, res) {
        const pd = processOr404(req);
        res.json({ running: pd.running, exitCode: pd.exitCode, logs: pd.logs.slice(-200) });
      },

      // Log in streaming: prima lo storico, poi le righe nuove ogni 100ms
      processStream(req, res) {
        const pd = processOr404(req);
        const send = ctx.sse(res);
        if (pd.logs.length) send('history', pd.logs.map(l => l.text).join(''));
        // exit: { exitCode } oppure { removed: true }; il testo lo compone il frontend
        if (!pd.running) { send('exit', { exitCode: pd.exitCode, ended: true }); send.end(); return; }

        let lastTs = pd.logs.length ? pd.logs[pd.logs.length - 1].ts : Date.now();
        const timer = setInterval(() => {
          const cur = processes.get(pd.id);
          if (!cur) { clearInterval(timer); send('exit', { removed: true }); send.end(); return; }
          const fresh = cur.logs.filter(l => l.ts > lastTs);
          if (fresh.length) { send('stdout', fresh.map(l => l.text).join('')); lastTs = fresh[fresh.length - 1].ts; }
          if (!cur.running) { clearInterval(timer); send('exit', { exitCode: cur.exitCode }); send.end(); }
        }, 100);
        req.on('close', () => clearInterval(timer));
      },
    },

    shutdown() {
      for (const pd of processes.values()) killGroup(pd);
    },
  };
};
