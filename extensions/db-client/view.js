// Database: vault della master password, connessioni, editor delle query e risultati

const SQL_KEYWORDS = new Set(`ADD ALL ALTER AND AS ASC AUTO_INCREMENT BETWEEN BIGINT BINARY BLOB BY CASCADE CASE CHAR CHARACTER CHARSET CHECK
COLLATE COLUMN COMMENT CONSTRAINT CREATE CROSS DATABASE DATABASES DATE DATETIME DECIMAL DEFAULT DELETE DESC DESCRIBE DISTINCT DOUBLE DROP
ELSE END ENGINE ENUM EXISTS EXPLAIN FALSE FLOAT FOR FOREIGN FROM FULL GROUP HAVING IF IGNORE IN INDEX INNER INSERT INT INTEGER INTERVAL INTO
IS JOIN JSON KEY KEYS LEFT LIKE LIMIT LONGTEXT MEDIUMTEXT MODIFY NOT NULL OFFSET ON OR ORDER OUTER PRIMARY REFERENCES RENAME REPLACE RIGHT
SELECT SET SHOW SMALLINT TABLE TABLES TEXT THEN TIME TIMESTAMP TINYINT TRUE TRUNCATE UNION UNIQUE UNSIGNED UPDATE USING VALUES VARCHAR VIEW
WHEN WHERE WITH`.split(/\s+/));

