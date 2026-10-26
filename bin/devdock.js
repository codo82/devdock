#!/usr/bin/env node
// Riga di comando di Kelbo: avvio e gestione delle estensioni installate.
//   devdock                         avvia il server (come npm start)
//   devdock ext list                estensioni con versione, provenienza e stato
//   devdock ext install <url|codice> [--path cartella] [--tag tag] [--yes]
//   devdock ext update <codice> [--tag tag] [--yes]
//   devdock ext remove <codice> [--yes]
//   devdock ext check               aggiornamenti disponibili
//   devdock mcp                     ponte stdio verso il server MCP (per Claude Desktop e simili)
// Con Kelbo in esecuzione passa dalle sue API (l'estensione si carica subito); altrimenti
// lavora sui file e la modifica vale dal prossimo avvio.
const http = require('http');
const path = require('path');
const readline = require('readline');

const [, , command, sub, ...rest] = process.argv;

if (!command || command === 'start') {
  require(path.join(__dirname, '..', 'server.js'));
  return;
}
if (command === 'mcp') {
  require(path.join(__dirname, 'devdock-mcp.js')).main().catch(e => { process.stderr.write(`devdock-mcp: ${e.message}\n`); process.exit(1); });
  return;
}
if (command !== 'ext') usage(1);

const flags = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--yes' || a === '-y') flags.yes = true;
  else if (a === '--path' || a === '--tag') flags[a.slice(2)] = rest[++i];
  else args.push(a);
}

function usage(code = 0) {
  console.log(`Uso:
  devdock [start]                      avvia Kelbo
  devdock ext list                     estensioni installate e incluse
  devdock ext install <url|codice> [--path cartella] [--tag tag] [--yes]
  devdock ext update <codice> [--tag tag] [--yes]
  devdock ext remove <codice> [--yes]
  devdock ext check                    aggiornamenti disponibili
  devdock mcp                          ponte stdio verso il server MCP (Claude Desktop)`);
  process.exit(code);
}

const { PORT } = require('../lib/env');

// ---- API del server in esecuzione ----

function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({
      host: '127.0.0.1', port: PORT, method, path: `/api/core${p}`,
      headers: { Host: `127.0.0.1:${PORT}`, ...(data ? { 'Content-Type': 'application/json' } : {}) },
    }, res => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* SSE o testo */ }
        if (res.statusCode >= 400) reject(new Error(json?.error || `HTTP ${res.statusCode}`));
        else resolve({ json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function serverRunning() {
  try { await request('GET', '/extensions'); return true; } catch { return false; }
}

// ---- senza server: direttamente sui file ----

function offline() {
  const installer = require('../lib/ext-install');
  const { validateManifest, CORE_VERSION } = require('../lib/extensions');
  const { loadConfig } = require('../lib/config');
  const fs = require('fs');
  const { EXTENSIONS_DIR, INSTALLED_DIR } = require('../lib/env');
  const scan = (dir, source) => {
    try {
      return fs.readdirSync(dir).filter(f => !f.startsWith('.')).flatMap(f => {
        try { const m = JSON.parse(fs.readFileSync(path.join(dir, f, 'setting.json'), 'utf8')); return [{ code: m.code, version: m.version, source, state: '-' }]; }
        catch { return []; }
      });
    } catch { return []; }
  };
  const catalogUrls = () => installer.catalogUrls(loadConfig().extensions?.catalogs);
  const known = () => Object.fromEntries([...scan(EXTENSIONS_DIR, 'builtin'), ...scan(INSTALLED_DIR, 'installed')].map(e => [e.code, e]));
  return {
    list: async () => [...scan(EXTENSIONS_DIR, 'builtin'), ...scan(INSTALLED_DIR, 'installed')],
    preview: async body => {
      let { source, folder, code } = body;
      if (!source && code) {
        const entry = (await installer.catalogs(catalogUrls())).extensions.find(e => e.code === code);
        if (!entry) throw new Error(`${code} non è in nessun catalogo`);
        source = entry.repo; folder = entry.path;
      }
      return installer.preview({ source, folder, tag: body.tag, code, validateManifest, coreVersion: CORE_VERSION, known: known() });
    },
    updatePreview: async (code, tag) => {
      const lock = installer.readLock().extensions[code];
      if (!lock) throw new Error(`${code} non è un'estensione installata`);
      return installer.preview({ source: { repo: lock.repo, path: lock.path || null }, tag, code, validateManifest, coreVersion: CORE_VERSION, known: known() });
    },
    install: async id => {
      const r = await installer.install(id, { step: key => console.log(`  · ${key}`), log: text => process.stdout.write(text) });
      return { ...r, restartRequired: true };
    },
    remove: async code => { installer.remove(code); return { restartRequired: true }; },
    check: () => installer.checkUpdates(),
  };
}

function online() {
  return {
    list: async () => (await request('GET', '/extensions')).json,
    preview: async body => (await request('POST', '/extensions-admin/preview', body)).json,
    updatePreview: async (code, tag) => (await request('POST', `/extensions-admin/${encodeURIComponent(code)}/update`, tag ? { tag } : {})).json,
    install: async id => {
      const { text } = await request('POST', '/extensions-admin/install', { id });
      let result = null;
      for (const part of text.split('\n\n')) {
        let ev; try { ev = JSON.parse(part.replace(/^data: /, '')); } catch { continue; }
        if (ev.type === 'step') console.log(`  · ${ev.data.key}`);
        else if (ev.type === 'log') process.stdout.write(ev.data);
        else if (ev.type === 'error') throw new Error(ev.data.error);
        else if (ev.type === 'done') result = ev.data;
      }
      return result;
    },
    remove: async code => (await request('DELETE', `/extensions-admin/${encodeURIComponent(code)}`)).json,
    check: async () => (await request('POST', '/extensions-admin/updates', {})).json,
  };
}

const ask = question => new Promise(resolve => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, answer => { rl.close(); resolve(/^(s|si|sì|y|yes)$/i.test(answer.trim())); });
});

