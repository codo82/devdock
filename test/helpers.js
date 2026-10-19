// Helper per i test d'integrazione: avviano DevDock come processo separato su una
// porta libera con una config temporanea e parlano con lui solo via HTTP.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function tmpDir(prefix = 'devdock-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Avvia il server con la config indicata; restituisce { port, configPath, request, stop }
async function startServer(config = { groups: [], servers: [], projects: [] }) {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const port = await freePort();

  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, DEVDOCK_PORT: String(port), DEVDOCK_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server non avviato:\n${output}`)), 5000);
    const onData = d => {
      output += d.toString();
      if (output.includes('DevDock →')) { clearTimeout(timer); resolve(); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`Server uscito (${code}):\n${output}`)); });
  });

  const request = (method, urlPath, { body, headers = {}, raw } = {}) => new Promise((resolve, reject) => {
    const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: {
        Host: `127.0.0.1:${port}`,
        ...(data !== undefined && raw === undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
    }, res => {
      let text = '';
      res.on('data', d => text += d);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json, events: parseSse(text) });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });

  const stop = () => new Promise(resolve => {
    if (proc.exitCode !== null) return resolve();
    proc.removeAllListeners('exit');
    proc.on('exit', resolve);
    proc.kill('SIGTERM');
  });

  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));

  return { port, configPath, request, stop, readConfig };
}

// Eventi SSE "data: {type, data}" di una risposta in streaming
function parseSse(text) {
  return text.split('\n\n')
    .map(part => part.replace(/^data: /, '').trim())
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// ---- git ----

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=test@devdock', '-c', 'user.name=test', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Repo con un commit iniziale (package.json con gli script indicati)
function makeRepo(dir, { scripts = {}, dependencies = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts, dependencies }, null, 2));
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

function commitFile(dir, name, content = name) {
  fs.writeFileSync(path.join(dir, name), content);
  git(dir, 'add', '--', name);
  git(dir, 'commit', '-qm', `add ${name}`);
}

module.exports = { ROOT, tmpDir, startServer, parseSse, git, makeRepo, commitFile };
