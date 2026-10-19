// Sezioni non ancora migrate a estensioni (tunnel, npm, pm2, git, swagger, settings)
const App = (() => {
  const { esc, js, cssColor, ansiToHtml, toast, openModal, closeModal } = window.UI;

  let groups = [];
  let tunnels = [];
  let config = { groups: [], servers: [] };
  let activeGroup = null;
  let settingsGroup = null;
  let section = 'tunnel'; // 'tunnel' | 'npm' | 'pm2' | 'git' | 'swagger' | 'settings'
  let logPollInterval = null;
  let logTunnelId = null;
  let notificationsEnabled = false;
  let prevTunnelIds = new Set();
  let system = { platform: null, tools: {} }; // strumenti esterni disponibili (/api/system)

  // NPM/PM2 state
  let npmProjects = [];
  let activeProject = null;
  let npmActiveTab = 'scripts';
  let sseSource = null;
  let pm2List = [];
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
  // altrimenti cade su mainArea-{sec} (tunnel, swagger e settings non hanno pannello SSE).
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
    ['tunnel','npm','pm2','git','swagger','settings'].forEach(s => {
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
    closeLogs(); // chiudi log drawer SSH al cambio sezione (rimane globale)

    // Update section tabs
    ['tunnel','npm','git','swagger'].forEach(s => {
      const el = document.getElementById('nav' + s.charAt(0).toUpperCase() + s.slice(1));
      if (!el) return;
      el.className = 'section-tab' + (section === s ? ` active-${s}` : '');
    });
    // Tunnel tab resta attivo anche quando si è in pm2/settings (sezioni "nascoste")
    const navTunnel = document.getElementById('navTunnel');
    if (navTunnel && (section === 'pm2' || section === 'settings')) {
      navTunnel.className = 'section-tab active-tunnel';
    }

    // Update sidebar data-section
    document.getElementById('sidebar').dataset.section = sec;

    // Mostra il pannello giusto
    switchMainPanel(sec);

    // Render section (aggiorna sidebar + eventuale refresh leggero)
    if (sec === 'tunnel')        renderTunnelSection();
    else if (sec === 'npm')      renderNpmSection();
    else if (sec === 'pm2')      renderPm2Section();
    else if (sec === 'git')      renderGitSection();
    else if (sec === 'swagger')  renderSwaggerSection();
    else if (sec === 'settings') renderSettingsSection();
  }

  // ---- SECTION BADGES ----
  function updateBadges() {
    const t = document.getElementById('badgeTunnel');
    const n = document.getElementById('badgeNpm');
    const p = document.getElementById('badgePm2');
    const g = document.getElementById('badgeGit');
    if (t) t.textContent = tunnels.length;
    if (n) {
      const running = activeProcesses.filter(x => x.running).length;
      n.textContent = npmProjects.length + (running ? ` · ${running}▶` : '');
    }
    if (p) p.textContent = pm2List.length;
    if (g) g.textContent = gitRepos.length;
  }

  // ---- PILLS HEADER ----
  function renderActivePills() {
    const pills = document.getElementById('activePills');
    const btn   = document.getElementById('stopAllBtn');
    btn.style.display = tunnels.length > 0 ? '' : 'none';

    const tunnelPills = tunnels.map(t => `
      <span class="pill pill-tunnel ${t.reconnecting?'reconnecting':''}"
            onclick="App.goSection('tunnel')"
            title="${esc(t.label)} :${t.port}${t.reconnecting?' (riconnessione)':''}">
        <span class="pill-dot"></span>
        ${esc(t.label)}<span style="opacity:.7">:${t.port}</span>
        <span style="cursor:pointer;opacity:.5;margin-left:2px" onclick="event.stopPropagation();App.stopTunnel(${js(t.id)})">✕</span>
      </span>`).join('');

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

    pills.innerHTML = tunnelPills + npmPills;
  }

  // ================================================================
  // TUNNEL SECTION
  // ================================================================
  function renderTunnelSection() {
    // Sidebar: groups
    const sidebar = document.getElementById('sidebarContent');
    sidebar.innerHTML = `
      <div class="sidebar-head">
        <span class="sidebar-head-title">Gruppi</span>
        <button class="btn btn-ghost btn-sm" onclick="App.goSection('settings')" title="Configurazione">≡</button>
      </div>
      <div class="sidebar-body" id="tunnelGroupsList">
        ${groups.length === 0
          ? '<p style="color:var(--muted);font-size:12px;padding:12px 14px">Nessun gruppo</p>'
          : groups.map(g => {
              const cnt = tunnels.filter(t => g.servers.some(s => s.key === t.serverKey)).length;
              return `<button class="sb-item ${activeGroup===g.key?'active':''}" onclick="App.selectGroup(${js(g.key)})">
                <span class="sb-dot" style="background:${cssColor(g.color)}"></span>
                <span style="flex:1;text-align:left">${esc(g.label)}</span>
                ${cnt>0
                  ? `<span class="sb-count" style="color:${cssColor(g.color)};border-color:${cssColor(g.color)}">${cnt}</span>`
                  : `<span class="sb-count">${g.servers.length}</span>`}
              </button>`;
            }).join('')}
      </div>`;

    // Main area — sempre aggiornata (i tunnel cambiano stato spesso)
    renderTunnelMain();
  }

  function renderTunnelMain() {
    const main = mainPanel('tunnel');
    if (!activeGroup) {
      main.innerHTML = `<div class="empty-state"><div class="icon">🔗</div><p>Seleziona un gruppo dalla sidebar</p></div>`;
      return;
    }
    const g = groups.find(x => x.key === activeGroup);
    if (!g) return;
    const activeCnt = tunnels.filter(t => g.servers.some(s => s.key === t.serverKey)).length;
    main.innerHTML = `
      <div class="section-banner" style="border-left:3px solid ${cssColor(g.color)}">
        <span class="section-banner-dot" style="background:${cssColor(g.color)}"></span>
        <h2>${esc(g.label)}</h2>
        ${activeCnt > 0 ? `<span class="section-banner-sub">${activeCnt} connessi</span>` : ''}
        <div style="margin-left:auto;display:flex;gap:8px">
          ${activeCnt>0?`<button class="btn btn-danger btn-sm" onclick="App.stopGroupTunnels(${js(g.key)})">⏹ Disconnetti tutti</button>`:''}
        </div>
      </div>
      ${missingToolNotice('autossh', 'autossh non installato: i tunnel usano ssh e la riconnessione è gestita da DevDock.', system.platform === 'darwin' ? 'brew install autossh' : 'sudo apt install autossh')}
      <div class="server-area">
        <div class="server-grid">${g.servers.map(s=>renderServerCard(s)).join('')}</div>
        ${g.servers.length===0?'<div class="empty-state" style="height:auto;padding:40px 0"><div class="icon">🖥</div><p>Nessun server in questo gruppo</p></div>':''}
      </div>`;
  }

  function renderServerCard(s) {
    const t = tunnels.find(t => t.serverKey === s.key);
    return `<div class="server-card ${t?'connected':''}" id="card_${esc(s.key)}">
      <div class="card-top">
        <span class="card-label">${esc(s.label)}</span>
        <span class="type-badge">${esc(s.type||'TCP')}</span>
      </div>
      <div class="card-meta">
        <div>alias: <span class="val">${esc(s.alias)}</span></div>
        <div>remote: <span class="val">${esc(s.remote)}</span></div>
      </div>
      ${t ? `<div class="card-meta" style="border-top:1px solid var(--border);padding-top:8px;margin-top:-2px">
        <div>pid: <span class="val">${t.pid||'—'}</span></div>
        <div>uptime: <span class="val" data-uptime="${t.startedAt}">${formatUptime(t.startedAt)}</span></div>
      </div>` : ''}
      <div class="card-bottom">
        ${t
          ? `<span class="connected-status ${t.reconnecting?'reconnecting':''}">:${t.port}${t.reconnecting?' ↻':''}</span>
             <button class="btn btn-disconnect" onclick="App.stopTunnel(${js(t.id)})">Disconnetti</button>
             <button class="btn btn-ghost btn-sm" onclick="App.showLogs(${js(t.id)},${js(s.label)})">Log</button>`
          : `<input class="port-input" id="port_${s.key}" type="number" value="${s.port}" min="1" max="65535">
             <button class="btn btn-connect" onclick="App.startTunnel(${js(s.key)})">Connetti</button>`}
      </div>
    </div>`;
  }

  function selectGroup(key) {
    activeGroup = key;
    if (section !== 'tunnel') goSection('tunnel');
    else { renderTunnelSection(); }
  }

  async function stopGroupTunnels(groupKey) {
    const g = groups.find(x => x.key === groupKey);
    if (!g) return;
    const toStop = tunnels.filter(t => g.servers.some(s => s.key === t.serverKey));
    for (const t of toStop) {
      try { await api.del(`/api/tunnels/${t.id}`); } catch {}
    }
    toast('Tunnel del gruppo disconnessi', 'success');
    await refresh();
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
          <table class="pm2-table">
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

  // ================================================================
  // PM2 SECTION
  // ================================================================
  async function renderPm2Section() {
    // Sidebar: stats o vuota
    const sidebar = document.getElementById('sidebarContent');
    sidebar.innerHTML = `
      <div class="sidebar-head">
        <span class="sidebar-head-title">PM2</span>
        <button class="btn btn-ghost btn-sm" onclick="App.refreshPm2Tab()">↻</button>
      </div>
      <div class="sidebar-body" id="pm2SidebarStats">
        <div style="padding:12px 14px;font-size:11px;color:var(--muted)">Caricamento...</div>
      </div>`;

    // Main area
    const main = mainPanel('pm2');
    main.innerHTML = `
      <div class="pm2-area">
        <div class="pm2-toolbar">
          <span style="font-size:13px;font-weight:600;color:var(--c-pm2)">Processi attivi</span>
          <div style="margin-left:auto;display:flex;gap:8px">
            <button class="btn btn-ghost btn-sm" onclick="App.showPm2Logs()">📋 Tutti i log</button>
            <button class="btn btn-ghost btn-sm" onclick="App.refreshPm2Tab()">↻ Aggiorna</button>
          </div>
        </div>
        <div class="pm2-content" id="pm2Content">
          <div style="color:var(--muted);font-size:12px">Caricamento...</div>
        </div>
      </div>`;

    await renderPm2Tab();
  }

  async function renderPm2Tab() {
    const content = document.getElementById('pm2Content');
    if (!content) return;
    if (!system.tools.pm2) {
      pm2List = [];
      updateBadges();
      const stats = document.getElementById('pm2SidebarStats');
      if (stats) stats.innerHTML = '';
      content.innerHTML = missingToolNotice('pm2', 'PM2 non è installato o non è nel PATH del server.', 'npm install -g pm2')
        || '<p style="color:var(--muted);font-size:13px">PM2 non disponibile.</p>';
      return;
    }
    try { pm2List = await api.get('/api/pm2/list'); } catch { pm2List = []; }

    // Update badge
    updateBadges();

    // PM2 sidebar stats
    const stats = document.getElementById('pm2SidebarStats');
    if (stats) {
      const online  = pm2List.filter(p => p.status === 'online').length;
      const stopped = pm2List.filter(p => p.status === 'stopped').length;
      const errored = pm2List.filter(p => p.status === 'errored').length;
      stats.innerHTML = `
        <div style="padding:10px 14px;display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;justify-content:space-between;font-size:12px">
            <span style="color:var(--muted)">Online</span>
            <span style="color:var(--success);font-family:var(--font)">${online}</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:12px">
            <span style="color:var(--muted)">Fermi</span>
            <span style="font-family:var(--font)">${stopped}</span>
          </div>
          ${errored>0?`<div style="display:flex;justify-content:space-between;font-size:12px">
            <span style="color:var(--muted)">Errori</span>
            <span style="color:var(--danger);font-family:var(--font)">${errored}</span>
          </div>`:''}
        </div>
        <div style="border-top:1px solid var(--border);padding:8px 14px">
          <p style="font-size:10px;color:var(--muted);font-family:var(--font)">Clicca il nome per i log</p>
        </div>`;
    }

    const statusClass = s => ({online:'online',stopped:'stopped',errored:'errored'}[s]||'stopped');
    content.innerHTML = pm2List.length === 0
      ? '<p style="color:var(--muted);font-size:13px">Nessun processo PM2 attivo.</p>'
      : `<table class="pm2-table">
          <thead><tr><th>ID</th><th>Nome</th><th>Stato</th><th>PID</th><th>CPU</th><th>Mem</th><th>↺</th><th></th></tr></thead>
          <tbody>${pm2List.map(proc => `<tr>
            <td style="color:var(--muted)">${proc.id}</td>
            <td><span class="pm2-name-link" onclick="App.showPm2Logs(${js(proc.name)})">${esc(proc.name)}</span></td>
            <td><span class="pm2-status ${statusClass(proc.status)}>${esc(proc.status||'?')}</span></td>
            <td style="font-family:var(--font);color:var(--muted)">${proc.pid||'—'}</td>
            <td>${proc.cpu!=null?proc.cpu+'%':'—'}</td>
            <td>${proc.memory!=null?Math.round(proc.memory/1024/1024)+'MB':'—'}</td>
            <td>${proc.restarts||0}</td>
            <td><div class="pm2-actions">
              ${proc.status==='online'
                ? `<button class="btn btn-ghost btn-sm" onclick="App.pm2Action('restart',${js(proc.name)})" title="Riavvia">↺</button>
                   <button class="btn btn-ghost btn-sm" onclick="App.pm2Action('stop',${js(proc.name)})" title="Ferma">⏹</button>
                   <button class="btn btn-ghost btn-sm" onclick="App.showPm2Logs(${js(proc.name)})" title="Log">📋</button>`
                : `<button class="btn btn-ghost btn-sm" style="color:var(--c-pm2)" onclick="App.pm2Action('start',${js(proc.name)})" title="Avvia">▶</button>`}
              <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="App.pm2Action('delete',${js(proc.name)})" title="Elimina">✕</button>
            </div></td>
          </tr>`).join('')}</tbody>
        </table>`;
  }

  async function refreshPm2Tab() {
    if (!system.tools.pm2) await loadSystem(true);
    if (section === 'pm2') await renderPm2Tab();
  }

  // ---- STRUMENTI ESTERNI ----
  async function loadSystem(refresh = false) {
    try { system = await api.get('/api/core/system' + (refresh ? '?refresh=1' : '')); } catch {}
  }

  async function recheckTools() {
    await loadSystem(true);
    toast('Strumenti ricontrollati', 'info');
    goSection(section);
  }

  // Avviso per strumento mancante ('' se presente o stato non ancora noto)
  function missingToolNotice(tool, message, installCmd) {
    if (!system.platform || system.tools[tool]) return '';
    const cmd = system.platform === 'win32' && tool === 'autossh' ? '' : installCmd;
    return `<div class="tool-notice">
      <span>⚠️ ${esc(message)}</span>
      ${cmd ? `<code>${esc(cmd)}</code>` : ''}
      <button class="btn btn-ghost btn-sm" onclick="App.recheckTools()">Ricontrolla</button>
    </div>`;
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

  // ================================================================
  // SWAGGER SECTION
  // ================================================================
  let swaggerLoaded = false;

  // Librerie da CDN con hash SRI (verificati contro api.cdnjs.com). Se si cambia
  // versione vanno aggiornati anche gli hash.
  const CDNJS = 'https://cdnjs.cloudflare.com/ajax/libs';
  const CDN = {
    swaggerCss:    { url: `${CDNJS}/swagger-ui/5.17.14/swagger-ui.min.css`,                   sri: 'sha512-+9UD8YSD9GF7FzOH38L9S6y56aYNx3R4dYbOCgvTJ2ZHpJScsahNdaMQJU/8osUiz9FPu0YZ8wdKf4evUbsGSg==' },
    swaggerBundle: { url: `${CDNJS}/swagger-ui/5.17.14/swagger-ui-bundle.min.js`,             sri: 'sha512-7ihPQv5ibiTr0DW6onbl2MIKegdT6vjpPySyIb4Ftp68kER6Z7Yiub0tFoMmCHzZfQE9+M+KSjQndv6NhYxDgg==' },
    swaggerPreset: { url: `${CDNJS}/swagger-ui/5.17.14/swagger-ui-standalone-preset.min.js`,  sri: 'sha512-UrYi+60Ci3WWWcoDXbMmzpoi1xpERbwjPGij6wTh8fXl81qNdioNNHExr9ttnBebKF0ZbVnPlTPlw+zECUK1Xw==' },
    jsYaml:        { url: `${CDNJS}/js-yaml/4.1.0/js-yaml.min.js`,                            sri: 'sha512-CSBhVREyzHAjAFfBlIBakjoRUKp5h7VSweP0InR/pAJyptH7peuhCsqAI/snV+TwZmXZqoUklpXp6R6wMnYf5Q==' },
  };

  function renderSwaggerSection() {
    const sidebar = document.getElementById('sidebarContent');
    sidebar.innerHTML = `
      <div style="padding:16px 12px">
        <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:12px">Swagger Preview</div>
        <label class="btn btn-primary" style="width:100%;justify-content:center;cursor:pointer;display:flex;align-items:center;gap:8px">
          <span>📂 Carica file YAML</span>
          <input type="file" id="swaggerFileInput" accept=".yml,.yaml,.json" style="display:none" onchange="App.loadSwaggerFile(this)">
        </label>
        <div id="swaggerFileInfo" style="margin-top:10px;font-size:12px;color:var(--muted);text-align:center"></div>
      </div>`;

    const main = document.getElementById('mainArea-swagger');
    if (!swaggerLoaded) {
      main.innerHTML = `
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--muted)">
          <div style="font-size:48px">📄</div>
          <div style="font-size:14px">Carica un file <code style="background:var(--surface2);padding:2px 6px;border-radius:4px;color:var(--c-swagger)">.yml</code> o <code style="background:var(--surface2);padding:2px 6px;border-radius:4px;color:var(--c-swagger)">.yaml</code> per vedere la preview Swagger</div>
        </div>`;
    }
  }

  async function loadSwaggerFile(input) {
    const file = input.files[0];
    if (!file) return;

    document.getElementById('swaggerFileInfo').textContent = `📄 ${file.name}`;

    const text = await file.text();
    const main = document.getElementById('mainArea-swagger');

    // Carica Swagger UI via CDN se non già presente (SRI: il browser rifiuta file alterati)
    if (!document.getElementById('swagger-ui-css')) {
      const link = document.createElement('link');
      link.id = 'swagger-ui-css';
      link.rel = 'stylesheet';
      link.href = CDN.swaggerCss.url;
      link.integrity = CDN.swaggerCss.sri;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
    }

    main.innerHTML = `<div id="swagger-ui" style="flex:1;overflow:auto;background:#fff"></div>`;

    const loadScript = ({ url: src, sri }) => new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      s.integrity = sri;
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });

    try {
      await loadScript(CDN.swaggerBundle);
      await loadScript(CDN.swaggerPreset);

      // Parse YAML — usiamo js-yaml se disponibile, altrimenti proviamo JSON
      let spec;
      try {
        if (!window.jsyaml) {
          await loadScript(CDN.jsYaml);
        }
        spec = window.jsyaml.load(text);
      } catch {
        spec = JSON.parse(text);
      }

      window.SwaggerUIBundle({
        spec,
        domNode: document.getElementById('swagger-ui'),
        presets: [window.SwaggerUIBundle.presets.apis, window.SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout',
        deepLinking: true,
        defaultModelsExpandDepth: 1,
        defaultModelExpandDepth: 1,
        validatorUrl: null, // niente badge da validator.swagger.io (bloccato dalla CSP)
      });

      swaggerLoaded = true;
    } catch(e) {
      main.innerHTML = `<div style="padding:24px;color:var(--danger)">Errore nel caricamento: ${esc(e.message)}</div>`;
    }
  }

  // SETTINGS SECTION
  // ================================================================
  function renderSettingsSection() {
    // Sidebar: groups list
    const sidebar = document.getElementById('sidebarContent');
    sidebar.innerHTML = `
      <div class="sidebar-head">
        <button class="btn btn-ghost btn-sm" onclick="App.goSection('tunnel')" title="Torna ai tunnel" style="padding:3px 7px;font-size:11px;gap:4px">← Tunnel</button>
        <button class="btn btn-ghost btn-sm" onclick="App.modalAddGroup()">+</button>
      </div>
      <div class="sidebar-body">
        <div id="settingsGroupsList"></div>
      </div>`;

    // Main area
    const main = mainPanel('settings');
    main.innerHTML = `
      <div class="settings-area">
        <div class="settings-body">
          <div class="settings-groups-col" style="display:none"></div>
          <div class="settings-detail-col" id="settingsDetail">
            <div class="settings-detail-empty">
              <div class="icon">←</div>
              <p>Seleziona un gruppo dalla sidebar</p>
            </div>
          </div>
        </div>
      </div>`;

    renderSettingsGroups();
    if (settingsGroup) renderSettingsDetail();
  }

  function renderSettingsGroups() {
    const el = document.getElementById('settingsGroupsList');
    if (!el) return;
    if (!config.groups.length) {
      el.innerHTML = '<p style="color:var(--muted);font-size:12px;padding:12px 14px">Nessun gruppo.<br><br><button class="btn btn-ghost btn-sm" onclick="App.modalAddGroup()" style="margin-top:4px">+ Aggiungi</button></p>';
      return;
    }
    el.innerHTML = config.groups.map(g => `
      <div class="gli ${settingsGroup===g.key?'active':''}" onclick="App.selectSettingsGroup(${js(g.key)})">
        <span class="gli-dot" style="background:${cssColor(g.color)}"></span>
        <span class="gli-label">${esc(g.label)}</span>
        <span class="gli-cnt">${g.servers.length}</span>
        <button class="gli-edit" onclick="event.stopPropagation();App.modalEditGroup(${js(g.key)})" title="Modifica">✏️</button>
        <button class="gli-del"  onclick="event.stopPropagation();App.deleteGroup(${js(g.key)})"  title="Elimina">🗑</button>
      </div>`).join('');
  }

  function renderSettingsDetail() {
    const el = document.getElementById('settingsDetail');
    if (!el) return;
    const g = config.groups.find(x => x.key === settingsGroup);
    if (!g) {
      el.innerHTML = `<div class="settings-detail-empty"><div class="icon">←</div><p>Seleziona un gruppo</p></div>`;
      return;
    }
    const groupServers = g.servers.map(sk => config.servers.find(s => s.key === sk)).filter(Boolean);
    const available    = config.servers.filter(s => !g.servers.includes(s.key));

    el.innerHTML = `
      <div class="settings-detail-header">
        <span class="settings-detail-dot" style="background:${cssColor(g.color)}"></span>
        <h3>${esc(g.label)}</h3>
        <button class="btn btn-primary btn-sm" onclick="App.modalAddServer(${js(g.key)})">+ Nuovo server</button>
        ${available.length ? `<button class="btn btn-ghost btn-sm" onclick="App.modalAssignServer(${js(g.key)})">+ Aggiungi esistente</button>` : ''}
      </div>
      <div class="settings-detail-body">
        ${groupServers.length === 0
          ? `<p style="color:var(--muted);font-size:13px;padding:20px 0">Nessun server in questo gruppo.</p>`
          : groupServers.map(s => `
            <div class="sli">
              <div class="sli-info">
                <div class="sli-label">${esc(s.label)}</div>
                <div class="sli-meta">:${s.port} → ${esc(s.remote)} · alias: ${esc(s.alias)}</div>
              </div>
              <span class="sli-type">${esc(s.type||'TCP')}</span>
              <div class="sli-actions">
                <button class="sli-btn" onclick="App.modalEditServer(${js(s.key)})" title="Modifica">✏️</button>
                <button class="sli-btn danger" onclick="App.removeServerFromGroup(${js(g.key)},${js(s.key)})" title="Rimuovi dal gruppo">✕</button>
                <button class="sli-btn danger" onclick="App.deleteServer(${js(s.key)})" title="Elimina definitivamente">🗑</button>
              </div>
            </div>`).join('')}
      </div>`;
  }

  function selectSettingsGroup(key) {
    settingsGroup = key;
    renderSettingsGroups();
    renderSettingsDetail();
  }

  async function removeServerFromGroup(groupKey, serverKey) {
    const cfg = JSON.parse(JSON.stringify(config));
    const g = cfg.groups.find(x => x.key === groupKey);
    if (!g) return;
    g.servers = g.servers.filter(sk => sk !== serverKey);
    try {
      await api.put(`/api/config/groups/${groupKey}`, { servers: g.servers });
      await refresh();
      if (section === 'settings') renderSettingsDetail();
    } catch(e) { toast(e.message, 'error'); }
  }

  function modalAssignServer(groupKey) {
    const g = config.groups.find(x => x.key === groupKey);
    if (!g) return;
    const available = config.servers.filter(s => !g.servers.includes(s.key));
    openModal('Aggiungi server esistente', `
      <div class="form-row">
        <label>Server disponibili</label>
        <select class="form-input" id="f_assign_server" size="8" style="height:auto">${available.map(s => `<option value="${s.key}">${esc(s.label)} (${esc(s.type||'TCP')} :${s.port})</option>`).join('')}</select>
      </div>`, `
      <button class="btn btn-ghost" onclick="App.closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="App.assignServer(${js(groupKey)})">Aggiungi</button>`);
  }

  async function assignServer(groupKey) {
    const sel = document.getElementById('f_assign_server');
    const serverKey = sel?.value;
    if (!serverKey) { toast('Seleziona un server', 'error'); return; }
    const g = config.groups.find(x => x.key === groupKey);
    if (!g) return;
    try {
      await api.put(`/api/config/groups/${groupKey}`, { servers: [...g.servers, serverKey] });
      closeModal();
      toast('Server aggiunto al gruppo', 'success');
      await refresh();
      if (section === 'settings') renderSettingsDetail();
    } catch(e) { toast(e.message, 'error'); }
  }

  const SERVICE_TYPES = ['MySQL','MongoDB','PostgreSQL','SQL Server','HTTP','HTTPS','FTP','LDAP','Elastic','Redis','TCP'];

  function groupForm(g={}) {
    return `
      <div class="form-row">
        <label>Chiave (snake_case, non modificabile)</label>
        <input class="form-input" id="f_key" value="${esc(g.key||'')}" placeholder="es. nuovo_gruppo" ${g.key?'disabled':''}>
      </div>
      <div class="form-row">
        <label>Nome</label>
        <input class="form-input" id="f_label" value="${esc(g.label||'')}" placeholder="es. Nuovo Gruppo">
      </div>
      <div class="form-row">
        <label>Colore</label>
        <div class="color-row">
          <div class="color-preview" id="colorPreview" style="background:${cssColor(g.color)}" onclick="document.getElementById('f_color').click()"></div>
          <span id="colorHex" style="font-family:var(--font);font-size:12px;color:var(--muted)">${cssColor(g.color)}</span>
          <input type="color" id="f_color" value="${cssColor(g.color)}" oninput="document.getElementById('colorPreview').style.background=this.value;document.getElementById('colorHex').textContent=this.value">
        </div>
      </div>`;
  }

  function serverForm(s={}, preGroupKey='') {
    const typeOptions  = SERVICE_TYPES.map(t=>`<option ${(s.type||'MySQL')===t?'selected':''}>${t}</option>`).join('');
    const groupOptions = config.groups.map(g=>`<option value="${g.key}" ${(preGroupKey?g.key===preGroupKey:g.servers.includes(s.key))?'selected':''}>${esc(g.label)}</option>`).join('');
    return `
      <div class="form-row">
        <label>Chiave (snake_case, non modificabile)</label>
        <input class="form-input" id="f_key" value="${esc(s.key||'')}" placeholder="es. db_prod" ${s.key?'disabled':''}>
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label>Nome</label>
          <input class="form-input" id="f_label" value="${esc(s.label||'')}" placeholder="es. DB Produzione">
        </div>
        <div class="form-row">
          <label>Tipo</label>
          <select class="form-input" id="f_type">${typeOptions}</select>
        </div>
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label>Porta locale</label>
          <input class="form-input" id="f_port" type="number" value="${s.port||3306}" min="1" max="65535">
        </div>
        <div class="form-row">
          <label>Remote (host:port)</label>
          <input class="form-input" id="f_remote" value="${esc(s.remote||'')}" placeholder="127.0.0.1:3306">
        </div>
      </div>
      <div class="form-row">
        <label>SSH Alias (da ~/.ssh/config)</label>
        <input class="form-input" id="f_alias" value="${esc(s.alias||'')}" placeholder="es. MyServer">
      </div>
      ${!s.key ? `<div class="form-row">
        <label>Gruppo</label>
        <select class="form-input" id="f_group"><option value="">-- Nessuno --</option>${groupOptions}</select>
      </div>` : ''}`;
  }

  function modalAddGroup()      { openModal('Nuovo gruppo', groupForm(), `<button class="btn btn-ghost" onclick="App.closeModal()">Annulla</button><button class="btn btn-primary" onclick="App.saveGroup()">Crea</button>`); }
  function modalEditGroup(key)  { const g=config.groups.find(x=>x.key===key); if(!g) return; openModal('Modifica gruppo', groupForm(g), `<button class="btn btn-ghost" onclick="App.closeModal()">Annulla</button><button class="btn btn-primary" onclick="App.saveGroup(${js(key)})">Salva</button>`); }
  function modalAddServer(gk)   { openModal('Nuovo server', serverForm({}, gk), `<button class="btn btn-ghost" onclick="App.closeModal()">Annulla</button><button class="btn btn-primary" onclick="App.saveServer(null,${js(gk||'')})">Crea</button>`); }
  function modalEditServer(key) { const s=config.servers.find(x=>x.key===key); if(!s) return; openModal('Modifica server', serverForm(s), `<button class="btn btn-ghost" onclick="App.closeModal()">Annulla</button><button class="btn btn-primary" onclick="App.saveServer(${js(key)})">Salva</button>`); }

  async function saveGroup(existingKey) {
    const key   = (document.getElementById('f_key')?.value||'').trim();
    const label = (document.getElementById('f_label')?.value||'').trim();
    const color = document.getElementById('f_color')?.value||'#6b7280';
    if (!key||!label) { toast('Chiave e nome obbligatori','error'); return; }
    try {
      if (existingKey) await api.put(`/api/config/groups/${existingKey}`, { label, color });
      else             await api.post('/api/config/groups', { key, label, color });
      closeModal(); toast('Gruppo salvato','success'); await refresh();
      if (section==='settings') { renderSettingsGroups(); renderSettingsDetail(); }
    } catch(e) { toast(e.message,'error'); }
  }

  async function saveServer(existingKey, forceGroupKey) {
    const key    = (document.getElementById('f_key')?.value||'').trim();
    const label  = (document.getElementById('f_label')?.value||'').trim();
    const port   = document.getElementById('f_port')?.value;
    const remote = (document.getElementById('f_remote')?.value||'').trim();
    const alias  = (document.getElementById('f_alias')?.value||'').trim();
    const type   = document.getElementById('f_type')?.value||'TCP';
    const group  = forceGroupKey || document.getElementById('f_group')?.value||'';
    if (!key||!label||!port||!remote||!alias) { toast('Compila tutti i campi obbligatori','error'); return; }
    try {
      if (existingKey) await api.put(`/api/config/servers/${existingKey}`, { label, port, remote, alias, type });
      else             await api.post('/api/config/servers', { key, label, port, remote, alias, type, groupKey: group });
      closeModal(); toast('Server salvato','success'); await refresh();
      if (section==='settings') renderSettingsSection();
    } catch(e) { toast(e.message,'error'); }
  }

  async function deleteGroup(key) {
    if (!confirm(`Eliminare il gruppo "${key}"?`)) return;
    try {
      await api.del(`/api/config/groups/${key}`);
      if (settingsGroup === key) settingsGroup = null;
      toast('Gruppo eliminato','success'); await refresh();
      if (section==='settings') renderSettingsSection();
    } catch(e) { toast(e.message,'error'); }
  }

  async function deleteServer(key) {
    if (!confirm(`Eliminare definitivamente il server "${key}"?`)) return;
    try {
      await api.del(`/api/config/servers/${key}`);
      toast('Server eliminato','success'); await refresh();
      if (section==='settings') renderSettingsSection();
    } catch(e) { toast(e.message,'error'); }
  }

  // ---- UPTIME ----
  function formatUptime(startedAt) {
    if (!startedAt) return '—';
    const secs = Math.floor((Date.now() - new Date(startedAt)) / 1000);
    if (secs < 60)   return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs/60)}m ${secs%60}s`;
    const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60);
    return `${h}h ${m}m`;
  }

  // ---- NOTIFICHE ----
  async function toggleNotifications() {
    if (notificationsEnabled) {
      notificationsEnabled = false; updateNotifBtn();
      toast('Notifiche disattivate'); return;
    }
    if (!('Notification' in window)) { toast('Notifiche non supportate dal browser', 'error'); return; }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') { notificationsEnabled = true; updateNotifBtn(); toast('Notifiche attivate', 'success'); }
    else toast('Permesso notifiche negato', 'error');
  }
  function updateNotifBtn() {
    const btn = document.getElementById('notifBtn');
    if (!btn) return;
    btn.classList.toggle('active', notificationsEnabled);
    btn.title = notificationsEnabled ? 'Notifiche attive — clicca per disattivare' : 'Attiva notifiche desktop';
  }
  function notify(title, body, icon = '🔵') {
    if (!notificationsEnabled || Notification.permission !== 'granted') return;
    new Notification(`${icon} ${title}`, { body, silent: false });
  }
  function checkTunnelChanges(newTunnels) {
    const newIds = new Set(newTunnels.map(t => t.id));
    for (const t of newTunnels) {
      if (!prevTunnelIds.has(t.id)) notify(t.label, `Tunnel connesso su :${t.port}`, '🟢');
    }
    for (const id of prevTunnelIds) {
      if (!newIds.has(id)) { const old = tunnels.find(t => t.id === id); if (old) notify(old.label, `Tunnel disconnesso da :${old.port}`, '🔴'); }
    }
    for (const t of newTunnels) {
      const was = tunnels.find(x => x.id === t.id);
      if (t.reconnecting && was && !was.reconnecting) notify(t.label, 'Connessione persa — riconnessione...', '🟡');
      if (!t.reconnecting && was && was.reconnecting) notify(t.label, `Riconnessione riuscita su :${t.port}`, '🟢');
    }
    prevTunnelIds = newIds;
  }

  // ---- EXPORT / IMPORT ----
  function exportConfig() {
    openModal('Esporta configurazione',
      `<div style="display:flex;flex-direction:column;gap:10px">
        <p style="font-size:13px;color:var(--muted)">Scegli cosa esportare:</p>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);transition:background .15s" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
          <input type="radio" name="exportType" value="all" checked style="accent-color:var(--c-tunnel)">
          <div><div style="font-weight:600;font-size:13px">Tutto</div><div style="font-size:11px;color:var(--muted)">Tunnel, server e progetti Git</div></div>
        </label>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);transition:background .15s" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
          <input type="radio" name="exportType" value="tunnels" style="accent-color:var(--c-tunnel)">
          <div><div style="font-weight:600;font-size:13px">Solo Tunnel</div><div style="font-size:11px;color:var(--muted)">Gruppi e server</div></div>
        </label>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);transition:background .15s" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
          <input type="radio" name="exportType" value="git" style="accent-color:var(--c-git)">
          <div><div style="font-weight:600;font-size:13px">Solo Git / NPM</div><div style="font-size:11px;color:var(--muted)">Progetti e repository</div></div>
        </label>
      </div>`,
      `<button class="btn btn-ghost" onclick="App.closeModal()">Annulla</button>
       <button class="btn btn-primary" onclick="App.doExport()">↓ Esporta</button>`
    );
  }
  function doExport() {
    const sel = document.querySelector('input[name="exportType"]:checked');
    const type = sel ? sel.value : 'all';
    closeModal();
    const sections = { all: '', tunnels: 'groups,servers', git: 'projects' }[type] ?? '';
    window.location.href = `/api/core/config/export?name=${type}${sections ? `&sections=${sections}` : ''}`;
  }
  async function importConfig(input) {
    const file = input.files[0]; if (!file) return;
    try {
      const text = await file.text();
      const cfg  = JSON.parse(text);
      const found = [['groups','gruppi'],['servers','server'],['projects','progetti']]
        .filter(([k]) => Array.isArray(cfg[k])).map(([k, label]) => `${cfg[k].length} ${label}`);
      if (!found.length) { toast('File non valido: nessun gruppo, server o progetto', 'error'); return; }
      const mode = confirm(`Trovati ${found.join(', ')}.\n\nOK = Sostituisci queste sezioni\nAnnulla = Merge (aggiungi i nuovi)\n\nLe sezioni assenti dal file non vengono toccate.`) ? 'replace' : 'merge';
      await api.post('/api/core/config/import', { config: cfg, mode });
      toast(`Import completato (${mode==='replace'?'sostituzione':'merge'})`, 'success');
      await refresh();
      if (section === 'settings') renderSettingsSection();
    } catch(e) { toast('Errore import: ' + e.message, 'error'); }
    input.value = '';
  }

  // ---- AZIONI TUNNEL ----
  async function startTunnel(serverKey) {
    const input = document.getElementById(`port_${serverKey}`);
    const port  = input ? parseInt(input.value) : undefined;
    try {
      const r = await api.post('/api/tunnels/start', { serverKey, port });
      toast(`Tunnel avviato su :${r.port}`, 'success');
      await refresh();
    } catch(e) { toast(e.message,'error'); }
  }
  async function stopTunnel(id) {
    try {
      await api.del(`/api/tunnels/${id}`);
      if (logTunnelId===id) closeLogs();
      toast('Tunnel terminato','success'); await refresh();
    } catch(e) { toast(e.message,'error'); }
  }
  async function stopAll() {
    try { await api.del('/api/tunnels'); closeLogs(); toast('Tutti i tunnel terminati','success'); await refresh(); }
    catch(e) { toast(e.message,'error'); }
  }

  // ---- REFRESH ----
  async function refresh() {
    try {
      const [newGroups, newTunnels, newConfig, newProcs] = await Promise.all([
        api.get('/api/groups'),
        api.get('/api/tunnels'),
        api.get('/api/config'),
        api.get('/api/processes'),
      ]);
      checkTunnelChanges(newTunnels);
      groups = newGroups; tunnels = newTunnels; config = newConfig;
      activeProcesses = newProcs;
      renderActivePills();
      updateBadges();

      // Aggiorna la sezione attiva senza ridisegnare tutto
      if (section === 'tunnel') {
        renderTunnelSection();
      } else if (section === 'npm') {
        renderNpmProjectsList();
        // Aggiorna stato scripts se visibile
        if (npmActiveTab === 'scripts' && activeProject) {
          const p = npmProjects.find(x => x.id === activeProject);
          if (p) renderScriptsTab(p);
        }
      } else if (section === 'pm2') {
        // lieve: aggiorna badge solo, non ricarica PM2 ad ogni tick
        updateBadges();
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
      await api.post('/api/pm2/action', { action: 'start', projectId, script });
      toast(`PM2: ${script} avviato`, 'success');
    } catch(e) { toast('PM2 errore: ' + e.message, 'error'); }
  }

  async function pm2Action(action, name) {
    if (action === 'delete' && !confirm(`Eliminare il processo PM2 "${name}"?`)) return;
    try {
      await api.post('/api/pm2/action', { action, target: name });
      toast(`PM2: ${action} ${name}`, 'success');
      if (section === 'pm2') await renderPm2Tab();
    } catch(e) { toast('PM2 errore: ' + e.message, 'error'); }
  }

  function showPm2Logs(name) {
    const title = name ? `pm2 logs ${name}` : 'pm2 logs (tutti)';
    openSsePanel(title);
    if (sseSource) sseSource.close();
    const url = name ? `/api/pm2/logs?name=${encodeURIComponent(name)}&lines=100` : '/api/pm2/logs?lines=100';
    const streamSection = section;
    sseSource = new EventSource(url);
    sseSource.onmessage = e => {
      const { type, data } = JSON.parse(e.data);
      appendSseToSection(streamSection, data, type === 'stderr' ? 'err' : type === 'exit' ? 'sys' : 'out');
      if (type === 'exit') { sseSource.close(); sseSource = null; }
    };
    sseSource.onerror = () => { appendSseToSection(streamSection, 'Connessione persa', 'err'); sseSource.close(); sseSource = null; };
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

  // ---- LOG SSH ----
  async function showLogs(id, label) {
    logTunnelId = id;
    document.getElementById('logDrawerTitle').textContent = label;
    document.getElementById('logDrawer').classList.add('open');
    await pollLogs();
    if (logPollInterval) clearInterval(logPollInterval);
    logPollInterval = setInterval(pollLogs, 2000);
  }
  async function pollLogs() {
    if (!logTunnelId) return;
    try {
      const logs = await api.get(`/api/tunnels/${logTunnelId}/logs`);
      const body = document.getElementById('logBody');
      body.innerHTML = logs.length
        ? logs.map(l=>`<p><span class="log-ts">[${new Date(l.ts).toLocaleTimeString('it-IT')}]</span> ${ansiToHtml(l.text)}</p>`).join('')
        : '<p style="color:#484f58">Nessun output</p>';
      body.scrollTop = body.scrollHeight;
    } catch { clearInterval(logPollInterval); }
  }
  function closeLogs() {
    document.getElementById('logDrawer').classList.remove('open');
    clearInterval(logPollInterval); logTunnelId = null;
  }

  // ---- INIT ----
  async function init() {
    // Set initial section tab styling
    document.getElementById('navTunnel').className = 'section-tab active-tunnel';
    await loadSystem();
    await refresh();
    goSection('tunnel');
    setInterval(refresh, 5000);
    setInterval(() => {
      document.querySelectorAll('[data-uptime]').forEach(el => {
        el.textContent = formatUptime(el.dataset.uptime);
      });
    }, 1000);
  }
  init();

  return {
    goSection, selectGroup, stopGroupTunnels,
    startTunnel, stopTunnel, stopAll,
    showLogs, closeLogs,
    closeModal,
    modalAddGroup, modalEditGroup, modalAddServer, modalEditServer,
    modalAssignServer, assignServer,
    saveGroup, saveServer, deleteGroup, deleteServer, removeServerFromGroup,
    toggleNotifications, exportConfig, doExport, importConfig,
    // NPM
    selectNpmProject, switchNpmTab,
    modalAddProject, saveProject, deleteProject,
    runNpmScript, streamProcess, stopProcess, restartProcess, dismissProcess,
    npmOutdated, npmUpdate,
    // PM2
    pm2StartScript, pm2Action, showPm2Logs, refreshPm2Tab,
    recheckTools,
    selectSettingsGroup,
    closeSsePanel, clearSseOutput,
    refresh,
    // Git
    selectGitRepo, refreshGitSection,
    loadGitStatus, loadGitLog,
    gitToggleFile, gitToggleAll,
    gitAction, gitCommit, gitCommitPush,
    openMergeModal, gitMerge,
    showCommitDetail,
    // Swagger
    loadSwaggerFile,
  };
})();
