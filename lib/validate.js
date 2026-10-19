// Validatori condivisi: i valori finiscono in argomenti di ssh/npm/git/pm2 e nell'HTML della UI
const { spawnSync } = require('child_process');

const KEY_RE    = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR_RE  = /^#[0-9a-f]{3,8}$/i;
const REMOTE_RE = /^(\[[0-9a-f:.]+\]|[A-Za-z0-9._-]+):(\d{1,5})$/i; // host:porta o [ipv6]:porta
const ALIAS_RE  = /^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/;               // host/alias ssh, mai "-" iniziale

const isPort = n => Number.isInteger(n) && n >= 1 && n <= 65535;
const isText = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

// Nome pacchetto npm (anche scoped): impedisce path traversal e opzioni travestite
const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

// Nome o id di un processo pm2 (no "-" iniziale: sarebbe letto come opzione)
const PM2_TARGET_RE = /^[A-Za-z0-9_.@:][A-Za-z0-9_.@:-]*$/;

// Branch git: mai "-" iniziale (sarebbe un'opzione, es. --upload-pack=<comando>)
function isValidBranchName(name) {
  if (typeof name !== 'string' || !name || name.startsWith('-')) return false;
  return spawnSync('git', ['check-ref-format', '--branch', name], { stdio: 'ignore' }).status === 0;
}

function isValidCommitHash(hash) {
  return typeof hash === 'string' && /^[0-9a-f]{4,64}$/i.test(hash);
}

module.exports = {
  KEY_RE, COLOR_RE, REMOTE_RE, ALIAS_RE, NPM_NAME_RE, PM2_TARGET_RE,
  isPort, isText, isValidBranchName, isValidCommitHash,
};
