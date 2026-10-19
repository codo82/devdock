// Tunnel SSH: gruppi e card dei server, configurazione di gruppi e server,
// pill nell'header, notifiche desktop e log nel cassetto di output.
// Montato all'avvio (preload) perché pill e notifiche servono anche a tab chiuso.

const POLL_MS = 5000;
const LOG_POLL_MS = 2000;
const SERVICE_TYPES = ['MySQL', 'MongoDB', 'PostgreSQL', 'SQL Server', 'HTTP', 'HTTPS', 'FTP', 'LDAP', 'Elastic', 'Redis', 'TCP'];

export default {
  async mount(ctx) {
    const { esc, js, cssColor, toast, openModal, closeModal, output, formatUptime, toolNotice, notify } = ctx.ui;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);

    let state = { groups: [], servers: [], tunnels: [] };
    let system = { platform: null, tools: {} };
    let mode = 'tunnels';          // 'tunnels' | 'settings'
    let activeGroup = null;
    let settingsGroup = null;
    let prevTunnels = null;        // per le notifiche (null = primo giro)
    const customPorts = new Map(); // porta digitata nelle card, conservata tra un refresh e l'altro
    let logTunnelId = null, logTimer = null;

    const tunnelsOf = g => state.tunnels.filter(t => g.servers.some(s => s.key === t.serverKey));

    // ---- dati ----
    async function load() {
      try {
        const next = await ctx.api.get('/state');
        notifyChanges(next.tunnels);
        state = next;
      } catch { return; }
      renderPills();
      ctx.setBadge(state.tunnels.length);
      if (ctx.isActive()) render();
    }

    function notifyChanges(next) {
      if (prevTunnels) {
        const prev = new Map(prevTunnels.map(t => [t.id, t]));
        const ids = new Set(next.map(t => t.id));
        for (const t of next) {
          const was = prev.get(t.id);
          if (!was) notify(t.label, `Tunnel connesso su :${t.port}`, '🟢');
          else if (t.reconnecting && !was.reconnecting) notify(t.label, 'Connessione persa — riconnessione...', '🟡');
          else if (!t.reconnecting && was.reconnecting) notify(t.label, `Riconnessione riuscita su :${t.port}`, '🟢');
        }
        for (const t of prevTunnels) if (!ids.has(t.id)) notify(t.label, `Tunnel disconnesso da :${t.port}`, '🔴');
      }
      prevTunnels = next;
    }

    // ---- header ----
    function renderPills() {
      if (!state.tunnels.length) { ctx.setPills(''); return; }
      ctx.setPills(state.tunnels.map(t => `
        <span class="pill pill-tunnel ${t.reconnecting ? 'reconnecting' : ''}" onclick="Ext.tunnels.open()"
              title="${esc(t.label)} :${esc(t.port)}${t.reconnecting ? ' (riconnessione)' : ''}">
          <span class="pill-dot"></span>
          ${esc(t.label)}<span class="pill-port">:${esc(t.port)}</span>
          <span class="pill-close" onclick="event.stopPropagation();Ext.tunnels.stop(${js(t.id)})">✕</span>
        </span>`).join('') + `<button class="btn btn-danger btn-sm" onclick="Ext.tunnels.stopAll()">⏹ Stop all</button>`);
    }

    // ---- vista tunnel ----
    function render() {
      for (const el of ctx.root.querySelectorAll('[data-mode]')) el.hidden = el.dataset.mode !== mode;
      for (const el of ctx.sidebar.querySelectorAll('[data-mode]')) el.hidden = el.dataset.mode !== mode;
      if (mode === 'settings') { renderSettingsGroups(); renderSettingsDetail(); return; }
      renderGroups();
      renderMain();
    }

    function renderGroups() {
      const list = $(ctx.sidebar, 'groups');
      list.innerHTML = !state.groups.length
        ? '<p class="tn-muted tn-pad">Nessun gruppo</p>'
        : state.groups.map(g => {
            const cnt = tunnelsOf(g).length, color = cssColor(g.color);
            return `<button class="sb-item ${activeGroup === g.key ? 'active' : ''}" onclick="Ext.tunnels.selectGroup(${js(g.key)})">
              <span class="sb-dot" style="background:${color}"></span>
              <span class="tn-grow">${esc(g.label)}</span>
              ${cnt ? `<span class="sb-count" style="color:${color};border-color:${color}">${cnt}</span>`
                    : `<span class="sb-count">${g.servers.length}</span>`}
            </button>`;
          }).join('');
    }

    function renderMain() {
      const main = $(ctx.root, 'main');
      const g = state.groups.find(x => x.key === activeGroup);
      if (!g) {
        main.innerHTML = '<div class="empty-state"><div class="icon">🔗</div><p>Seleziona un gruppo dalla sidebar</p></div>';
        return;
      }
      const color = cssColor(g.color), cnt = tunnelsOf(g).length;
      const autossh = system.platform && !system.tools.autossh
        ? toolNotice('autossh non installato: i tunnel usano ssh e la riconnessione è gestita da DevDock.',
            system.platform === 'darwin' ? 'brew install autossh' : system.platform === 'win32' ? '' : 'sudo apt install autossh',
            'Ext.tunnels.recheck()')
        : '';
      main.innerHTML = `
        <div class="section-banner" style="border-left:3px solid ${color}">
          <span class="section-banner-dot" style="background:${color}"></span>
          <h2>${esc(g.label)}</h2>
          ${cnt ? `<span class="section-banner-sub">${cnt} connessi</span>` : ''}
          <div class="tn-banner-actions">
            ${cnt ? `<button class="btn btn-danger btn-sm" onclick="Ext.tunnels.stopGroup(${js(g.key)})">⏹ Disconnetti tutti</button>` : ''}
          </div>
        </div>
        ${autossh}
        <div class="server-area">
          <div class="server-grid">${g.servers.map(serverCard).join('')}</div>
          ${g.servers.length ? '' : '<div class="empty-state tn-empty-inline"><div class="icon">🖥</div><p>Nessun server in questo gruppo</p></div>'}
        </div>`;
    }

    function serverCard(s) {
      const t = state.tunnels.find(x => x.serverKey === s.key);
      return `<div class="server-card ${t ? 'connected' : ''}">
        <div class="card-top">
          <span class="card-label">${esc(s.label)}</span>
          <span class="type-badge">${esc(s.type || 'TCP')}</span>
        </div>
        <div class="card-meta">
          <div>alias: <span class="val">${esc(s.alias)}</span></div>
          <div>remote: <span class="val">${esc(s.remote)}</span></div>
        </div>
        ${t ? `<div class="card-meta tn-card-runtime">
          <div>pid: <span class="val">${esc(t.pid || '—')}</span></div>
          <div>uptime: <span class="val" data-uptime="${esc(t.startedAt)}">${formatUptime(t.startedAt)}</span></div>
        </div>` : ''}
        <div class="card-bottom">
          ${t
            ? `<span class="connected-status ${t.reconnecting ? 'reconnecting' : ''}">:${esc(t.port)}${t.reconnecting ? ' ↻' : ''}</span>
               <button class="btn btn-disconnect" onclick="Ext.tunnels.stop(${js(t.id)})">Disconnetti</button>
               <button class="btn btn-ghost btn-sm" onclick="Ext.tunnels.logs(${js(t.id)},${js(s.label)})">Log</button>`
            : `<input class="port-input" type="number" min="1" max="65535" value="${esc(customPorts.get(s.key) ?? s.port)}"
                      oninput="Ext.tunnels.setPort(${js(s.key)}, this.value)">
               <button class="btn btn-connect" onclick="Ext.tunnels.start(${js(s.key)})">Connetti</button>`}
        </div>
      </div>`;
    }

    // ---- vista configurazione ----
    function renderSettingsGroups() {
      const el = $(ctx.sidebar, 'settings-groups');
      el.innerHTML = !state.groups.length
        ? '<p class="tn-muted tn-pad">Nessun gruppo.<br><br><button class="btn btn-ghost btn-sm" onclick="Ext.tunnels.addGroup()">+ Aggiungi</button></p>'
        : state.groups.map(g => `
          <div class="gli ${settingsGroup === g.key ? 'active' : ''}" onclick="Ext.tunnels.selectSettingsGroup(${js(g.key)})">
            <span class="gli-dot" style="background:${cssColor(g.color)}"></span>
            <span class="gli-label">${esc(g.label)}</span>
            <span class="gli-cnt">${g.servers.length}</span>
            <button class="gli-edit" onclick="event.stopPropagation();Ext.tunnels.editGroup(${js(g.key)})" title="Modifica">✏️</button>
            <button class="gli-del" onclick="event.stopPropagation();Ext.tunnels.deleteGroup(${js(g.key)})" title="Elimina">🗑</button>
          </div>`).join('');
    }

    function renderSettingsDetail() {
      const el = $(ctx.root, 'settings-detail');
      const g = state.groups.find(x => x.key === settingsGroup);
      if (!g) {
        el.innerHTML = '<div class="settings-detail-empty"><div class="icon">←</div><p>Seleziona un gruppo dalla sidebar</p></div>';
        return;
      }
      const available = state.servers.filter(s => !g.servers.some(x => x.key === s.key));
      el.innerHTML = `
        <div class="settings-detail-header">
          <span class="settings-detail-dot" style="background:${cssColor(g.color)}"></span>
          <h3>${esc(g.label)}</h3>
          <button class="btn btn-primary btn-sm" onclick="Ext.tunnels.addServer(${js(g.key)})">+ Nuovo server</button>
          ${available.length ? `<button class="btn btn-ghost btn-sm" onclick="Ext.tunnels.assignServer(${js(g.key)})">+ Aggiungi esistente</button>` : ''}
        </div>
        <div class="settings-detail-body">
          ${!g.servers.length
            ? '<p class="tn-muted tn-pad-v">Nessun server in questo gruppo.</p>'
            : g.servers.map(s => `
              <div class="sli">
                <div class="sli-info">
                  <div class="sli-label">${esc(s.label)}</div>
                  <div class="sli-meta">:${esc(s.port)} → ${esc(s.remote)} · alias: ${esc(s.alias)}</div>
                </div>
                <span class="sli-type">${esc(s.type || 'TCP')}</span>
                <div class="sli-actions">
                  <button class="sli-btn" onclick="Ext.tunnels.editServer(${js(s.key)})" title="Modifica">✏️</button>
                  <button class="sli-btn danger" onclick="Ext.tunnels.removeFromGroup(${js(g.key)},${js(s.key)})" title="Rimuovi dal gruppo">✕</button>
                  <button class="sli-btn danger" onclick="Ext.tunnels.deleteServer(${js(s.key)})" title="Elimina definitivamente">🗑</button>
                </div>
              </div>`).join('')}
        </div>`;
    }

    // ---- form ----
    const field = id => (document.getElementById(id)?.value || '').trim();

    function groupForm(g = {}) {
      const color = cssColor(g.color);
      return `
        <div class="form-row">
          <label>Chiave (snake_case, non modificabile)</label>
          <input class="form-input" id="f_key" value="${esc(g.key || '')}" placeholder="es. nuovo_gruppo" ${g.key ? 'disabled' : ''}>
        </div>
        <div class="form-row">
          <label>Nome</label>
          <input class="form-input" id="f_label" value="${esc(g.label || '')}" placeholder="es. Nuovo Gruppo">
        </div>
        <div class="form-row">
          <label>Colore</label>
          <div class="color-row">
            <div class="color-preview" id="colorPreview" style="background:${color}" onclick="document.getElementById('f_color').click()"></div>
            <span id="colorHex" class="tn-hex">${color}</span>
            <input type="color" id="f_color" value="${color}" oninput="document.getElementById('colorPreview').style.background=this.value;document.getElementById('colorHex').textContent=this.value">
          </div>
        </div>`;
    }

    function serverForm(s = {}, preGroupKey = '') {
      const types = SERVICE_TYPES.map(t => `<option ${(s.type || 'MySQL') === t ? 'selected' : ''}>${esc(t)}</option>`).join('');
      const groupOptions = state.groups.map(g => `<option value="${esc(g.key)}" ${g.key === preGroupKey ? 'selected' : ''}>${esc(g.label)}</option>`).join('');
      return `
        <div class="form-row">
          <label>Chiave (snake_case, non modificabile)</label>
          <input class="form-input" id="f_key" value="${esc(s.key || '')}" placeholder="es. db_prod" ${s.key ? 'disabled' : ''}>
        </div>
        <div class="form-grid">
          <div class="form-row"><label>Nome</label><input class="form-input" id="f_label" value="${esc(s.label || '')}" placeholder="es. DB Produzione"></div>
          <div class="form-row"><label>Tipo</label><select class="form-input" id="f_type">${types}</select></div>
        </div>
        <div class="form-grid">
          <div class="form-row"><label>Porta locale</label><input class="form-input" id="f_port" type="number" value="${esc(s.port || 3306)}" min="1" max="65535"></div>
          <div class="form-row"><label>Remote (host:port)</label><input class="form-input" id="f_remote" value="${esc(s.remote || '')}" placeholder="127.0.0.1:3306"></div>
        </div>
        <div class="form-row">
          <label>SSH Alias (da ~/.ssh/config)</label>
          <input class="form-input" id="f_alias" value="${esc(s.alias || '')}" placeholder="es. MyServer">
        </div>
        ${!s.key ? `<div class="form-row">
          <label>Gruppo</label>
          <select class="form-input" id="f_group"><option value="">-- Nessuno --</option>${groupOptions}</select>
        </div>` : ''}`;
    }

    const modalButtons = (label, call) =>
      `<button class="btn btn-ghost" onclick="UI.closeModal()">Annulla</button><button class="btn btn-primary" onclick="${esc(call)}">${esc(label)}</button>`;

    // Esegue una modifica e ricarica lo stato; gli errori del server diventano toast
    async function mutate(fn, okMsg) {
      try {
        await fn();
        if (okMsg) toast(okMsg, 'success');
        await load();
        return true;
      } catch (e) { toast(e.message, 'error'); return false; }
    }

    // ---- log del tunnel nel cassetto di output ----
    function stopLogs() { clearInterval(logTimer); logTimer = null; logTunnelId = null; }

    async function pollLogs() {
      if (!logTunnelId) return;
      try {
        const logs = await ctx.api.get(`/tunnels/${encodeURIComponent(logTunnelId)}/logs`);
        output.clear();
        if (!logs.length) output.append('Nessun output', 'sys');
        for (const l of logs) {
          output.append(`[${new Date(l.ts).toLocaleTimeString('it-IT')}] `, 'sys');
          output.append(l.text.endsWith('\n') ? l.text : l.text + '\n');
        }
      } catch { stopLogs(); }
    }

    // ---- azioni (handler inline) ----
    const actions = {
      open: () => ctx.open(ctx.code),
      selectGroup(key) { activeGroup = key; mode = 'tunnels'; ctx.open(ctx.code); render(); },
      setPort(key, value) { customPorts.set(key, value); },
      recheck: async () => { system = await ctx.core.get('/system?refresh=1').catch(() => system); render(); },

      start: key => mutate(async () => {
        const port = customPorts.get(key);
        const r = await ctx.api.post('/tunnels', { serverKey: key, port: port === undefined || port === '' ? undefined : Number(port) });
        toast(`Tunnel avviato su :${r.port}`, 'success');
      }),
      stop: id => mutate(async () => {
        await ctx.api.del(`/tunnels/${encodeURIComponent(id)}`);
        if (logTunnelId === id) stopLogs();
      }, 'Tunnel terminato'),
      stopAll: () => mutate(async () => { await ctx.api.del('/tunnels'); stopLogs(); }, 'Tutti i tunnel terminati'),
      stopGroup: key => mutate(async () => {
        const g = state.groups.find(x => x.key === key);
        for (const t of g ? tunnelsOf(g) : []) await ctx.api.del(`/tunnels/${encodeURIComponent(t.id)}`).catch(() => {});
      }, 'Tunnel del gruppo disconnessi'),
      logs(id, label) {
        logTunnelId = id;
        output.open(`🔗 SSH Log — ${label}`);
        pollLogs();
        clearInterval(logTimer);
        logTimer = setInterval(pollLogs, LOG_POLL_MS);
      },

      // configurazione
      selectSettingsGroup(key) { settingsGroup = key; render(); },
      addGroup: () => openModal('Nuovo gruppo', groupForm(), modalButtons('Crea', 'Ext.tunnels.saveGroup()')),
      editGroup(key) {
        const g = state.groups.find(x => x.key === key);
        if (g) openModal('Modifica gruppo', groupForm(g), modalButtons('Salva', `Ext.tunnels.saveGroup(${JSON.stringify(key)})`));
      },
      async saveGroup(existingKey) {
        const key = field('f_key'), label = field('f_label'), color = field('f_color') || '#6b7280';
        if (!key || !label) { toast('Chiave e nome obbligatori', 'error'); return; }
        const ok = await mutate(() => existingKey
          ? ctx.api.put(`/groups/${encodeURIComponent(existingKey)}`, { label, color })
          : ctx.api.post('/groups', { key, label, color }), 'Gruppo salvato');
        if (ok) closeModal();
      },
      async deleteGroup(key) {
        if (!confirm(`Eliminare il gruppo "${key}"?`)) return;
        if (settingsGroup === key) settingsGroup = null;
        await mutate(() => ctx.api.del(`/groups/${encodeURIComponent(key)}`), 'Gruppo eliminato');
      },
      addServer: groupKey => openModal('Nuovo server', serverForm({}, groupKey), modalButtons('Crea', `Ext.tunnels.saveServer(null, ${JSON.stringify(groupKey || '')})`)),
      editServer(key) {
        const s = state.servers.find(x => x.key === key);
        if (s) openModal('Modifica server', serverForm(s), modalButtons('Salva', `Ext.tunnels.saveServer(${JSON.stringify(key)})`));
      },
      async saveServer(existingKey, forceGroupKey) {
        const body = { key: field('f_key'), label: field('f_label'), port: field('f_port'), remote: field('f_remote'), alias: field('f_alias'), type: field('f_type') || 'TCP' };
        if (!body.key || !body.label || !body.port || !body.remote || !body.alias) { toast('Compila tutti i campi obbligatori', 'error'); return; }
        const ok = await mutate(() => existingKey
          ? ctx.api.put(`/servers/${encodeURIComponent(existingKey)}`, { label: body.label, port: body.port, remote: body.remote, alias: body.alias, type: body.type })
          : ctx.api.post('/servers', { ...body, groupKey: forceGroupKey || field('f_group') }), 'Server salvato');
        if (ok) closeModal();
      },
      async deleteServer(key) {
        if (!confirm(`Eliminare definitivamente il server "${key}"?`)) return;
        await mutate(() => ctx.api.del(`/servers/${encodeURIComponent(key)}`), 'Server eliminato');
      },
      assignServer(groupKey) {
        const g = state.groups.find(x => x.key === groupKey);
        if (!g) return;
        const available = state.servers.filter(s => !g.servers.some(x => x.key === s.key));
        openModal('Aggiungi server esistente', `
          <div class="form-row">
            <label>Server disponibili</label>
            <select class="form-input" id="f_assign_server" size="8" style="height:auto">${available.map(s =>
              `<option value="${esc(s.key)}">${esc(s.label)} (${esc(s.type || 'TCP')} :${esc(s.port)})</option>`).join('')}</select>
          </div>`, modalButtons('Aggiungi', `Ext.tunnels.doAssign(${JSON.stringify(groupKey)})`));
      },
      async doAssign(groupKey) {
        const serverKey = field('f_assign_server');
        if (!serverKey) { toast('Seleziona un server', 'error'); return; }
        const g = state.groups.find(x => x.key === groupKey);
        const ok = await mutate(() => ctx.api.put(`/groups/${encodeURIComponent(groupKey)}`,
          { servers: [...g.servers.map(s => s.key), serverKey] }), 'Server aggiunto al gruppo');
        if (ok) closeModal();
      },
      removeFromGroup(groupKey, serverKey) {
        const g = state.groups.find(x => x.key === groupKey);
        if (!g) return;
        mutate(() => ctx.api.put(`/groups/${encodeURIComponent(groupKey)}`, { servers: g.servers.map(s => s.key).filter(k => k !== serverKey) }));
      },
    };

    // pulsanti statici di sidebar.html
    ctx.sidebar.addEventListener('click', e => {
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (a === 'settings' || a === 'tunnels') { mode = a; render(); }
      else if (a === 'add-group') actions.addGroup();
    });

    ctx.expose(actions);
    system = await ctx.core.get('/system').catch(() => system);
    await load();
    setInterval(load, POLL_MS);

    this.render = render;
    this.load = load;
    this.stopLogs = stopLogs;
  },

  show() { this.render(); },
  hide() { this.stopLogs(); },
  refresh() { this.load(); },
};