function showPreview(p) {
  console.log(`\n${typeof p.name === 'object' ? p.name.it || Object.values(p.name)[0] : p.name} (${p.code}) ${p.version}${p.tag ? ` · tag ${p.tag}` : ' · ramo predefinito'}`);
  console.log(`  ${p.repo}${p.path ? ` · ${p.path}` : ''} · ${p.commit.slice(0, 10)}`);
  if (p.installed) console.log(`  installata ora: ${p.installed.version}`);
  if (!p.compatible) console.log(`  ✖ richiede Kelbo ${p.devdock}, questa è la ${p.coreVersion}`);
  if (p.builtin) console.log(`  ✖ ${p.code} è già un'estensione inclusa`);
  if (p.missing.length) console.log(`  ✖ dipendenze da installare prima: ${p.missing.join(', ')}`);
  if (p.changelog) console.log(`\n${p.changelog.split('\n').map(l => `  ${l}`).join('\n')}\n`);
  console.log('  ⚠ un\'estensione gira con tutti i permessi del tuo utente: installa solo da sorgenti di cui ti fidi');
  return p.compatible && !p.missing.length && !p.builtin;
}

(async () => {
  const api = (await serverRunning()) ? online() : offline();
  try {
    if (sub === 'list') {
      const list = await api.list();
      for (const e of list) console.log(`${e.code.padEnd(20)} ${String(e.version || '?').padEnd(10)} ${String(e.source || '').padEnd(10)} ${e.state || ''}${e.error ? `  ${e.error}` : ''}`);
    } else if (sub === 'install' || sub === 'update') {
      const target = args[0];
      if (!target) usage(1);
      const p = sub === 'update' ? await api.updatePreview(target, flags.tag)
        : await api.preview(/[/:@]/.test(target) || path.isAbsolute(target) ? { source: target, folder: flags.path, tag: flags.tag } : { code: target, tag: flags.tag });
      if (!showPreview(p)) process.exit(2);
      if (!flags.yes && !(await ask(`${sub === 'update' ? 'Aggiornare' : 'Installare'} ${p.code} ${p.version}? [s/N] `))) process.exit(0);
      const r = await api.install(p.id);
      console.log(r?.restartRequired ? `${p.code} ${p.version} installata: vale dal prossimo avvio di Kelbo` : `${p.code} ${p.version} installata e caricata`);
    } else if (sub === 'remove') {
      const code = args[0];
      if (!code) usage(1);
      if (!flags.yes && !(await ask(`Rimuovere ${code}? [s/N] `))) process.exit(0);
      const r = await api.remove(code);
      console.log(r?.restartRequired ? `${code} rimossa: vale dal prossimo avvio di Kelbo` : `${code} rimossa`);
    } else if (sub === 'check') {
      const r = await api.check();
      const entries = Object.entries(r.extensions || {});
      if (!entries.length) console.log('Nessuna estensione installata da git');
      for (const [code, u] of entries) {
        console.log(`${code.padEnd(20)} ${u.error ? `errore: ${u.error}` : u.available ? `${u.current} → ${u.latest || 'nuovo commit'}` : `${u.current} aggiornata`}${u.moved ? '  (tag spostato)' : ''}`);
      }
    } else usage(1);
  } catch (e) {
    console.error(`errore: ${e.message}`);
    process.exit(1);
  }
})();
