// Esecuzione di git, status, repository dei progetti e validazione delle azioni
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig } = require('./config');
const { isValidBranchName } = require('./validate');

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
  const cfg = loadConfig();
  const projects = cfg.projects || [];
  const seen = new Set();
  const repos = [];
  for (const p of projects) {
    const gitRoot = findGitRoot(p.path);
    if (!gitRoot) continue;
    if (seen.has(gitRoot)) continue; // stesso repo già aggiunto (più progetti npm nella stessa repo)
    seen.add(gitRoot);
    repos.push({ id: p.id, label: p.label, path: gitRoot });
  }
  return repos;
}

module.exports = { gitExec, getGitStatus, getGitRemotes, getGitRepos, validateGitAction };
