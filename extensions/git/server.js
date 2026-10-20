// Git: status, commit, grafo dei commit e operazioni remote per i repository
// dei progetti npm (risalendo dalla cartella del progetto fino a .git)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

module.exports = function createGit(ctx) {
  const npm = ctx.require('npm');
  const { isValidBranchName, isValidCommitHash } = ctx.lib.validate;

  function gitExec(cwd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts });
      let out = '', err = '';
      proc.stdout && proc.stdout.on('data', d => out += d.toString());
      proc.stderr && proc.stderr.on('data', d => err += d.toString());
      proc.on('close', code => {
        if (code === 0 || opts.allowFail) resolve({ out, err, code });
        else reject(new Error(err.trim() || out.trim() || `git exit ${code}`));
      });
      proc.on('error', reject);
    });
  }

  // ---- Validazione delle azioni git ----

  const GIT_ACTIONS = new Set(['commit', 'pull', 'push', 'push_force', 'pull_push', 'merge', 'fetch', 'checkout', 'stash', 'stash_pop']);
  const BRANCH_ACTIONS = new Set(['push', 'push_force', 'pull_push', 'merge', 'checkout']); // branch obbligatorio
  const REMOTE_ACTIONS = new Set(['pull', 'push', 'push_force', 'pull_push']);              // remote usato

  async function getGitRemotes(cwd) {
    const r = await gitExec(cwd, ['remote'], { allowFail: true });
    return r.out.split('\n').map(x => x.trim()).filter(Boolean);
  }

  // Restituisce un messaggio d'errore o null se i parametri sono validi
  async function validateGitAction(repoPath, { action, branch, remote, message }) {
    if (!GIT_ACTIONS.has(action)) return 'Azione non supportata';
    if (BRANCH_ACTIONS.has(action) && !branch) return 'Branch obbligatorio';
    if (branch != null && branch !== '' && !isValidBranchName(branch)) return `Nome branch non valido: ${branch}`;
    if (REMOTE_ACTIONS.has(action) && !(await getGitRemotes(repoPath)).includes(remote)) return `Remote sconosciuto: ${remote}`;
    if (message != null && typeof message !== 'string') return 'Messaggio non valido';
    return null;
  }

  // git status --porcelain -z: nomi file esatti (niente quoting), rinomine con path originale
  async function getGitStatus(cwd) {
    const r = await gitExec(cwd, ['status', '--porcelain', '-b', '-z'], { allowFail: true });
    const fields = r.out.split('\0');
    const header = fields[0].startsWith('## ') ? fields.shift() : '';
    const files = [];
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!f) continue;
      const entry = { xy: f.slice(0, 2), name: f.slice(3) };
      if (/[RC]/.test(entry.xy)) entry.orig = fields[++i]; // rinomina/copia: segue il path originale
      files.push(entry);
    }
    return { header, files };
  }

  function findGitRoot(startPath) {
    let dir = startPath;
    while (true) {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null; // filesystem root, non trovato
      dir = parent;
    }
  }

  function getGitRepos() {
    const seen = new Set();
    const repos = [];
    for (const p of npm.getProjects()) {
      const gitRoot = findGitRoot(p.path);
      if (!gitRoot || seen.has(gitRoot)) continue; // più progetti npm nella stessa repo: una sola voce
      seen.add(gitRoot);
      repos.push({ id: p.id, label: p.label, path: gitRoot });
    }
    return repos;
  }

  const busyRepos = new Set(); // path dei repo con un'azione git in corso

  return {
    handlers: {
      // Lista repos (da progetti NPM che hanno .git)
      listRepos(req, res) {
        res.json(getGitRepos());
      },

      // Status: branch, ahead/behind, modifiche
      async status(req, res) {
        const repos = getGitRepos();
        const repo = repos.find(r => r.id === req.params.id);
        if (!repo) return res.status(404).json({ error: 'Repo non trovato' });
        try {
          const [branchR, { header, files }, stashR] = await Promise.all([
            gitExec(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }),
            getGitStatus(repo.path),
            gitExec(repo.path, ['stash', 'list'], { allowFail: true }),
          ]);

          const branch = branchR.out.trim();

          // Parse ahead/behind dal ## branch
          const aheadM   = header.match(/\[ahead (\d+)/);
          const behindM  = header.match(/behind (\d+)/);
          const ahead    = aheadM  ? parseInt(aheadM[1])  : 0;
          const behind   = behindM ? parseInt(behindM[1]) : 0;

          const stashCount = stashR.out.trim().split('\n').filter(Boolean).length;

          res.json({ branch, ahead, behind, files, stashCount });
        } catch (e) {
          res.status(500).json({ error: e.message });
        }
      },

      // Log per il grafo: commit di tutti i branch (--all) con parent e ref, più la mappa hash → branch
      async log(req, res) {
        const repos = getGitRepos();
        const repo  = repos.find(r => r.id === req.params.id);
        if (!repo) return res.status(404).json({ error: 'Repo non trovato' });
        const limit = Math.min(parseInt(req.query.limit) || 40, 2000);
        try {
          // Mappa hash-completo → [branch names] da tutti i ref (locali + remoti)
          const refMap = {}; // hash → [refname, ...]
          const localBranches = []; // per distinguere "feature/x" locale da "origin/x" remoto
          try {
            const refOut = await gitExec(repo.path, [
              'for-each-ref',
              '--format=%(objectname) %(refname) %(refname:short)',
              'refs/heads/', 'refs/remotes/',
            ], { allowFail: true });
            refOut.out.split('\n').filter(Boolean).forEach(line => {
              const [hash, full, name] = line.split(' ');
              if (!hash || !name || full.endsWith('/HEAD')) return; // origin/HEAD è solo un alias
              if (!refMap[hash]) refMap[hash] = [];
              refMap[hash].push(name);
              if (full.startsWith('refs/heads/')) localBranches.push(name);
            });
          } catch (_) {}

          const r = await gitExec(repo.path, [
            'log', '--all',
            `--pretty=format:%H%x01%h%x01%P%x01%s%x01%an%x01%ar%x01%d`,
            `-${limit}`,
          ], { allowFail: true });

          const rawLines = r.out.split('\n').filter(Boolean);
          const entries = rawLines.map(line => {
            const parts = line.split('\x01');
            const [hash, short, parents, subject, author, relDate, refs] = parts;
            // refs dal %d (branch tip nel range) + refs da for-each-ref (branch tip fuori range)
            const refsFromLog = refs ? refs.trim().replace(/[()]/g, '').split(', ').filter(Boolean) : [];
            const refsFromMap = (refMap[hash] || []).filter(n => !refsFromLog.some(r => r === n || r.endsWith(n)));
            return {
              hash,
              short,
              parents: parents ? parents.trim().split(' ').filter(Boolean) : [],
              subject,
              author,
              relDate,
              refs: [...refsFromLog, ...refsFromMap],
            };
          });
          // Passa anche la mappa completa refs: il frontend la usa per nominare le lane
          // anche quando il tip del branch non è nei commit visualizzati
          res.json({ entries, refs: refMap, localBranches });
        } catch (e) {
          res.status(500).json({ error: e.message });
        }
      },

      // Messaggio completo di un commit (subject + body)
      async commitMessage(req, res) {
        const repos = getGitRepos();
        const repo  = repos.find(r => r.id === req.params.id);
        if (!repo) return res.status(404).json({ error: 'Repo non trovato' });
        if (!isValidCommitHash(req.params.hash)) return res.status(400).json({ error: 'Hash non valido' });
        try {
          const r = await gitExec(repo.path, [
            'show', '--no-patch', '--format=%B', req.params.hash, '--',
          ], { allowFail: true });
          res.json({ body: r.out.trim() });
        } catch (e) {
          res.status(500).json({ error: e.message });
        }
      },

      // Azione git (commit, pull, push, merge, fetch, checkout, stash) — output in streaming SSE
      async action(req, res) {
        const repos = getGitRepos();
        const repo  = repos.find(r => r.id === req.params.id);
        if (!repo) { res.status(404).json({ error: 'Repo non trovato' }); return; }

        const { action, message, branch, remote = 'origin', files = [] } = req.body;

        // Validazione prima di aprire lo stream SSE, così l'errore arriva come JSON 400
        const invalid = await validateGitAction(repo.path, { action, branch, remote, message });
        if (invalid) { res.status(400).json({ error: invalid }); return; }

        // Una sola operazione git alla volta per repo: due push concorrenti si
        // contendono l'aggiornamento dei ref ("cannot lock ref ... but expected ...")
        if (busyRepos.has(repo.path)) { res.status(409).json({ error: 'Un\'altra operazione git è in corso su questo repository' }); return; }
        busyRepos.add(repo.path);
        res.on('close', () => busyRepos.delete(repo.path));

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const send = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, data })}\n\n`); } catch {} };

        let args;
        if (action === 'commit') {
          // Solo file presenti in git status: un nome arbitrario potrebbe essere
          // un'opzione di git add o un path fuori dalle modifiche mostrate
          if (!Array.isArray(files)) { send('error', 'Lista file non valida'); res.end(); return; }
          const { files: changed } = await getGitStatus(repo.path);
          const known = new Set(changed.map(f => f.name));
          const unknown = files.filter(f => !known.has(f));
          if (unknown.length) { send('error', `File non presenti tra le modifiche: ${unknown.join(', ')}`); res.end(); return; }
          // Prima stage i file, poi commit
          const stageArgs = files.length ? ['add', '-A', '--', ...files] : ['add', '-A'];
          const proc1 = spawn('git', stageArgs, { cwd: repo.path, env: { ...process.env } });
          let stageErr = '';
          proc1.stderr.on('data', d => stageErr += d.toString());
          proc1.on('close', code => {
            if (code !== 0) { send('error', stageErr || 'git add fallito'); res.end(); return; }
            send('stdout', `$ git ${stageArgs.join(' ')}\n`);
            const proc2 = spawn('git', ['commit', '-m', message || 'Update'], { cwd: repo.path, env: { ...process.env } });
            proc2.stdout.on('data', d => send('stdout', d.toString()));
            proc2.stderr.on('data', d => send('stderr', d.toString()));
            proc2.on('close', c2 => { send('exit', c2); res.end(); });
            proc2.on('error', e => { send('error', e.message); res.end(); });
          });
          return;
        } else if (action === 'pull') {
          args = ['pull', remote, branch || '--rebase=false'].filter(Boolean);
        } else if (action === 'push') {
          // Fetch silenzioso per aggiornare i remote-tracking refs prima del push.
          // Nota: il "cannot lock ref: is at X but expected Y" del backlog #1 non
          // dipendeva da ref stale ma da due push concorrenti (la UI inviava l'azione
          // due volte); ora lo impediscono busyRepos e la richiesta unica dalla UI.
          send('stdout', `$ git fetch ${remote}\n`);
          const fetchProc = spawn('git', ['fetch', remote].filter(Boolean), {
            cwd: repo.path,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
          });
          let fetchStderr = '';
          fetchProc.stderr.on('data', d => { fetchStderr += d.toString(); });
          fetchProc.on('close', fetchCode => {
            if (fetchCode !== 0) {
              send('stdout', `[fetch warning: ${fetchStderr.trim()}]\n`);
            }
            // Dopo il fetch (o anche se il fetch ha fallito), esegui il push normale.
            // Ora i remote-tracking refs sono aggiornati e git invierà il corretto "expected" hash.
            const pArgs = ['push', remote, branch].filter(Boolean);
            send('stdout', `$ git ${pArgs.join(' ')}\n`);
            const p = spawn('git', pArgs, { cwd: repo.path, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
            let pushStderr = '';
            p.stdout.on('data', d => send('stdout', d.toString()));
            p.stderr.on('data', d => { pushStderr += d.toString(); send('stderr', d.toString()); });
            p.on('close', c => { send('exit', c); res.end(); });
            p.on('error', e => { send('error', e.message); res.end(); });
          });
          fetchProc.on('error', e => {
            // Fetch non disponibile: prova il push comunque
            send('stdout', `[fetch error: ${e.message}]\n`);
            const pArgs = ['push', remote, branch].filter(Boolean);
            send('stdout', `$ git ${pArgs.join(' ')}\n`);
            const p = spawn('git', pArgs, { cwd: repo.path, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
            p.stdout.on('data', d => send('stdout', d.toString()));
            p.stderr.on('data', d => send('stderr', d.toString()));
            p.on('close', c => { send('exit', c); res.end(); });
            p.on('error', e2 => { send('error', e2.message); res.end(); });
          });
          return;
        } else if (action === 'push_force') {
          args = ['push', '--force-with-lease', remote, branch].filter(Boolean);
        } else if (action === 'pull_push') {
          // pull poi push — il pull aggiorna già i remote-tracking refs,
          // quindi il push successivo avrà gli hash corretti
          const pullArgs = ['pull', remote, branch].filter(Boolean);
          send('stdout', `$ git ${pullArgs.join(' ')}\n`);
          const proc1 = spawn('git', pullArgs, { cwd: repo.path, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
          proc1.stdout.on('data', d => send('stdout', d.toString()));
          proc1.stderr.on('data', d => send('stderr', d.toString()));
          proc1.on('close', code => {
            if (code !== 0) { send('exit', code); res.end(); return; }
            const pushArgs = ['push', remote, branch].filter(Boolean);
            send('stdout', `\n$ git ${pushArgs.join(' ')}\n`);
            const proc2 = spawn('git', pushArgs, { cwd: repo.path, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
            proc2.stdout.on('data', d => send('stdout', d.toString()));
            proc2.stderr.on('data', d => send('stderr', d.toString()));
            proc2.on('close', c2 => { send('exit', c2); res.end(); });
            proc2.on('error', e => { send('error', e.message); res.end(); });
          });
          proc1.on('error', e => { send('error', e.message); res.end(); });
          return;
        } else if (action === 'merge') {
          args = ['merge', branch].filter(Boolean);
        } else if (action === 'fetch') {
          args = ['fetch', '--all', '--prune'];
        } else if (action === 'checkout') {
          args = ['checkout', branch, '--'];
        } else if (action === 'stash') {
          args = ['stash'];
        } else if (action === 'stash_pop') {
          args = ['stash', 'pop'];
        } else {
          send('error', 'Azione non supportata'); res.end(); return;
        }

        send('stdout', `$ git ${args.join(' ')}\n`);
        const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
        const proc = spawn('git', args, { cwd: repo.path, env: gitEnv });
        proc.stdout.on('data', d => send('stdout', d.toString()));
        proc.stderr.on('data', d => send('stderr', d.toString()));
        proc.on('close', code => { send('exit', code); res.end(); });
        proc.on('error', e => { send('error', e.message); res.end(); });
      },
    },
  };
};