// Evidenziazione leggera: commenti, stringhe, identificatori quotati, numeri, parole chiave
function highlightSql(sql, esc) {
  const re = /(--[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^'\\]|\\.|'')*'?|"(?:[^"\\]|\\.|"")*"?)|(`(?:[^`]|``)*`?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_$]*)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(sql))) {
    out += esc(sql.slice(last, m.index));
    const [tok, comment, str, ident, num, word] = m;
    const cls = comment ? 'c' : str ? 's' : ident ? 'i' : num ? 'n' : word && SQL_KEYWORDS.has(word.toUpperCase()) ? 'k' : null;
    out += cls ? `<span class="sql-${cls}">${esc(tok)}</span>` : esc(tok);
    last = m.index + tok.length;
  }
  return out + esc(sql.slice(last)) + '\n'; // la riga finale vuota mantiene allineata la textarea
}

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal } = ctx.ui;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);

    let vault = { state: 'uninitialized', minLength: 10 };
    let connections = [];
    let tunnelsAvailable = false;
    let activeId = null;

    const active = () => connections.find(c => c.id === activeId) || null;
    const editors = new Map(); // testo dell'editor per connessione

    // ---- vault ----
    async function loadVault() {
      try { vault = await ctx.api.get('/vault'); } catch (e) { toast(e.message, 'error'); }
      render();
    }

    function render() {
      const unlocked = vault.state === 'unlocked';
      $(ctx.root, 'gate').hidden = unlocked;
      $(ctx.root, 'main').hidden = !unlocked;
      $(ctx.sidebar, 'vault-btn').hidden = !unlocked;
      $(ctx.sidebar, 'add-btn').hidden = !unlocked;
      if (!unlocked) {
        $(ctx.sidebar, 'connections').innerHTML = '<p class="db-muted db-pad">🔒 Sblocca la master password per vedere le connessioni.</p>';
        renderGate();
        return;
      }
      loadConnections();
    }

    // ---- connessioni ----
    async function loadConnections() {
      try {
        ({ connections, tunnelsAvailable } = await ctx.api.get('/connections'));
      } catch (e) { toast(e.message, 'error'); return; }
      if (activeId && !active()) activeId = null;
      ctx.setBadge(connections.length || null);
      renderConnections();
      renderWorkspace();
    }

    // Progetti npm (solo se l'estensione è attiva): per raggruppare e scegliere il progetto
    async function projects() {
      if (!ctx.hasExtension('npm')) return [];
      try { return await ctx.apiFor('npm').get('/projects'); } catch { return []; }
    }

    async function renderConnections() {
      const el = $(ctx.sidebar, 'connections');
      if (!connections.length) {
        el.innerHTML = '<p class="db-muted db-pad">Nessuna connessione.<br><br><button class="btn btn-ghost btn-sm" onclick="Ext[\'db-client\'].addConnection()">+ Aggiungi</button></p>';
        return;
      }
      const labels = new Map((await projects()).map(p => [p.id, p.label]));
      const groups = new Map();
      for (const c of connections) {
        const g = c.projectId && labels.has(c.projectId) ? labels.get(c.projectId) : '';
        groups.set(g, [...(groups.get(g) || []), c]);
      }
      const keys = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
      el.innerHTML = keys.map(g => `
        ${keys.length > 1 || g ? `<div class="db-group">${esc(g || 'Senza progetto')}</div>` : ''}
        ${groups.get(g).map(c => `
          <button class="sb-item ${c.id === activeId ? 'active' : ''}" onclick="Ext['db-client'].select(${js(c.id)})" title="${esc(target(c))}">
            <span class="sb-icon">${c.readOnly ? '🔒' : '🗄️'}</span>
            <span class="db-conn-name">${esc(c.label)}</span>
          </button>`).join('')}`).join('');
    }

    const target = c => c.tunnel ? `tunnel ${c.tunnel}` : `${c.host}:${c.port}`;

    function renderWorkspace() {
      const c = active();
      $(ctx.root, 'no-connection').hidden = !!c;
      $(ctx.root, 'workspace').hidden = !c;
      if (!c) return;
      $(ctx.root, 'sql').value = editors.get(c.id) || '';
      syncHighlight();
      loadDatabases(c);
      $(ctx.root, 'conn-header').innerHTML = `
        <h3>🗄️ ${esc(c.label)}</h3>
        <span class="db-conn-meta">${esc(c.user)}@${esc(target(c))}${c.database ? ` / ${esc(c.database)}` : ''}</span>
        ${c.readOnly ? '<span class="db-badge">sola lettura</span>' : ''}
        ${c.hasPassword ? '' : '<span class="db-badge db-badge-warn">senza password</span>'}
        <div class="db-conn-actions">
          <button class="btn btn-ghost btn-sm" onclick="Ext['db-client'].testConnection(${js(c.id)})">⚡ Prova</button>
          <button class="btn btn-ghost btn-sm" onclick="Ext['db-client'].editConnection(${js(c.id)})">✏️ Modifica</button>
          <button class="btn btn-ghost btn-sm db-danger" onclick="Ext['db-client'].deleteConnection(${js(c.id)})">🗑</button>
        </div>`;
    }

    async function connectionForm(c = {}) {
      const tunnelServers = tunnelsAvailable
        ? (await ctx.apiFor('tunnels').get('/state').catch(() => ({ servers: [] }))).servers : [];
      const projectList = await projects();
      const opt = (value, label, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
      return `
        <div class="form-grid">
          <div class="form-row"><label>ID (non modificabile)</label><input class="form-input" id="f_db_id" value="${esc(c.id || '')}" placeholder="es. app_locale" ${c.id ? 'disabled' : ''}></div>
          <div class="form-row"><label>Nome</label><input class="form-input" id="f_db_label" value="${esc(c.label || '')}" placeholder="es. App — locale"></div>
        </div>
        ${tunnelsAvailable ? `<div class="form-row"><label>Collegamento</label>
          <select class="form-input" id="f_db_tunnel" onchange="document.getElementById('f_db_direct').hidden=!!this.value">
            ${opt('', 'Diretto (host e porta)', !c.tunnel)}
            ${tunnelServers.map(s => opt(s.key, `Tunnel SSH: ${s.label} (→ ${s.remote})`, c.tunnel === s.key)).join('')}
          </select></div>` : ''}
        <div class="form-grid" id="f_db_direct" ${c.tunnel ? 'hidden' : ''}>
          <div class="form-row"><label>Host</label><input class="form-input" id="f_db_host" value="${esc(c.host || '127.0.0.1')}"></div>
          <div class="form-row"><label>Porta</label><input class="form-input" id="f_db_port" type="number" min="1" max="65535" value="${esc(c.port || 3306)}"></div>
        </div>
        <div class="form-grid">
          <div class="form-row"><label>Utente</label><input class="form-input" id="f_db_user" value="${esc(c.user || '')}" autocomplete="off"></div>
          <div class="form-row"><label>Password${c.id ? ' (vuota = invariata)' : ''}</label><input class="form-input" id="f_db_password" type="password" autocomplete="new-password" placeholder="${c.hasPassword ? '••••••••' : ''}"></div>
        </div>
        <div class="form-grid">
          <div class="form-row"><label>Database (opzionale)</label><input class="form-input" id="f_db_database" value="${esc(c.database || '')}"></div>
          ${projectList.length ? `<div class="form-row"><label>Progetto (opzionale)</label><select class="form-input" id="f_db_project">
            ${opt('', '— Nessuno —', !c.projectId)}${projectList.map(p => opt(p.id, p.label, c.projectId === p.id)).join('')}</select></div>` : ''}
        </div>
        <label class="db-check"><input type="checkbox" id="f_db_readonly" ${c.readOnly ? 'checked' : ''}> Sola lettura (blocca qualsiasi modifica a dati e schema)</label>
        ${c.hasPassword ? '<label class="db-check"><input type="checkbox" id="f_db_clear"> Rimuovi la password salvata</label>' : ''}`;
    }

    function formValues() {
      const v = id => (document.getElementById(id)?.value ?? '').trim();
      const tunnel = v('f_db_tunnel');
      const password = document.getElementById('f_db_password')?.value || '';
      return {
        id: v('f_db_id'), label: v('f_db_label'), user: v('f_db_user'), database: v('f_db_database'),
        projectId: v('f_db_project'), tunnel,
        ...(tunnel ? {} : { host: v('f_db_host'), port: v('f_db_port') }),
        readOnly: !!document.getElementById('f_db_readonly')?.checked,
        password: document.getElementById('f_db_clear')?.checked ? null : password,
      };
    }

    // ---- editor ----
    const sqlInput = $(ctx.root, 'sql');
    function syncHighlight() {
      $(ctx.root, 'highlight').innerHTML = highlightSql(sqlInput.value, esc);
      const pre = $(ctx.root, 'highlight').parentElement;
      pre.scrollTop = sqlInput.scrollTop;
      pre.scrollLeft = sqlInput.scrollLeft;
    }
    sqlInput.addEventListener('input', () => { if (activeId) editors.set(activeId, sqlInput.value); syncHighlight(); });
    sqlInput.addEventListener('scroll', syncHighlight);
    sqlInput.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
      else if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        sqlInput.setRangeText('  ', sqlInput.selectionStart, sqlInput.selectionEnd, 'end');
        sqlInput.dispatchEvent(new Event('input'));
      }
    });

    async function loadDatabases(c) {
      const select = $(ctx.root, 'database');
      select.innerHTML = c.database ? `<option>${esc(c.database)}</option>` : '<option value="">— nessuno —</option>';
      try {
        const r = await ctx.api.get(`/connections/${encodeURIComponent(c.id)}/databases`);
        if (activeId !== c.id) return;
        select.innerHTML = `<option value="">— nessuno —</option>` + r.databases.map(d => `<option ${d === (select.dataset.chosen || r.default) ? 'selected' : ''}>${esc(d)}</option>`).join('');
      } catch { /* senza connessione resta il database configurato */ }
    }

    // Testo da eseguire: la selezione, se c'è, altrimenti tutto
    const statement = () => {
      const sel = sqlInput.value.slice(sqlInput.selectionStart, sqlInput.selectionEnd);
      return (sel.trim() ? sel : sqlInput.value).trim();
    };

    let running = false;
    async function run(confirmToken) {
      const c = active();
      const sql = typeof confirmToken === 'object' ? confirmToken.sql : statement();
      if (!c || !sql || running) return;
      const body = {
        sql, database: $(ctx.root, 'database').value || null, limit: Number($(ctx.root, 'limit').value),
        ...(typeof confirmToken === 'object' ? { confirm: confirmToken.token } : {}),
      };
      running = true;
      $(ctx.root, 'results').innerHTML = '<div class="db-muted db-pad">Esecuzione...</div>';
      try {
        const res = await fetch(ctx.api.url(`/connections/${encodeURIComponent(c.id)}/query`), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 428 && data.needsConfirmation) askConfirmation(data);
        else if (!res.ok) renderError(data.error || `HTTP ${res.status}`, sql);
        else renderResult(data, sql);
      } catch (e) {
        renderError(e.message, sql);
      } finally {
        running = false;
      }
    }

    // Nessuna modifica parte senza che l'utente veda e confermi l'istruzione esatta
    let pendingConfirm = null;
    function askConfirmation(data) {
      pendingConfirm = data;
      $(ctx.root, 'results').innerHTML = '<div class="db-muted db-pad">In attesa di conferma…</div>';
      openModal('Conferma modifica', `
        <p class="db-confirm-text">Questa istruzione <strong>${esc(data.verb || 'sconosciuta')}</strong> può modificare dati o schema${data.database ? ` del database <strong>${esc(data.database)}</strong>` : ''} su <strong>${esc(active()?.label || '')}</strong>.${data.reason ? ` <span class="db-muted">(${esc(data.reason)})</span>` : ''}</p>
        <pre class="db-confirm-sql">${highlightSql(data.sql, esc)}</pre>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal();Ext['db-client'].cancelConfirm()">Annulla</button>
         <button class="btn btn-danger" onclick="Ext['db-client'].confirmRun()">Esegui</button>`);
    }

    function renderError(message, sql) {
      $(ctx.root, 'results').innerHTML = `<div class="db-error">✖ ${esc(message)}</div>`;
    }

    function renderResult(data) {
      const el = $(ctx.root, 'results');
      if (data.kind === 'result') {
        el.innerHTML = `<div class="db-ok">✓ ${esc(data.affectedRows)} righe interessate${data.insertId ? ` · insertId ${esc(data.insertId)}` : ''}${data.info ? ` · ${esc(data.info)}` : ''} <span class="db-muted">(${esc(data.ms)} ms)</span></div>`;
        return;
      }
      el.innerHTML = `
        <div class="db-result-meta">${esc(data.rowCount)} righe${data.truncated ? ` (limitate a ${esc(data.limit)})` : ''} · ${esc(data.ms)} ms</div>
        <div class="db-table-wrap"><table class="data-table db-table">
          <thead><tr>${data.columns.map(col => `<th title="${esc(col.type)}">${esc(col.name)}</th>`).join('')}</tr></thead>
          <tbody>${data.rows.map(row => `<tr>${row.map(v => v === null ? '<td class="db-null">NULL</td>' : `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>`;
    }

    const modalButtons = (label, call) =>
      `<button class="btn btn-ghost" onclick="UI.closeModal()">Annulla</button><button class="btn btn-primary" onclick="${esc(call)}">${esc(label)}</button>`;

    function renderGate() {
      const creating = vault.state === 'uninitialized';
      $(ctx.root, 'gate-title').textContent = creating ? 'Crea la master password' : 'Database bloccato';
      $(ctx.root, 'gate-text').textContent = creating
        ? `Le password dei database vengono cifrate con questa password. Non viene salvata da nessuna parte: se la dimentichi le password salvate andranno reinserite. Almeno ${vault.minLength} caratteri.`
        : `Inserisci la master password per usare le connessioni. Si blocca da sola dopo ${vault.lockAfterMinutes} minuti di inattività.`;
      $(ctx.root, 'gate-password').placeholder = 'Master password';
      $(ctx.root, 'gate-confirm').hidden = !creating;
      $(ctx.root, 'gate-forgot').hidden = creating;
      $(ctx.root, 'gate-submit').textContent = creating ? 'Crea' : 'Sblocca';
      $(ctx.root, 'gate-error').textContent = '';
      setTimeout(() => $(ctx.root, 'gate-password').focus(), 0);
    }

    async function submitGate(e) {
      e.preventDefault();
      const pwd = $(ctx.root, 'gate-password').value;
      const error = $(ctx.root, 'gate-error');
      if (vault.state === 'uninitialized') {
        if ([...pwd].length < vault.minLength) { error.textContent = `Almeno ${vault.minLength} caratteri`; return; }
        if (pwd !== $(ctx.root, 'gate-confirm').value) { error.textContent = 'Le due password non coincidono'; return; }
      }
      const submit = $(ctx.root, 'gate-submit');
      submit.disabled = true;
      try {
        await ctx.api.post(vault.state === 'uninitialized' ? '/vault/init' : '/vault/unlock', { password: pwd });
        $(ctx.root, 'gate-password').value = '';
        $(ctx.root, 'gate-confirm').value = '';
        await loadVault();
      } catch (err) {
        error.textContent = err.message;
      } finally {
        submit.disabled = false;
      }
    }

    // Menu del vault: blocca, cambia password, timeout
    function vaultMenu() {
      openModal('Master password', `
        <div class="form-row"><label>Password attuale</label><input class="form-input" type="password" id="f_vault_old" autocomplete="off"></div>
        <div class="form-row"><label>Nuova password (almeno ${esc(vault.minLength)} caratteri)</label><input class="form-input" type="password" id="f_vault_new" autocomplete="off"></div>
        <div class="form-row"><label>Ripeti la nuova password</label><input class="form-input" type="password" id="f_vault_new2" autocomplete="off"></div>
        <div class="form-row"><label>Blocco automatico dopo (minuti di inattività)</label><input class="form-input" type="number" min="1" max="1440" id="f_vault_minutes" value="${esc(vault.lockAfterMinutes)}"></div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">Annulla</button>
         <button class="btn btn-ghost" onclick="Ext['db-client'].lock()">🔒 Blocca ora</button>
         <button class="btn btn-primary" onclick="Ext['db-client'].saveVault()">Salva</button>`);
    }

    async function saveVault() {
      const val = id => document.getElementById(id)?.value || '';
      try {
        const minutes = Number(val('f_vault_minutes'));
        if (minutes !== vault.lockAfterMinutes) await ctx.api.post('/vault/settings', { lockAfterMinutes: minutes });
        if (val('f_vault_new')) {
          if (val('f_vault_new') !== val('f_vault_new2')) { toast('Le nuove password non coincidono', 'error'); return; }
          const r = await ctx.api.post('/vault/change', { oldPassword: val('f_vault_old'), newPassword: val('f_vault_new') });
          toast(`Master password cambiata (${r.reencrypted} password ri-cifrate)`, 'success');
        } else {
          toast('Impostazioni salvate', 'success');
        }
        closeModal();
        await loadVault();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function lock() {
      closeModal();
      await ctx.api.post('/vault/lock').catch(() => {});
      await loadVault();
    }

    async function resetVault() {
      if (prompt('Le password salvate verranno cancellate (le connessioni restano). Scrivi RESET per confermare:') !== 'RESET') return;
      try {
        await ctx.api.post('/vault/reset', { confirm: 'RESET' });
        toast('Master password azzerata: creane una nuova', 'success');
        await loadVault();
      } catch (e) { toast(e.message, 'error'); }
    }

    const actions = {
      lock, saveVault,
      run: () => run(),
      confirmRun() {
        const data = pendingConfirm;
        pendingConfirm = null;
        closeModal();
        if (data) run({ sql: data.sql, token: data.token });
      },
      cancelConfirm() {
        pendingConfirm = null;
        $(ctx.root, 'results').innerHTML = '<div class="db-muted db-pad">Esecuzione annullata: nessuna modifica.</div>';
      },
      select(id) { activeId = id; renderConnections(); renderWorkspace(); },
      async addConnection() { openModal('Nuova connessione', await connectionForm(), modalButtons('Crea', "Ext['db-client'].saveConnection()")); },
      async editConnection(id) {
        const c = connections.find(x => x.id === id);
        if (c) openModal('Modifica connessione', await connectionForm(c), modalButtons('Salva', `Ext['db-client'].saveConnection(${JSON.stringify(id)})`));
      },
      async saveConnection(existingId) {
        const body = formValues();
        if (!body.label || !body.user || (!existingId && !body.id)) { toast('ID, nome e utente sono obbligatori', 'error'); return; }
        try {
          const r = existingId
            ? await ctx.api.put(`/connections/${encodeURIComponent(existingId)}`, body)
            : await ctx.api.post('/connections', body);
          closeModal();
          toast('Connessione salvata', 'success');
          activeId = r.connection.id;
          await loadConnections();
        } catch (e) { toast(e.message, 'error'); }
      },
      async deleteConnection(id) {
        const c = connections.find(x => x.id === id);
        if (!c || !confirm(`Eliminare la connessione "${c.label}"? Il database non viene toccato.`)) return;
        try {
          await ctx.api.del(`/connections/${encodeURIComponent(id)}`);
          if (activeId === id) activeId = null;
          toast('Connessione eliminata', 'success');
          await loadConnections();
        } catch (e) { toast(e.message, 'error'); }
      },
      async testConnection(id) {
        toast('Connessione in corso...');
        try {
          const r = await ctx.api.post(`/connections/${encodeURIComponent(id)}/test`);
          toast(`✓ MySQL ${r.version} — ${r.user}${r.via ? ` via tunnel ${r.via}` : ''} (${r.ms} ms)`, 'success');
        } catch (e) { toast(e.message, 'error'); }
      },
    };

    $(ctx.root, 'gate-form').addEventListener('submit', submitGate);
    ctx.root.addEventListener('click', e => {
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (a === 'vault-reset') resetVault();
      else if (a === 'run') run();
    });
    $(ctx.root, 'database').addEventListener('change', e => { e.target.dataset.chosen = e.target.value; });
    ctx.sidebar.addEventListener('click', e => {
      if (e.target.closest('[data-action="vault-menu"]')) vaultMenu();
      else if (e.target.closest('[data-action="add-connection"]')) actions.addConnection();
    });
    ctx.bus.on('npm:projects-changed', () => { if (vault.state === 'unlocked') renderConnections(); });
    ctx.expose(actions);

    this.show = loadVault;
    this.refresh = loadVault;
  },
};
