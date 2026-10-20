// NPM: progetti nella sidebar, script con processi tracciati (log, porte, riavvio),
// dipendenze con versione installata e aggiornamenti, pill nell'header.
// Montato all'avvio (preload) per pill e badge dei processi in esecuzione.

const POLL_MS = 5000;

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal, output, formatUptime } = ctx.ui;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);

    let projects = [];
    let processes = [];
    let activeProject = null;
    let tab = 'scripts';
    let closeStream = null;

    const project = () => projects.find(p => p.id === activeProject) || null;
    const running = id => processes.filter(pr => pr.projectId === id && pr.running).length;
    const scriptLabel = script => script === 'install' ? 'npm install' : script.startsWith('update ') ? `npm ${script}` : `npm run ${script}`;

    // ---- dati ----
    async function loadProjects() {
      try { projects = await ctx.api.get('/projects'); } catch { projects = []; }
    }

    async function loadProcesses() {
      try { processes = await ctx.api.get('/processes'); } catch { return; }
      renderPills();
      const n = processes.filter(p => p.running).length;
      ctx.setBadge(projects.length + (n ? ` · ${n}▶` : ''));
    }

    // ---- header ----
    function renderPills() {
      ctx.setPills(processes.filter(p => p.running).map(p => {
        const ports = (p.ports || []).map(x => `:${x}`).join(' ');
        return `<span class="pill pill-npm" onclick="Ext.npm.open(${js(p.projectId)})"
                      title="${esc(p.projectLabel)} — ${esc(scriptLabel(p.script))}${ports ? ` (${esc(ports)})` : ''}">
          <span class="pill-dot"></span>
          ${esc(p.projectLabel)}<span class="pill-sub"> ${esc(p.script)}</span>
          ${ports ? `<span class="pill-sub">${esc(ports)}</span>` : ''}
          <span class="pill-close" onclick="event.stopPropagation();Ext.npm.stop(${js(p.id)})">✕</span>
        </span>`;
      }).join(''));
    }

    // ---- sidebar ----
    function renderProjects() {
      const el = $(ctx.sidebar, 'projects');
      if (!projects.length) {
        el.innerHTML = '<p class="npm-muted npm-pad">Nessun progetto.<br><br><button class="btn btn-npm btn-sm" onclick="Ext.npm.addProject()">+ Aggiungi</button></p>';
        return;
      }
      el.innerHTML = projects.map(p => {
        const n = running(p.id);
        return `<div class="sb-proj ${activeProject === p.id ? 'active' : ''}" onclick="Ext.npm.select(${js(p.id)})">
          <span class="sb-proj-icon">${n ? '🟠' : '📁'}</span>
          <div class="sb-proj-info">
            <div class="sb-proj-label">${esc(p.label)}${n ? ` <span class="npm-run-count">▶${n}</span>` : ''}</div>
            <div class="sb-proj-path">${esc(p.path)}</div>
          </div>
          <button class="sb-proj-del" onclick="event.stopPropagation();Ext.npm.deleteProject(${js(p.id)})" title="Rimuovi">✕</button>
        </div>`;
      }).join('');
    }

    // ---- pannello ----
    function renderHeader() {
      const p = project();
      $(ctx.root, 'empty').hidden = !!p;
      $(ctx.root, 'project').hidden = !p;
      if (!p) return false;
      $(ctx.root, 'title').textContent = p.label;
      $(ctx.root, 'path').textContent = p.path;
      const n = running(p.id);
      $(ctx.root, 'running').textContent = n ? `▶ ${n} in esecuzione` : '';
      for (const b of ctx.root.querySelectorAll('.npm-tab')) b.classList.toggle('active', b.dataset.tab === tab);
      return true;
    }

    async function renderTab() {
      if (!renderHeader()) return;
      if (tab === 'scripts') await renderScripts();
      else await renderPackages();
    }

    async function packageOf(p) {
      try { return await ctx.api.get(`/projects/${encodeURIComponent(p.id)}/package`); }
      catch { return { scripts: {}, dependencies: {}, devDependencies: {} }; }
    }

    async function renderScripts() {
      const p = project();
      const content = $(ctx.root, 'tab-content');
      const pkg = await packageOf(p);
      if (project() !== p || tab !== 'scripts') return; // selezione cambiata nel frattempo
      const procs = processes.filter(pr => pr.projectId === p.id);
      const pm2 = ctx.hasExtension('pm2');

      const row = (name, cmd) => {
        const proc = procs.find(pr => pr.script === name);
        const isRunning = proc?.running;
        return `<div class="script-row ${isRunning ? 'running' : ''}">
          ${isRunning ? `<span class="proc-dot" title="In esecuzione (pid ${esc(proc.pid)})"></span>`
            : proc ? `<span class="proc-dot dead" title="Terminato (exit ${esc(proc.exitCode)})"></span>` : ''}
          <span class="script-name">${esc(name)}</span>
          <span class="script-cmd">${esc(cmd || 'npm ' + name)}</span>
          ${isRunning ? `<span class="proc-uptime" data-uptime="${esc(proc.startedAt)}">${formatUptime(proc.startedAt)}</span>` : ''}
          ${(isRunning ? proc.ports || [] : []).map(port => `<span class="proc-port" title="Porta in uso">:${esc(port)}</span>`).join('')}
          <div class="script-actions">
            ${proc ? `
              <button class="btn btn-ghost btn-sm" onclick="Ext.npm.logs(${js(proc.id)},${js(scriptLabel(name))})" title="Vedi log">📋</button>
              ${isRunning ? `
                <button class="btn btn-ghost btn-sm" onclick="Ext.npm.restart(${js(proc.id)})" title="Riavvia">↺</button>
                <button class="btn btn-disconnect btn-sm" onclick="Ext.npm.stop(${js(proc.id)})" title="Ferma">⏹</button>
              ` : `
                <button class="btn btn-npm btn-sm" onclick="Ext.npm.run(${js(p.id)},${js(name)})">▶ Riavvia</button>
                <button class="btn btn-ghost btn-sm" onclick="Ext.npm.dismiss(${js(proc.id)})" title="Rimuovi">✕</button>
              `}
            ` : `<button class="btn btn-npm btn-sm" onclick="Ext.npm.run(${js(p.id)},${js(name)})">▶ Esegui</button>`}
            ${pm2 && name !== 'install' ? `<button class="btn btn-ghost btn-sm" onclick="Ext.npm.pm2(${js(p.id)},${js(name)})" title="Avvia con PM2">PM2</button>` : ''}
          </div>
        </div>`;
      };

      const scripts = Object.entries(pkg.scripts || {});
      content.innerHTML = `<div class="scripts-grid">
        ${row('install', 'npm install')}
        ${scripts.map(([name, cmd]) => row(name, cmd)).join('')}
        ${scripts.length ? '' : '<p class="npm-muted">Nessuno script in package.json</p>'}
      </div>`;
    }

    async function renderPackages() {
      const p = project();
      const content = $(ctx.root, 'tab-content');
      content.innerHTML = '<div class="npm-muted">Lettura pacchetti...</div>';
      const pkg = await packageOf(p);
      if (project() !== p || tab !== 'packages') return;
      const deps = Object.entries(pkg.dependencies || {});
      const devDeps = Object.entries(pkg.devDependencies || {});

      const table = (list, title) => !list.length ? '' : `
        <div class="pkg-section">
          <div class="pkg-section-title">${title} <span class="pkg-count">${list.length}</span></div>
          <table class="data-table">
            <thead><tr><th>Pacchetto</th><th>Versione config</th><th>Installata</th><th></th></tr></thead>
            <tbody>${list.map(([name, ver]) => `<tr>
              <td class="pkg-name">${esc(name)}</td>
              <td class="pkg-dim">${esc(ver)}</td>
              <td class="pkg-installed" data-pkg="${esc(name)}"><span class="pkg-dim">—</span></td>
              <td><button class="btn btn-ghost btn-sm" onclick="Ext.npm.update(${js(p.id)},${js(name)})" title="Aggiorna">↑ update</button></td>
            </tr>`).join('')}</tbody>
          </table>
        </div>`;

      content.innerHTML = `
        <div class="pkg-toolbar">
          <button class="btn btn-npm btn-sm" onclick="Ext.npm.run(${js(p.id)},'install')">↓ npm install</button>
          <button class="btn btn-ghost btn-sm" onclick="Ext.npm.outdated(${js(p.id)})">🔍 Verifica aggiornamenti</button>
          <span class="pkg-dim" data-role="outdated-status"></span>
        </div>
        ${table(deps, 'dependencies')}
        ${table(devDeps, 'devDependencies')}
        ${deps.length || devDeps.length ? '' : '<p class="npm-muted">Nessuna dipendenza nel package.json</p>'}`;

      const names = [...deps, ...devDeps].map(([n]) => n);
      if (!names.length) return;
      try {
        const versions = await ctx.api.post(`/projects/${encodeURIComponent(p.id)}/installed-versions`, { packages: names });
        for (const [name, ver] of Object.entries(versions)) {
          const cell = installedCell(name);
          if (cell) cell.innerHTML = ver ? `<span class="pkg-ok">${esc(ver)}</span>` : '<span class="pkg-dim">non installato</span>';
        }
      } catch {}
    }

    const installedCell = name => [...ctx.root.querySelectorAll('[data-pkg]')].find(el => el.dataset.pkg === name);

    // ---- log in streaming nel cassetto di output ----
    function stream(procId, title) {
      closeStream?.();
      output.open(title);
      closeStream = ctx.api.events(`/processes/${encodeURIComponent(procId)}/stream`, ({ type, data }) => {
        if (type === 'exit') { output.append(data, 'sys'); closeStream?.(); closeStream = null; }
        else output.append(data, type === 'stderr' ? 'err' : 'out');
      }, () => output.append('\n[connessione persa]', 'err'));
    }

    async function refreshAll() {
      await loadProcesses();
      renderProjects();
      if (ctx.isActive() && tab === 'scripts' && project()) await renderTab();
      else if (ctx.isActive()) renderHeader();
    }

    // ---- azioni (handler inline) ----
    const actions = {
      open(projectId) {
        if (projectId) { activeProject = projectId; tab = 'scripts'; }
        ctx.open(ctx.code);
        renderProjects(); renderTab();
      },
      select(id) { activeProject = id; renderProjects(); renderTab(); },

      async run(projectId, script) {
        try {
          const r = await ctx.api.post(`/projects/${encodeURIComponent(projectId)}/run`, { script });
          toast(`Avviato: ${scriptLabel(script)}`, 'success');
          await refreshAll();
          stream(r.id, scriptLabel(script));
        } catch (e) { toast(e.message, 'error'); }
      },
      async stop(procId) {
        try {
          await ctx.api.del(`/processes/${encodeURIComponent(procId)}`);
          toast('Processo fermato', 'success');
          await refreshAll();
        } catch (e) { toast(e.message, 'error'); }
      },
      async restart(procId) {
        try {
          await ctx.api.post(`/processes/${encodeURIComponent(procId)}/restart`);
          toast('Processo riavviato', 'success');
          await refreshAll();
          const pd = processes.find(x => x.id === procId);
          if (pd) stream(procId, scriptLabel(pd.script));
        } catch (e) { toast(e.message, 'error'); }
      },
      async dismiss(procId) {
        try {
          await ctx.api.del(`/processes/${encodeURIComponent(procId)}/dismiss`);
          await refreshAll();
        } catch (e) { toast(e.message, 'error'); }
      },
      logs: (procId, title) => stream(procId, title),

      async update(projectId, name) {
        try {
          toast(`Aggiornamento ${name}...`);
          const r = await ctx.api.post(`/projects/${encodeURIComponent(projectId)}/update`, { package: name });
          await loadProcesses();
          stream(r.id, `npm update ${name}`);
        } catch (e) { toast(e.message, 'error'); }
      },
      async outdated(projectId) {
        const status = $(ctx.root, 'outdated-status');
        if (status) status.textContent = 'Controllo in corso...';
        try {
          const data = Object.entries(await ctx.api.get(`/projects/${encodeURIComponent(projectId)}/outdated`));
          if (status) status.textContent = data.length ? `${data.length} aggiornamenti disponibili` : '✓ Tutti aggiornati';
          for (const [name, info] of data) {
            const cell = installedCell(name);
            if (cell) cell.innerHTML = `<span class="pkg-warn">${esc(info.current)}</span> → <span class="pkg-ok">${esc(info.latest)}</span>`;
          }
        } catch (e) { if (status) status.textContent = 'Errore: ' + e.message; }
      },

      // Avvio dello script sotto PM2 tramite l'estensione pm2
      async pm2(projectId, script) {
        try {
          await ctx.apiFor('pm2').post('/action', { action: 'start', projectId, script });
          toast(`PM2: ${script} avviato`, 'success');
        } catch (e) { toast('PM2 errore: ' + e.message, 'error'); }
      },

      addProject() {
        openModal('Nuovo progetto', `
          <div class="form-row"><label>ID (snake_case, non modificabile)</label><input class="form-input" id="f_proj_id" placeholder="es. my_app"></div>
          <div class="form-row"><label>Nome</label><input class="form-input" id="f_proj_label" placeholder="es. My App"></div>
          <div class="form-row"><label>Percorso assoluto cartella</label><input class="form-input" id="f_proj_path" placeholder="/Users/me/projects/my-app"></div>`,
          `<button class="btn btn-ghost" onclick="UI.closeModal()">Annulla</button>
           <button class="btn btn-npm" onclick="Ext.npm.saveProject()">Aggiungi</button>`);
      },
      async saveProject() {
        const val = id => (document.getElementById(id)?.value || '').trim();
        const body = { id: val('f_proj_id'), label: val('f_proj_label'), path: val('f_proj_path') };
        if (!body.id || !body.label || !body.path) { toast('Tutti i campi sono obbligatori', 'error'); return; }
        try {
          await ctx.api.post('/projects', body);
          closeModal();
          toast('Progetto aggiunto', 'success');
          await loadProjects();
          renderProjects();
          ctx.bus.emit('npm:projects-changed');
        } catch (e) { toast(e.message, 'error'); }
      },
      async deleteProject(id) {
        if (!confirm('Rimuovere questo progetto dalla lista?')) return;
        try {
          await ctx.api.del(`/projects/${encodeURIComponent(id)}`);
          if (activeProject === id) activeProject = null;
          toast('Progetto rimosso', 'success');
          await loadProjects();
          renderProjects(); renderTab();
          ctx.bus.emit('npm:projects-changed');
        } catch (e) { toast(e.message, 'error'); }
      },
    };

    ctx.sidebar.addEventListener('click', e => {
      if (e.target.closest('[data-action="add-project"]')) actions.addProject();
    });
    ctx.root.addEventListener('click', e => {
      const t = e.target.closest('.npm-tab')?.dataset.tab;
      if (t && t !== tab) { tab = t; renderTab(); }
    });

    ctx.expose(actions);
    await loadProjects();
    await loadProcesses();
    setInterval(refreshAll, POLL_MS);

    this.show = async () => { await loadProjects(); renderProjects(); renderTab(); };
    this.hide = () => { closeStream?.(); closeStream = null; };
    this.refresh = async () => { await loadProjects(); await refreshAll(); };
  },
};
