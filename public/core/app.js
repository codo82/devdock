// Sezioni non ancora migrate a estensioni (npm, git)
const App = (() => {
  const { esc, js, cssColor, ansiToHtml, toast, openModal, closeModal, formatUptime } = window.UI;

  let section = null; // 'npm' | 'git' | codice di un'estensione
  let system = { platform: null, tools: {} }; // strumenti esterni disponibili (/api/system)

  // NPM state
  let npmProjects = [];
  let activeProject = null;
  let npmActiveTab = 'scripts';
  let sseSource = null;
  let activeProcesses = [];

  // Git state
  let gitRepos = [];
  let activeGitRepo = null;
  let gitStatus = null;
  let gitAutoRefreshTimer = null;
  let gitSelectedFiles = new Set(); // file selezionati per commit
  let gitLogEntries = []; // cache entries log per il dettaglio commit

  // Helper: restituisce il contenitore del contenuto dinamico della sezione.
  // Se esiste mainContent-{sec} lo usa (per non sovrascrivere il pannello SSE),
  // altrimenti cade su mainArea-{sec}.
  function mainPanel(sec) {
    const s = sec || section;
    return document.getElementById(`mainContent-${s}`) || document.getElementById(`mainArea-${s}`);
  }

  // ---- API ----
  const api = {
    async get(p)    { const r = await fetch(p); if (!r.ok) throw new Error(await r.text()); return r.json(); },
    async post(p,b) { const r = await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); const d=await r.json(); if(!r.ok) throw new Error(d.error||'Errore'); return d; },
    async put(p,b)  { const r = await fetch(p,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); const d=await r.json(); if(!r.ok) throw new Error(d.error||'Errore'); return d; },
    async del(p)    { const r = await fetch(p,{method:'DELETE'}); if(!r.ok) throw new Error(await r.text()); return r.json(); },
  };

  // ---- SECTION NAV ----
  // Mostra il pannello della sezione attiva, nasconde gli altri
  function switchMainPanel(sec) {
    ['npm','git'].forEach(s => {
      const p = document.getElementById(`mainArea-${s}`);
      if (p) p.style.display = s === sec ? 'flex' : 'none';
    });
  }

  function goSection(sec) {
    section = sec;
    // Auto-refresh git: attivo solo nella sezione git
    if (gitAutoRefreshTimer) { clearInterval(gitAutoRefreshTimer); gitAutoRefreshTimer = null; }
    if (sec === 'git') {
      gitAutoRefreshTimer = setInterval(() => {
        if (activeGitRepo) { loadGitStatus(); loadGitLog(); }
      }, 30000); // ogni 30 secondi
    }
    // Non chiudere closeSsePanel() — ogni sezione mantiene il suo pannello

    // Update section tabs
    ['npm','git'].forEach(s => {
      const el = document.getElementById('nav' + s.charAt(0).toUpperCase() + s.slice(1));
      if (!el) return;
      el.className = 'section-tab' + (section === s ? ` active-${s}` : '');
    });

    // Update sidebar data-section
    document.getElementById('sidebar').dataset.section = sec;

    // Sezione fornita da un'estensione: la gestisce la shell
    const isExt = window.Shell?.has(sec);
    switchMainPanel(isExt ? null : sec);
    window.Shell?.activate(isExt ? sec : null);
    if (isExt) return;

    // Render section (aggiorna sidebar + eventuale refresh leggero)
    if (sec === 'npm')      renderNpmSection();
    else if (sec === 'git') renderGitSection();
  }

  // ---- SECTION BADGES ----
  function updateBadges() {
    const n = document.getElementById('badgeNpm');
    const g = document.getElementById('badgeGit');
    if (n) {
      const running = activeProcesses.filter(x => x.running).length;
      n.textContent = npmProjects.length + (running ? ` · ${running}▶` : '');
    }
    if (g) g.textContent = gitRepos.length;
  }

  // ---- PILLS HEADER ----
  function renderActivePills() {
    const pills = document.getElementById('legacyPills');
    const npmPills = activeProcesses.filter(p => p.running).map(p => {
      const portStr = (p.ports||[]).map(x => `:${x}`).join(' ');
      return `
      <span class="pill pill-npm"
            onclick="App.goSection('npm')"
            title="${esc(p.projectLabel)} — npm ${p.script}${portStr?' ('+portStr+')':''}">
        <span class="pill-dot"></span>
        ${esc(p.projectLabel)}<span style="opacity:.7;font-size:10px"> npm ${esc(p.script)}</span>
        ${portStr ? `<span style="opacity:.6;font-size:10px">${portStr}</span>` : ''}
        <span style="cursor:pointer;opacity:.5;margin-left:2px" onclick="event.stopPropagation();App.stopProcess(${js(p.id)})">✕</span>
      </span>`;
    }).join('');

    pills.innerHTML = npmPills;
  }

  // ================================================================
  // NPM SECTION
  // ================================================================
  async function renderNpmSection() {
    await loadNpmProjects();

    // Sidebar: projects
    const sidebar = document.getElementById('sidebarContent');
    sidebar.innerHTML = `
      <div class="sidebar-head">
        <span class="sidebar-head-title">Progetti NPM</span>
        <button class="btn btn-npm btn-sm" onclick="App.modalAddProject()">+</button>
      </div>
      <div class="sidebar-body" id="npmProjectsList"></div>`;

    renderNpmProjectsList();

    // Render main solo se non già presente
    renderNpmMain();
  }

  function renderNpmProjectsList() {
    const el = document.getElementById('npmProjectsList');
    if (!el) return;
    if (!npmProjects.length) {
      el.innerHTML = '<p style="color:var(--muted);font-size:12px;padding:12px 14px">Nessun progetto.<br><br><button class="btn btn-npm btn-sm" onclick="App.modalAddProject()" style="margin-top:4px">+ Aggiungi</button></p>';
      return;
    }
    el.innerHTML = npmProjects.map(p => {
      const running = activeProcesses.filter(pr => pr.projectId === p.id && pr.running).length;
      return `
      <div class="sb-proj ${activeProject===p.id?'active':''}" onclick="App.selectNpmProject(${js(p.id)})">
        <span style="font-size:14px;flex-shrink:0">${running > 0 ? '🟠' : '📁'}</span>
        <div class="sb-proj-info">
          <div class="sb-proj-label">${esc(p.label)}${running>0?` <span style="color:var(--c-npm);font-size:10px">▶${running}</span>`:''}</div>
          <div class="sb-proj-path">${esc(p.path)}</div>
        </div>
        <button class="sb-proj-del" onclick="event.stopPropagation();App.deleteProject(${js(p.id)})" title="Rimuovi">✕</button>
      </div>`;
    }).join('');
  }

  function renderNpmMain() {
    const main = mainPanel('npm');
    if (!activeProject) {
      main.innerHTML = `<div class="empty-state"><div class="icon">📦</div><p>Seleziona un progetto dalla sidebar</p></div>`;
      return;
    }
    const p = npmProjects.find(x => x.id === activeProject);
    if (!p) { main.innerHTML = `<div class="empty-state"><div class="icon">📦</div><p>Progetto non trovato</p></div>`; return; }

    const running = activeProcesses.filter(pr => pr.projectId === p.id && pr.running).length;
    main.innerHTML = `
      <div class="npm-area">
        <div class="npm-detail-header">
          <h3 style="color:var(--c-npm)">${esc(p.label)}</h3>
          <div style="display:flex;align-items:center;gap:10px">
            <div class="path-label">${esc(p.path)}</div>
            ${running>0?`<span style="color:var(--c-npm);font-size:11px;font-family:var(--font)">▶ ${running} in esecuzione</span>`:''}
          </div>
        </div>
        <div class="npm-tabs">
          <button class="npm-tab ${npmActiveTab==='scripts'?'active':''}" onclick="App.switchNpmTab('scripts')">▶ Scripts</button>
          <button class="npm-tab ${npmActiveTab==='packages'?'active':''}" onclick="App.switchNpmTab('packages')">📦 Pacchetti</button>
        </div>
        <div class="npm-tab-content" id="npmTabContent">
          <div style="color:var(--muted);font-size:12px">Caricamento...</div>
        </div>
      </div>`;

    if (npmActiveTab === 'scripts') renderScriptsTab(p);
    else renderPackagesTab(p);
  }

  async function selectNpmProject(id) {
    activeProject = id;
    renderNpmProjectsList();
    renderNpmMain();
  }

  async function switchNpmTab(tab) {
    npmActiveTab = tab;
    document.querySelectorAll('.npm-tab').forEach(b => {
      b.classList.toggle('active',
        (tab==='scripts'&&b.textContent.includes('Scripts')) ||
        (tab==='packages'&&b.textContent.includes('Pacchetti')));
    });
    const content = document.getElementById('npmTabContent');
    if (content) content.innerHTML = '<div style="color:var(--muted);font-size:12px">Caricamento...</div>';
    const p = npmProjects.find(x => x.id === activeProject);
    if (!p) return;
    if (tab === 'scripts') await renderScriptsTab(p);
    else await renderPackagesTab(p);
  }

  async function renderScriptsTab(p) {
    const content = document.getElementById('npmTabContent');
    if (!content) return;
    let pkg = { scripts: {} };
    try { pkg = await api.get(`/api/projects/${p.id}/package`); } catch {}

    const scripts = Object.entries(pkg.scripts || {});
    const procs = activeProcesses.filter(pr => pr.projectId === p.id);

    function scriptRow(name, cmd) {
      const proc = procs.find(pr => pr.script === name);
      const isRunning = proc && proc.running;
      const isDead = proc && !proc.running;
      const ports = (proc && proc.ports && proc.ports.length) ? proc.ports : [];
      return `<div class="script-row ${isRunning ? 'running' : ''}">
        ${isRunning ? `<span class="proc-dot" title="In esecuzione (pid ${proc.pid})"></span>` : isDead ? `<span class="proc-dot dead" title="Terminato (exit ${proc.exitCode})"></span>` : ''}
        <span class="script-name">${esc(name)}</span>
        <span class="script-cmd">${esc(cmd||'npm ' + name)}</span>
        ${isRunning ? `<span class="proc-uptime" data-uptime="${proc.startedAt}">${formatUptime(proc.startedAt)}</span>` : ''}
        ${ports.map(port => `<span class="proc-port" title="Porta in uso">:${port}</span>`).join('')}
        <div class="script-actions">
          ${proc ? `
            <button class="btn btn-ghost btn-sm" onclick="App.streamProcess(${js(proc.id)},${js(name)})" title="Vedi log">📋</button>
            ${isRunning ? `
              <button class="btn btn-ghost btn-sm" onclick="App.restartProcess(${js(proc.id)})" title="Riavvia">↺</button>
              <button class="btn btn-disconnect btn-sm" onclick="App.stopProcess(${js(proc.id)})" title="Ferma">⏹</button>
            ` : `
              <button class="btn btn-npm btn-sm" onclick="App.runNpmScript(${js(p.id)},${js(name)})">▶ Riavvia</button>
              <button class="btn btn-ghost btn-sm" onclick="App.dismissProcess(${js(proc.id)})" title="Rimuovi">✕</button>
            `}
          ` : `<button class="btn btn-npm btn-sm" onclick="App.runNpmScript(${js(p.id)},${js(name)})">▶ Esegui</button>`}
          ${system.tools.pm2 ? `<button class="btn btn-ghost btn-sm" onclick="App.pm2StartScript(${js(p.id)},${js(name)})" title="Avvia con PM2">PM2</button>` : ''}
        </div>
      </div>`;
    }

    content.innerHTML = `
      <div class="scripts-grid">
        ${scriptRow('install', 'npm install')}
        ${scripts.map(([name, cmd]) => scriptRow(name, cmd)).join('')}
        ${!scripts.length ? '<p style="color:var(--muted);font-size:12px;margin-top:8px">Nessuno script in package.json</p>' : ''}
      </div>`;
  }

  async function renderPackagesTab(p) {
    const content = document.getElementById('npmTabContent');
    if (!content) return;
    content.innerHTML = `<div style="color:var(--muted);font-size:12px">Lettura pacchetti...</div>`;
    let pkg = { dependencies:{}, devDependencies:{} };
    try { pkg = await api.get(`/api/projects/${p.id}/package`); } catch {}

    const deps    = Object.entries(pkg.dependencies    || {});
    const devDeps = Object.entries(pkg.devDependencies || {});

    function depsTable(list, isDev) {
      if (!list.length) return '';
      return `
        <div class="pkg-section">
          <div class="pkg-section-title">${isDev ? 'devDependencies' : 'dependencies'} <span class="pkg-count">${list.length}</span></div>
          <table class="data-table">
            <thead><tr><th>Pacchetto</th><th>Versione config</th><th>Installata</th><th></th></tr></thead>
            <tbody>${list.map(([name, ver]) => `<tr>
              <td style="font-family:var(--font);color:var(--c-npm)">${esc(name)}</td>
              <td style="font-family:var(--font);color:var(--muted)">${esc(ver)}</td>
              <td style="font-family:var(--font)" id="pkgver_${btoa(name).replace(/=/g,'')}">
                <span style="color:var(--muted)">—</span>
              </td>
              <td>
                <button class="btn btn-ghost btn-sm" onclick="App.npmUpdate(${js(p.id)},${js(name)})" title="Aggiorna">↑ update</button>
              </td>
            </tr>`).join('')}</tbody>
          </table>
        </div>`;
    }

    content.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
        <button class="btn btn-npm btn-sm" onclick="App.runNpmScript(${js(p.id)},'install')">↓ npm install</button>
        <button class="btn btn-ghost btn-sm" onclick="App.npmOutdated(${js(p.id)})">🔍 Verifica aggiornamenti</button>
        <span id="outdatedStatus" style="font-size:11px;color:var(--muted)"></span>
      </div>
      ${depsTable(deps, false)}
      ${depsTable(devDeps, true)}
      ${(!deps.length && !devDeps.length) ? '<p style="color:var(--muted);font-size:12px">Nessuna dipendenza nel package.json</p>' : ''}`;

    loadInstalledVersions(p.id, [...deps, ...devDeps].map(([n]) => n));
  }

  // ---- STRUMENTI ESTERNI ----
  async function loadSystem(refresh = false) {
    try { system = await api.get('/api/core/system' + (refresh ? '?refresh=1' : '')); } catch {}
  }

  // ================================================================
  // GIT SECTION
  // ================================================================

  async function renderGitSection() {
    try { gitRepos = await api.get('/api/git/repos'); } catch { gitRepos = []; }
    updateBadges();

    // Sidebar: repos
    const sidebar = document.getElementById('sidebarContent');
    sidebar.innerHTML = `
      <div class="sidebar-head">
        <span class="sidebar-head-title">Repository</span>
        <button class="btn btn-ghost btn-sm" onclick="App.refreshGitSection()" title="Aggiorna">↻</button>
      </div>
      <div class="sidebar-body" id="gitReposList"></div>`;

    renderGitReposList();

    // Ri-renderizza main solo se il repo non è più valido
    const repoStillExists = activeGitRepo && gitRepos.some(r => r.id === activeGitRepo);
    if (!repoStillExists) {
      activeGitRepo = null;
      renderGitMain();
    }
    // Se il repo è valido, il DOM è già lì — non sovrascrivere
  }

  function renderGitReposList() {
    const el = document.getElementById('gitReposList');
    if (!el) return;
    if (!gitRepos.length) {
      el.innerHTML = `<p style="color:var(--muted);font-size:12px;padding:12px 14px">Nessun repo git trovato.<br><br>Aggiungi un progetto NPM nella sezione NPM — se ha una cartella <code style="font-size:10px">.git</code> apparirà qui.</p>`;
      return;
    }
    el.innerHTML = gitRepos.map(r => `
      <button class="sb-item ${activeGitRepo===r.id?'active':''}" onclick="App.selectGitRepo(${js(r.id)})">
        <span class="sb-icon">🌿</span>
        <span style="flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.label)}</span>
      </button>`).join('');
  }

  async function selectGitRepo(id) {
    activeGitRepo = id;
    gitStatus = null;
    gitSelectedFiles = new Set();
    renderGitReposList();
    renderGitMain();
    await loadGitStatus();
  }

  async function refreshGitSection() {
    await renderGitSection();
    if (activeGitRepo) await loadGitStatus();
  }

  async function loadGitStatus() {
    if (!activeGitRepo) return;
    try {
      gitStatus = await api.get(`/api/git/repos/${activeGitRepo}/status`);
    } catch(e) {
      gitStatus = null;
    }
    renderGitStatusPanel();
    renderGitHeader();
  }

  function renderGitMain() {
    const main = mainPanel('git');
    if (!activeGitRepo) {
      main.innerHTML = `<div class="empty-state"><div class="icon">🌿</div><p>Seleziona un repository dalla sidebar</p></div>`;
      return;
    }
    const repo = gitRepos.find(r => r.id === activeGitRepo);
    if (!repo) return;

    main.innerHTML = `
      <div class="git-area">
        <div class="git-repo-header" id="gitRepoHeader">
          <h3>🌿 ${esc(repo.label)}</h3>
          <span style="font-size:11px;color:var(--muted);font-family:var(--font)">${esc(repo.path)}</span>
        </div>
        <div class="git-action-bar">
          <input class="remote-input" id="gitRemote" value="origin" placeholder="remote" title="Remote name">
          <button class="btn btn-git btn-sm" onclick="App.gitAction('pull')" title="git pull">⬇ Pull</button>
          <button class="btn btn-ghost btn-sm" onclick="App.gitAction('push')" title="git push">⬆ Push</button>
          <button class="btn btn-ghost btn-sm" onclick="App.gitAction('pull_push')" title="git pull + push">⬇⬆ Pull & Push</button>
          <button class="btn btn-ghost btn-sm" onclick="App.gitAction('fetch')" title="git fetch --all --prune">🔄 Fetch</button>
          <button class="btn btn-ghost btn-sm" onclick="App.openMergeModal()" title="git merge">⑃ Merge</button>
          <button class="btn btn-ghost btn-sm" onclick="App.gitAction('stash')" title="git stash">📦 Stash</button>
          <button class="btn btn-ghost btn-sm" onclick="App.gitAction('stash_pop')" title="git stash pop">📤 Pop</button>
          <div style="margin-left:auto">
            <button class="btn btn-ghost btn-sm" onclick="App.loadGitStatus();App.loadGitLog()">↻ Ricarica</button>
          </div>
        </div>
        <div class="git-body">
          <!-- Status / commit col -->
          <div class="git-status-col">
            <div class="git-col-header">
              <h4>Modifiche</h4>
              <div style="display:flex;gap:4px">
                <button class="btn btn-ghost btn-sm" id="gitSelectAllBtn" onclick="App.gitToggleAll()" title="Seleziona/deseleziona tutti">☐ All</button>
              </div>
            </div>
            <div class="git-file-list" id="gitFileList">
              <div style="color:var(--muted);font-size:12px;padding:12px">Caricamento...</div>
            </div>
            <div class="git-commit-area">
              <textarea class="git-commit-msg" id="gitCommitMsg" rows="2" placeholder="Messaggio di commit..."></textarea>
              <div class="git-commit-actions">
                <button class="btn btn-git btn-sm" onclick="App.gitCommit()" style="flex:1">✓ Commit</button>
                <button class="btn btn-ghost btn-sm" onclick="App.gitCommitPush()" style="flex:1">✓ Commit & Push</button>
              </div>
            </div>
          </div>
          <!-- Log col -->
          <div class="git-log-col">
            <div class="git-col-header">
              <h4>Git Log</h4>
              <select id="gitLogLimit" onchange="App.loadGitLog()" class="remote-input" style="width:80px">
                <option value="30">30</option>
                <option value="50">50</option>
                <option value="100">100</option>
                <option value="500">500</option>
                <option value="1000">1000</option>
              </select>
            </div>
            <div id="gitLogLegend" style="display:none;flex-wrap:wrap;gap:4px;padding:6px 10px;border-bottom:1px solid var(--border);flex-shrink:0"></div>
            <div class="git-log-wrap" id="gitLogWrap">
              <div style="color:var(--muted);font-size:12px;padding:12px">Caricamento log...</div>
            </div>
          </div>
        </div>
      </div>`;

    loadGitStatus();
    loadGitLog();
  }

  function renderGitHeader() {
    const header = document.getElementById('gitRepoHeader');
    if (!header || !gitStatus) return;
    const repo = gitRepos.find(r => r.id === activeGitRepo);
    header.innerHTML = `
      <h3>🌿 ${esc(repo?.label||'')}</h3>
      <span class="git-branch-badge">⎇ ${esc(gitStatus.branch)}</span>
      ${gitStatus.ahead  > 0 ? `<span class="git-sync-badge git-sync-ahead">↑${gitStatus.ahead} ahead</span>`  : ''}
      ${gitStatus.behind > 0 ? `<span class="git-sync-badge git-sync-behind">↓${gitStatus.behind} behind</span>` : ''}
      ${gitStatus.stashCount > 0 ? `<span class="git-sync-badge" style="background:color-mix(in srgb,var(--c-pm2) 12%,transparent);color:var(--c-pm2);border:1px solid color-mix(in srgb,var(--c-pm2) 30%,transparent)">📦 ${gitStatus.stashCount} stash</span>` : ''}
      <span style="font-size:11px;color:var(--muted);font-family:var(--font)">${esc(repo?.path||'')}</span>`;
  }

  function renderGitStatusPanel() {
    const el = document.getElementById('gitFileList');
    if (!el) return;

    if (!gitStatus) {
      el.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:12px">Nessun dato</div>`;
      return;
    }

    if (!gitStatus.files.length) {
      el.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:12px;text-align:center">
        <div style="font-size:24px;margin-bottom:6px">✓</div>
        Working tree pulito
      </div>`;
      return;
    }

    const xyClass = (xy) => {
      const c = xy.trim()[0];
      if (c === 'M') return 'xy-M';
      if (c === 'A') return 'xy-A';
      if (c === 'D') return 'xy-D';
      if (c === 'R') return 'xy-R';
      if (c === '?') return 'xy-untracked';
      return '';
    };

    const xyLabel = (xy) => {
      const t = xy.trim();
      if (t === '??') return '?';
      if (t === 'M ' || t === ' M' || t === 'MM') return 'M';
      if (t === 'A ' || t === 'AM') return 'A';
      if (t === 'D ' || t === ' D') return 'D';
      if (t === 'R ' || t === 'RM') return 'R';
      return t[0] || '?';
    };

    el.innerHTML = gitStatus.files.map(f => {
      const label = xyLabel(f.xy);
      const cls   = xyClass(f.xy);
      const sel   = gitSelectedFiles.has(f.name);
      // Visualizza solo il basename ma tooltip completo
      const parts = f.name.split('/');
      const basename = parts[parts.length - 1];
      return `
        <div class="git-file ${sel?'selected':''}" onclick="App.gitToggleFile(${js(f.name)})" title="${esc(f.name)}">
          <span style="font-size:12px;flex-shrink:0">${sel ? '☑' : '☐'}</span>
          <span class="git-file-xy ${cls}">${esc(label)}</span>
          <span class="git-file-name">${esc(basename)}</span>
          ${parts.length > 1 ? `<span style="font-size:10px;color:var(--muted);font-family:var(--font);flex-shrink:0">${esc(parts.slice(0,-1).join('/'))}/</span>` : ''}
        </div>`;
    }).join('');

    // Update selectAll btn
    const btn = document.getElementById('gitSelectAllBtn');
    if (btn) {
      const allSelected = gitStatus.files.every(f => gitSelectedFiles.has(f.name));
      btn.textContent = allSelected ? '☑ All' : '☐ All';
    }
  }

  function gitToggleFile(name) {
    if (gitSelectedFiles.has(name)) gitSelectedFiles.delete(name);
    else gitSelectedFiles.add(name);
    renderGitStatusPanel();
  }

  function gitToggleAll() {
    if (!gitStatus) return;
    const allSelected = gitStatus.files.every(f => gitSelectedFiles.has(f.name));
    if (allSelected) gitSelectedFiles.clear();
    else gitStatus.files.forEach(f => gitSelectedFiles.add(f.name));
    renderGitStatusPanel();
  }

  // Palette colori per le lane del grafico (ciclica)
  const GIT_GRAPH_COLORS = ['#3fb950','#388bfd','#bc8cff','#f0883e','#58a6ff','#56d364','#d2a8ff','#ffa657','#79c0ff','#f778ba'];

  // Nome di branch più adatto tra i ref di un commit: niente tag né HEAD nudo,
  // "HEAD -> x" diventa x, a parità preferisce il nome più corto (main su origin/main)
  function bestBranchRef(refs) {
    const names = (refs || [])
      .filter(r => !r.startsWith('tag: ') && r !== 'HEAD' && !r.endsWith('/HEAD'))
      .map(r => r.replace(/^HEAD -> /, ''));
    return names.sort((a, b) => a.length - b.length)[0] || null;
  }

  // Branch unito da un merge commit, ricavato dal messaggio standard di git/GitHub/GitLab
  function mergedBranchName(subject) {
    const patterns = [
      /^Merge (?:remote-tracking )?branch '([^']+)'/,          // git merge
      /^Merge pull request #\d+ from [^/\s]+\/(\S+)/,          // GitHub
      /^Merge branch "([^"]+)"/,
    ];
    for (const re of patterns) {
      const m = re.exec(subject || '');
      if (m) return m[1];
    }
    return null;
  }

  function buildGitGraph(entries, allRefs = {}) {
    // Algoritmo: assegna ogni commit a una lane, mantieni le lane aperte tra una riga e l'altra
    // lanes[i] = hash del commit che "occupa" quella lane (il prossimo commit atteso)
    const ROW_H = 26, COL_W = 16, R = 4, STROKE = 1.5;
    const hashMap = new Map(entries.map(e => [e.hash, e]));
    const laneColor = {}; // lane index → indice colore nella palette
    let colorCounter = 0; // contatore globale per assegnare colori progressivi

    const assignColor = (laneIdx) => {
      if (laneColor[laneIdx] === undefined) {
        laneColor[laneIdx] = colorCounter % GIT_GRAPH_COLORS.length;
        colorCounter++;
      }
    };

    let lanes = []; // array di hash: lanes[i] = hash del commit che "deve arrivare" in quella lane
    let laneNames = []; // laneNames[i] = nome del branch che la lane sta percorrendo (o null)

    const result = entries.map((e, ri) => {
      const { hash, parents } = e;

      // Trova la lane di questo commit
      let myLane = lanes.indexOf(hash);
      if (myLane === -1) {
        // Nessuna lane lo aspettava → nuova lane
        myLane = lanes.indexOf(null); // ricicla slot libero
        if (myLane === -1) myLane = lanes.length;
        lanes[myLane] = hash;
        laneNames[myLane] = null; // slot riciclato: il nome del branch precedente non vale più
      }

      // Nome del branch: un ref sul commit vince, altrimenti si eredita dalla lane
      const name = bestBranchRef(e.refs) || laneNames[myLane] || null;

      // Assegna colore alla lane se non ce l'ha
      assignColor(myLane);
      const myColor = GIT_GRAPH_COLORS[laneColor[myLane]];

      // Snapshot delle lane PRIMA della modifica (per disegnare le linee in entrata)
      const lanesIn = [...lanes];

      // Aggiorna le lane: sostituisci hash con i parent
      lanes[myLane] = parents[0] || null; // primo parent continua la lane
      laneNames[myLane] = parents[0] ? name : null; // ...e il nome del branch
      // parent aggiuntivi (merge): cerca slot libero o aggiunge
      const mergedName = mergedBranchName(e.subject);
      for (let p = 1; p < parents.length; p++) {
        const parentHash = parents[p];
        // Se il parent è già in una lane, non duplicare
        if (!lanes.includes(parentHash)) {
          let free = lanes.indexOf(null);
          if (free !== -1) {
            lanes[free] = parentHash;
            // Slot riciclato: forza nuovo colore (il vecchio branch è finito)
            laneColor[free] = colorCounter % GIT_GRAPH_COLORS.length;
            colorCounter++;
          } else {
            free = lanes.length;
            assignColor(free);
            lanes.push(parentHash);
          }
          // Il ramo unito prende il nome dal messaggio di merge ("Merge branch 'x'")
          laneNames[free] = p === 1 ? mergedName : null;
        } else if (p === 1 && mergedName) {
          const idx = lanes.indexOf(parentHash);
          if (!laneNames[idx]) laneNames[idx] = mergedName;
        }
      }

      // Rimuovi null in coda (compatta)
      while (lanes.length && lanes[lanes.length - 1] === null) { lanes.pop(); laneNames.pop(); }

      // Snapshot DOPO la modifica (lane in uscita)
      const lanesOut = [...lanes];
      const maxLanes = Math.max(lanesIn.length, lanesOut.length, myLane + 1);

      return { e, myLane, myColor, lanesIn, lanesOut, maxLanes, name };
    });
    // finalLanes: stato delle lane DOPO l'ultimo commit visualizzato
    // lanes[i] contiene l'hash del parent atteso fuori dal range
    const finalLanes = [...lanes];

    // Larghezza SVG = max lane usate
    const globalMax = Math.min(result.reduce((m, r) => Math.max(m, r.maxLanes), 1), 10);
    const SVG_W = globalMax * COL_W + 8;

    const svgs = result.map(({ e, myLane, myColor, lanesIn, lanesOut, maxLanes }) => {
      const parts = [];
      const H = ROW_H;
      const mid = H / 2;

      const cx = (lane) => lane * COL_W + COL_W / 2 + 4;

      // Disegna le lane che passano dritte (presenti sia in entrata che in uscita)
      const allLanes = new Set([...lanesIn.keys(), ...lanesOut.keys()]);
      allLanes.forEach(i => {
        if (i === myLane) return; // gestito dopo
        const inHash = lanesIn[i];
        const outHash = lanesOut[i];
        if (inHash && outHash && inHash === outHash) {
          // Linea dritta verticale
          const x = cx(i);
          const color = GIT_GRAPH_COLORS[laneColor[i] ?? (i % GIT_GRAPH_COLORS.length)];
          parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round"/>`);
        }
      });

      // Connettori verso i parent (linee che escono dal nodo verso le lane in uscita)
      e.parents.forEach((ph, pi) => {
        const targetLane = lanesOut.indexOf(ph);
        if (targetLane === -1) return;
        const x1 = cx(myLane), y1 = mid + R + 1;
        const x2 = cx(targetLane), y2 = H;
        const color = pi === 0 ? myColor : GIT_GRAPH_COLORS[laneColor[targetLane] ?? (targetLane % GIT_GRAPH_COLORS.length)];
        if (x1 === x2) {
          parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round"/>`);
        } else {
          // Curva bezier per merge/fork
          const mx = x1, my = y2;
          parts.push(`<path d="M${x1},${y1} C${mx},${my} ${x2},${y1} ${x2},${y2}" fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round"/>`);
        }
      });

      // Linea in entrata verso il nodo (dalla riga precedente)
      if (lanesIn[myLane] === e.hash) {
        const x = cx(myLane);
        parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${mid - R - 1}" stroke="${myColor}" stroke-width="${STROKE}" stroke-linecap="round"/>`);
      }

      // Nodo cerchio
      const nx = cx(myLane), ny = mid;
      const isHead = (e.refs || []).some(r => r.startsWith('HEAD'));
      if (isHead) {
        parts.push(`<circle cx="${nx}" cy="${ny}" r="${R + 1}" fill="${myColor}" stroke="${myColor}" stroke-width="${STROKE}"/>`);
        parts.push(`<circle cx="${nx}" cy="${ny}" r="${R - 1}" fill="var(--bg)"/>`);
        parts.push(`<circle cx="${nx}" cy="${ny}" r="${R - 3}" fill="${myColor}"/>`);
      } else {
        parts.push(`<circle cx="${nx}" cy="${ny}" r="${R}" fill="var(--bg)" stroke="${myColor}" stroke-width="${STROKE}"/>`);
        parts.push(`<circle cx="${nx}" cy="${ny}" r="${R - 2.5}" fill="${myColor}"/>`);
      }

      return `<svg width="${SVG_W}" height="${H}" viewBox="0 0 ${SVG_W} ${H}" style="display:block;flex-shrink:0">${parts.join('')}</svg>`;
    });

    // Legenda: una voce per branch (nome + colore della lane in cui compare per primo).
    // Righe ancora senza nome: si prova con l'hash che la lane aspetta a fine range
    // (allRefs mappa i tip dei branch), poi "branch-N" come ultima risorsa.
    const legend = [];
    const seen = new Set();
    result.forEach(({ myLane, myColor, name }) => {
      let label = name;
      if (!label) {
        const pending = finalLanes[myLane];
        const names = pending && allRefs[pending];
        label = names ? bestBranchRef(names) : `branch-${myLane + 1}`;
      }
      if (seen.has(label)) return;
      seen.add(label);
      legend.push({ color: myColor, label, laneIdx: myLane });
    });

    return { svgs, svgW: SVG_W, legend };
  }

  async function loadGitLog() {
    const wrap = document.getElementById('gitLogWrap');
    if (!wrap || !activeGitRepo) return;
    const limit = document.getElementById('gitLogLimit')?.value || 30;
    wrap.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:12px">Caricamento...</div>`;
    try {
      const data = await api.get(`/api/git/repos/${activeGitRepo}/log?limit=${limit}`);
      const entries = data.entries || data; // compatibilità con vecchio formato
      const allRefs = data.refs || {}; // hash → [branchName, ...]
      if (!entries.length) { wrap.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:12px">Nessun commit</div>`; return; }

      const { svgs, svgW, legend } = buildGitGraph(entries, allRefs);
      const localBranches = new Set(data.localBranches || []);
      // Remoti = ref esistenti non locali (un branch unito e cancellato non è né l'uno né l'altro)
      const remoteBranches = new Set(Object.values(allRefs).flat().filter(n => !localBranches.has(n)));

      // Render legenda rami
      const legendEl = document.getElementById('gitLogLegend');
      if (legendEl) {
        if (legend.length) {
          legendEl.innerHTML = legend.map(({ color, label }) => {
            const isAnon = /^branch-\d+$/.test(label);
            let icon = isAnon ? '●' : '⎇';
            if (!isAnon && label === gitStatus?.branch) icon = '◉';           // branch corrente
            else if (!isAnon && remoteBranches.has(label)) icon = '↗';        // remoto
            const opacity = isAnon ? '0.55' : '1';
            return `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:10px;font-size:10px;font-family:var(--font);background:color-mix(in srgb,${color} 12%,transparent);border:1px solid color-mix(in srgb,${color} 40%,transparent);color:${color};white-space:nowrap;opacity:${opacity}">${icon} ${esc(label)}</span>`;
          }).join('');
          legendEl.style.display = 'flex';
        } else {
          legendEl.innerHTML = '';
          legendEl.style.display = 'none';
        }
      }

      const rows = entries.map((e, i) => {
        const svg = svgs[i];
        if (!e.hash) {
          return `<tr><td class="git-graph-cell">${svg}</td><td></td><td></td><td></td><td></td></tr>`;
        }
        const refs = (e.refs || []).map(ref => {
          let cls = 'git-ref-local';
          if (ref.startsWith('HEAD')) cls = 'git-ref-head';
          else if (ref.includes('/')) cls = 'git-ref-remote';
          else if (ref.startsWith('tag:')) cls = 'git-ref-tag';
          return `<span class="git-ref ${cls}">${esc(ref.replace('tag: ',''))}</span>`;
        }).join('');

        const dataIdx = i;
        return `<tr class="git-log-row" onclick="App.showCommitDetail(${dataIdx})" style="cursor:pointer">
          <td class="git-graph-cell">${svg}</td>
          <td><span class="git-hash" title="${esc(e.hash)}">${esc(e.short)}</span></td>
          <td style="overflow:hidden"><span class="git-subject">${refs}${esc(e.subject)}</span></td>
          <td class="git-author">${esc(e.author)}</td>
          <td class="git-date">${esc(e.relDate)}</td>
        </tr>`;
      }).join('');

      const thStyle = `style="color:var(--muted);font-size:10px;padding:4px 6px;font-weight:500;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--border);background:var(--surface)"`;
      gitLogEntries = entries;
      wrap.innerHTML = `<table class="git-log-table" style="--graph-w:${svgW}px">
        <colgroup>
          <col class="col-graph">
          <col class="col-hash">
          <col class="col-msg">
          <col class="col-author">
          <col class="col-date">
        </colgroup>
        <thead><tr>
          <th ${thStyle}></th>
          <th ${thStyle}>SHA</th>
          <th ${thStyle}>Messaggio</th>
          <th ${thStyle}>Autore</th>
          <th ${thStyle}>Data</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    } catch(e) {
      wrap.innerHTML = `<div style="color:var(--danger);font-size:12px;padding:12px">Errore: ${esc(e.message)}</div>`;
    }
  }

  function showCommitDetail(idx) {
    const e = gitLogEntries[idx];
    if (!e) return;
    // Evidenzia riga subito
    document.querySelectorAll('.git-log-row').forEach((r,i) => r.classList.toggle('git-row-active', i === idx));
    // Rimuovi eventuale drawer precedente
    document.getElementById('gitCommitDrawer')?.remove();
    const refs = (e.refs || []).map(ref => {
      let cls = 'git-ref-local';
      if (ref.startsWith('HEAD')) cls = 'git-ref-head';
      else if (ref.includes('/')) cls = 'git-ref-remote';
      else if (ref.startsWith('tag:')) cls = 'git-ref-tag';
      return `<span class="git-ref ${cls}">${esc(ref.replace('tag: ',''))}</span>`;
    }).join('');
    const parents = (e.parents || []).map(p => `<span class="git-hash" style="cursor:default">${esc(p.slice(0,7))}</span>`).join(' ');
    const drawer = document.createElement('div');
    drawer.id = 'gitCommitDrawer';
    drawer.style.cssText = `position:absolute;bottom:0;left:0;right:0;background:var(--surface2);border-top:2px solid var(--c-git);padding:14px 16px;z-index:20;font-size:12px;animation:slideUp .15s ease`;
    drawer.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px;color:var(--text);margin-bottom:6px;white-space:normal;word-break:break-word">${refs}${esc(e.subject)}</div>
          <div id="gitCommitBody" style="font-family:var(--font);font-size:11px;color:var(--muted);white-space:pre-wrap;word-break:break-word;margin-bottom:6px;line-height:1.6"></div>
          <div style="display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:11px">
            <span>👤 ${esc(e.author)}</span>
            <span>🕐 ${esc(e.relDate)}</span>
            <span style="font-family:var(--font)">SHA: <span class="git-hash" onclick="navigator.clipboard&&navigator.clipboard.writeText(${js(e.hash)})" title="Click per copiare" style="cursor:pointer">${esc(e.hash)}</span></span>
            ${parents ? `<span style="font-family:var(--font)">Parent: ${parents}</span>` : ''}
          </div>
        </div>
        <button onclick="document.getElementById('gitCommitDrawer')?.remove()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;padding:0;flex-shrink:0" title="Chiudi">✕</button>
      </div>`;
    // Monta nel log-col
    const logCol = document.querySelector('.git-log-col');
    if (logCol) { logCol.style.position = 'relative'; logCol.appendChild(drawer); }
    // Carica il body completo del commit in modo asincrono
    api.get(`/api/git/repos/${activeGitRepo}/commit/${encodeURIComponent(e.hash)}`)
      .then(data => {
        const bodyEl = document.getElementById('gitCommitBody');
        if (!bodyEl) return;
        // Il body da git show include subject + blank line + body
        // Rimuoviamo il subject (prima riga) per mostrare solo il corpo
        const lines = (data.body || '').split('\n');
        // Salta la prima riga (subject) e l'eventuale riga vuota dopo
        let start = 1;
        while (start < lines.length && lines[start].trim() === '') start++;
        const body = lines.slice(start).join('\n').trimEnd();
        if (body) bodyEl.textContent = body;
      })
      .catch(() => {}); // silenzioso se fallisce
  }

  async function gitAction(action) {
    const remote = document.getElementById('gitRemote')?.value || 'origin';
    const branch = gitStatus?.branch;
    if (action === 'push' || action === 'pull_push') {
      await loadGitStatus();
      await loadGitLog();
    }
    openSsePanel(`git ${action} (${remote})`);
    // Una sola richiesta: lo stream SSE arriva nella risposta della POST stessa
    gitRunSse({ action, remote, branch });
  }

  async function gitCommit(andPush = false) {
    const msg = document.getElementById('gitCommitMsg')?.value?.trim();
    if (!msg) { toast('Inserisci un messaggio di commit', 'error'); return; }
    const files = gitSelectedFiles.size > 0 ? [...gitSelectedFiles] : [];
    const remote = document.getElementById('gitRemote')?.value || 'origin';
    const branch = gitStatus?.branch;

    openSsePanel(andPush ? 'git commit & push' : 'git commit');
    const exitCode = await gitRunSse({ action: 'commit', message: msg, files, remote, branch });

    if (andPush) {
      if (exitCode !== 0) {
        appendSse('\n[push annullato: commit fallito]\n', 'sys');
      } else {
        appendSse(`\n$ git push ${remote} ${branch || ''}\n`, 'sys');
        await gitRunSse({ action: 'push', remote, branch });
      }
    }

    // Reset form
    const msgEl = document.getElementById('gitCommitMsg');
    if (msgEl) msgEl.value = '';
    gitSelectedFiles.clear();
  }

  function gitCommitPush() { gitCommit(true); }

  function openMergeModal() {
    openModal('Merge branch', `
      <div class="form-row">
        <label>Branch da fare merge nel branch corrente (${esc(gitStatus?.branch||'?')})</label>
        <input class="form-input" id="f_merge_branch" placeholder="es. main, develop, feature/xyz">
      </div>`, `
      <button class="btn btn-ghost" onclick="App.closeModal()">Annulla</button>
      <button class="btn btn-git" onclick="App.gitMerge()">⑃ Merge</button>`);
  }

  async function gitMerge() {
    const branch = document.getElementById('f_merge_branch')?.value?.trim();
    if (!branch) { toast('Specifica un branch', 'error'); return; }
    closeModal();
    openSsePanel(`git merge ${branch}`);
    await gitRunSse({ action: 'merge', branch });
  }

  function gitRunSse(body) {
    if (sseSource) { sseSource.close(); sseSource = null; }
    const streamSection = section; // cattura sezione corrente
    return new Promise(resolve => {
      fetch(`/api/git/repos/${activeGitRepo}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async res => {
        // Errori di validazione arrivano come JSON prima dello stream
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          appendSseToSection(streamSection, '\nErrore: ' + (d.error || `HTTP ${res.status}`) + '\n', 'err');
          resolve(1);
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const part of parts) {
            const line = part.replace(/^data: /, '');
            if (!line.trim()) continue;
            try {
              const { type, data } = JSON.parse(line);
              if (type === 'stdout') appendSseToSection(streamSection, data, 'out');
              else if (type === 'stderr') appendSseToSection(streamSection, data, 'err');
              else if (type === 'error') appendSseToSection(streamSection, '\nErrore: ' + data + '\n', 'err');
              else if (type === 'exit') {
                appendSseToSection(streamSection, `\n[exit ${data}]`, 'sys');
                // Ricarica status e log dopo ogni operazione
                setTimeout(() => { loadGitStatus(); loadGitLog(); }, 400);
                resolve(data);
              }
            } catch {}
          }
        }
        resolve(0);
      }).catch(e => { appendSseToSection(streamSection, '\n' + e.message, 'err'); resolve(1); });
    });
  }

  // SETTINGS SECTION
  // ---- REFRESH ----
  async function refresh() {
    try {
      activeProcesses = await api.get('/api/processes');
      renderActivePills();
      updateBadges();

      // Aggiorna la sezione attiva senza ridisegnare tutto
      if (section === 'npm') {
        renderNpmProjectsList();
        // Aggiorna stato scripts se visibile
        if (npmActiveTab === 'scripts' && activeProject) {
          const p = npmProjects.find(x => x.id === activeProject);
          if (p) renderScriptsTab(p);
        }
      }
    } catch(e) { toast('Errore connessione al server','error'); }
  }

  // ---- NPM ACTIONS ----
  async function loadNpmProjects() {
    try { npmProjects = await api.get('/api/projects'); } catch { npmProjects = []; }
  }

  async function runNpmScript(projectId, script) {
    const label = `npm ${script === 'install' ? 'install' : 'run ' + script}`;
    try {
      const r = await api.post(`/api/projects/${projectId}/npm/start`, { script });
      toast(`Avviato: ${label}`, 'success');
      activeProcesses = await api.get('/api/processes');
      renderActivePills(); updateBadges();
      const p = npmProjects.find(x => x.id === projectId);
      if (p) await renderScriptsTab(p);
      streamProcess(r.id, label);
    } catch(e) { toast(e.message, 'error'); }
  }

  function streamProcess(procId, label) {
    openSsePanel(label || procId);
    if (sseSource) sseSource.close();
    const streamSection = section; // cattura la sezione al momento dell'apertura
    sseSource = new EventSource(`/api/processes/${procId}/stream`);
    sseSource.onmessage = e => {
      const { type, data } = JSON.parse(e.data);
      if (type === 'history') appendSseToSection(streamSection, data, 'out');
      else if (type === 'exit') { appendSseToSection(streamSection, data, 'sys'); sseSource.close(); sseSource = null; }
      else appendSseToSection(streamSection, data, type === 'stderr' ? 'err' : 'out');
    };
    sseSource.onerror = () => { appendSseToSection(streamSection, '\n[connessione persa]', 'err'); sseSource.close(); sseSource = null; };
  }

  async function stopProcess(procId) {
    try {
      await api.del(`/api/processes/${procId}`);
      toast('Processo fermato', 'success');
      activeProcesses = await api.get('/api/processes');
      renderActivePills(); updateBadges();
      const p = npmProjects.find(x => x.id === activeProject);
      if (p && section === 'npm') await renderScriptsTab(p);
    } catch(e) { toast(e.message, 'error'); }
  }

  async function restartProcess(procId) {
    try {
      await api.post(`/api/processes/${procId}/restart`, {});
      toast('Processo riavviato', 'success');
      activeProcesses = await api.get('/api/processes');
      renderActivePills(); updateBadges();
      const p = npmProjects.find(x => x.id === activeProject);
      if (p && section === 'npm') await renderScriptsTab(p);
      const pd = activeProcesses.find(x => x.id === procId);
      if (pd) streamProcess(procId, `npm ${pd.script === 'install' ? 'install' : 'run ' + pd.script}`);
    } catch(e) { toast(e.message, 'error'); }
  }

  async function dismissProcess(procId) {
    try {
      await api.del(`/api/processes/${procId}/dismiss`);
      activeProcesses = await api.get('/api/processes');
      renderActivePills(); updateBadges();
      const p = npmProjects.find(x => x.id === activeProject);
      if (p && section === 'npm') await renderScriptsTab(p);
    } catch(e) { toast(e.message, 'error'); }
  }

  async function loadInstalledVersions(projectId, names) {
    if (!names.length) return;
    try {
      const data = await api.post(`/api/projects/${projectId}/installed-versions`, { packages: names });
      for (const [name, ver] of Object.entries(data)) {
        const el = document.getElementById(`pkgver_${btoa(name).replace(/=/g,'')}`);
        if (el) el.innerHTML = ver
          ? `<span style="color:var(--success)">${esc(ver)}</span>`
          : `<span style="color:var(--muted)">non installato</span>`;
      }
    } catch {}
  }

  async function npmOutdated(projectId) {
    const status = document.getElementById('outdatedStatus');
    if (status) status.textContent = 'Controllo in corso...';
    try {
      const data = await api.get(`/api/projects/${projectId}/outdated`);
      const outdated = Object.entries(data);
      if (!outdated.length) { if (status) status.textContent = '✓ Tutti aggiornati'; return; }
      if (status) status.textContent = `${outdated.length} aggiornamenti disponibili`;
      for (const [name, info] of outdated) {
        const el = document.getElementById(`pkgver_${btoa(name).replace(/=/g,'')}`);
        if (el) el.innerHTML = `<span style="color:var(--warning)">${esc(info.current)}</span> → <span style="color:var(--success)">${esc(info.latest)}</span>`;
      }
    } catch(e) { if (status) status.textContent = 'Errore: ' + e.message; }
  }

  async function npmUpdate(projectId, packageName) {
    try {
      toast(`Aggiornamento ${packageName}...`);
      const r = await api.post(`/api/projects/${projectId}/npm/update`, { package: packageName });
      streamProcess(r.id, `npm update ${packageName}`);
    } catch(e) { toast(e.message, 'error'); }
  }

  // ---- PM2 ACTIONS ----
  async function pm2StartScript(projectId, script) {
    const p = npmProjects.find(x => x.id === projectId);
    if (!p) return;
    try {
      await api.post('/api/ext/pm2/action', { action: 'start', projectId, script });
      toast(`PM2: ${script} avviato`, 'success');
    } catch(e) { toast('PM2 errore: ' + e.message, 'error'); }
  }

  // ---- PROJECT ACTIONS ----
  function modalAddProject() {
    openModal('Nuovo progetto', `
      <div class="form-row">
        <label>ID (snake_case, non modificabile)</label>
        <input class="form-input" id="f_proj_id" placeholder="es. my_app">
      </div>
      <div class="form-row">
        <label>Nome</label>
        <input class="form-input" id="f_proj_label" placeholder="es. My App">
      </div>
      <div class="form-row">
        <label>Percorso assoluto cartella</label>
        <input class="form-input" id="f_proj_path" placeholder="/home/user/projects/my-app">
      </div>`, `
      <button class="btn btn-ghost" onclick="App.closeModal()">Annulla</button>
      <button class="btn btn-npm" onclick="App.saveProject()">Aggiungi</button>`);
  }

  async function saveProject() {
    const id    = (document.getElementById('f_proj_id')?.value||'').trim();
    const label = (document.getElementById('f_proj_label')?.value||'').trim();
    const path  = (document.getElementById('f_proj_path')?.value||'').trim();
    if (!id||!label||!path) { toast('Tutti i campi sono obbligatori','error'); return; }
    try {
      await api.post('/api/projects', { id, label, path });
      closeModal(); toast('Progetto aggiunto','success');
      await loadNpmProjects();
      if (section === 'npm') renderNpmSection();
    } catch(e) { toast(e.message,'error'); }
  }

  async function deleteProject(id) {
    if (!confirm('Rimuovere questo progetto dalla lista?')) return;
    try {
      await api.del(`/api/projects/${id}`);
      if (activeProject === id) activeProject = null;
      toast('Progetto rimosso','success');
      await loadNpmProjects();
      if (section === 'npm') renderNpmSection();
    } catch(e) { toast(e.message,'error'); }
  }

  // ---- SSE PANEL (per-section) ----
  function ssePanelEl()  { return document.getElementById(`ssePanel-${section}`); }
  function sseTitleEl()  { return document.getElementById(`ssePanelTitle-${section}`); }
  function sseBodyEl()   { return document.getElementById(`sseBody-${section}`); }

  function openSsePanel(title) {
    const titleEl = sseTitleEl();
    const bodyEl  = sseBodyEl();
    const panel   = ssePanelEl();
    if (!panel) return;
    if (titleEl) titleEl.textContent = title;
    if (bodyEl)  bodyEl.innerHTML = '';
    panel.classList.add('open');
  }
  function closeSsePanel() {
    if (sseSource) { sseSource.close(); sseSource = null; }
    const panel = ssePanelEl();
    if (panel) panel.classList.remove('open');
  }
  function clearSseOutput() {
    const bodyEl = sseBodyEl();
    if (bodyEl) bodyEl.innerHTML = '';
  }

  // appendSse nella sezione corrente
  function appendSse(text, cls='out') {
    appendSseToSection(section, text, cls);
  }
  // appendSse in una sezione specifica (per stream aperti cross-section)
  function appendSseToSection(sec, text, cls='out') {
    const body = document.getElementById(`sseBody-${sec}`);
    if (!body) return;
    const el = document.createElement('span');
    if (cls==='sys') { el.className='ansi-sys'; el.textContent=text; }
    else if (cls==='err') { el.innerHTML=ansiToHtml(text); el.classList.add('ansi-stderr'); }
    else el.innerHTML=ansiToHtml(text);
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
  }

  // ---- INIT ----
  async function init() {
    await window.Shell?.init();
    await loadSystem();
    await refresh();
    goSection(window.Shell?.firstSection() || 'npm');
    setInterval(refresh, 5000);
  }
  init();

  return {
    goSection,
    closeModal,
    // NPM
    selectNpmProject, switchNpmTab,
    modalAddProject, saveProject, deleteProject,
    runNpmScript, streamProcess, stopProcess, restartProcess, dismissProcess,
    npmOutdated, npmUpdate,
    // PM2
    pm2StartScript,
    closeSsePanel, clearSseOutput,
    refresh,
    // Git
    selectGitRepo, refreshGitSection,
    loadGitStatus, loadGitLog,
    gitToggleFile, gitToggleAll,
    gitAction, gitCommit, gitCommitPush,
    openMergeModal, gitMerge,
    showCommitDetail,
  };
})();

// La shell delle estensioni naviga tramite App.goSection
window.App = App;
