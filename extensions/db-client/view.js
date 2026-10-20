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
    const activeDb = new Map(); // database attivo per connessione

    // Albero della sidebar: connessione ▸ database ▸ tabelle ▸ colonne (caricati all'apertura)
    const open = new Set();      // nodi aperti: "c|id", "d|id|db", "t|id|db|table"
    const cache = new Map();     // stesse chiavi → { loading } | { error } | dati
    const nodeKey = (...parts) => parts.join('|');
    const quoteId = name => '`' + String(name).replace(/`/g, '``') + '`';

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
        el.innerHTML = '<p class="db-muted db-pad">Nessuna connessione.<br><br><button class="btn btn-ghost btn-sm" data-tree="add">+ Aggiungi</button></p>';
        return;
      }
      const labels = new Map((await projects()).map(p => [p.id, p.label]));
      const groups = new Map();
      for (const c of connections) {
        const g = c.projectId && labels.has(c.projectId) ? labels.get(c.projectId) : '';
        groups.set(g, [...(groups.get(g) || []), c]);
      }
      const keys = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
      el.innerHTML = `<div class="db-tree" role="tree">${keys.map(g => `
        ${keys.length > 1 || g ? `<div class="db-group">${esc(g || 'Senza progetto')}</div>` : ''}
        ${groups.get(g).map(connNode).join('')}`).join('')}</div>`;
    }

    const caret = (key, leaf) => leaf ? '<span class="db-caret"></span>'
      : `<span class="db-caret" data-act="toggle">${open.has(key) ? '▾' : '▸'}</span>`;
    const loading = entry => !entry || entry.loading ? '<div class="db-tree-msg">Caricamento…</div>'
      : entry.error ? `<div class="db-tree-msg db-tree-err">${esc(entry.error)}</div>` : '';
    const attrs = (kind, c, db, table) =>
      `data-tree="${kind}" data-conn="${esc(c.id)}"${db != null ? ` data-db="${esc(db)}"` : ''}${table != null ? ` data-table="${esc(table)}"` : ''}`;

    function connNode(c) {
      const k = nodeKey('c', c.id);
      const entry = cache.get(k);
      return `<div class="db-node">
        <div class="db-row db-row-conn ${c.id === activeId ? 'active' : ''}" ${attrs('conn', c)} title="${esc(target(c))}">
          ${caret(k)}<span class="db-row-icon">${c.readOnly ? '🔒' : '🗄️'}</span><span class="db-row-label">${esc(c.label)}</span>
        </div>
        ${open.has(k) ? `<div class="db-children">${loading(entry) || entry.map(db => dbNode(c, db)).join('') || '<div class="db-tree-msg">Nessun database</div>'}</div>` : ''}
      </div>`;
    }

    function dbNode(c, db) {
      const k = nodeKey('d', c.id, db);
      const entry = cache.get(k);
      const isActive = c.id === activeId && activeDb.get(c.id) === db;
      return `<div class="db-node">
        <div class="db-row db-row-db ${isActive ? 'active' : ''}" ${attrs('db', c, db)}>
          ${caret(k)}<span class="db-row-icon">🛢️</span><span class="db-row-label">${esc(db)}</span>
        </div>
        ${open.has(k) ? `<div class="db-children">${loading(entry) || entry.map(t => tableNode(c, db, t)).join('') || '<div class="db-tree-msg">Nessuna tabella</div>'}</div>` : ''}
      </div>`;
    }

    function tableNode(c, db, t) {
      const k = nodeKey('t', c.id, db, t.name);
      const entry = cache.get(k);
      return `<div class="db-node">
        <div class="db-row db-row-table" ${attrs('table', c, db, t.name)} title="${esc(t.comment || t.name)}${t.rowsEstimate != null ? ` · ~${esc(t.rowsEstimate)} righe` : ''}">
          ${caret(k)}<span class="db-row-icon">${t.view ? '👁' : '▦'}</span><span class="db-row-label">${esc(t.name)}</span>
        </div>
        ${open.has(k) ? `<div class="db-children">${loading(entry) || entry.columns.map(col => `
          <div class="db-row db-row-col" title="${esc(col.comment || '')}">
            <span class="db-caret"></span><span class="db-row-icon">${col.key === 'PRI' ? '🔑' : col.key ? '◆' : '·'}</span>
            <span class="db-row-label">${esc(col.name)}</span><span class="db-col-type">${esc(col.type)}${col.nullable ? '' : ' NN'}</span>
          </div>`).join('')}</div>` : ''}
      </div>`;
    }

    // Carica i figli di un nodo (una volta; ↻ svuota la cache)
    async function loadNode(k, url, map = x => x) {
      if (cache.get(k) && !cache.get(k).error) return;
      cache.set(k, { loading: true });
      renderConnections();
      try { cache.set(k, map(await ctx.api.get(url))); }
      catch (e) { cache.set(k, { error: e.message }); }
      renderConnections();
    }

    const loadDatabases = c => loadNode(nodeKey('c', c.id), `/connections/${encodeURIComponent(c.id)}/databases`, r => r.databases);
    const loadTables = (c, db) => loadNode(nodeKey('d', c.id, db), `/connections/${encodeURIComponent(c.id)}/databases/${encodeURIComponent(db)}/tables`, r => r.tables);
    const tableUrl = (c, db, t) => `/connections/${encodeURIComponent(c.id)}/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(t)}`;
    const loadColumns = (c, db, t) => loadNode(nodeKey('t', c.id, db, t), tableUrl(c, db, t));

    function toggle(k, loader) {
      if (open.has(k)) open.delete(k); else { open.add(k); loader(); }
      renderConnections();
    }

    function setActiveDb(c, db) {
      activeDb.set(c.id, db);
      if (activeId !== c.id) actions.select(c.id); else { renderConnections(); renderActiveDb(); }
    }

    function renderActiveDb() {
      const db = activeDb.get(activeId);
      $(ctx.root, 'active-db').innerHTML = db ? `🛢️ ${esc(db)}` : '<span class="db-muted">nessun database: scegline uno dalla sidebar</span>';
    }

    // Testo nell'editor ed esecuzione (le modifiche passano comunque dalla conferma)
    function runSql(sql) {
      sqlInput.value = sql;
      sqlInput.dispatchEvent(new Event('input'));
      run();
    }

    // ---- anteprima dati (griglia paginata con ricerca, filtri e ordinamento) ----
    const FILTER_LABELS = { eq: '=', ne: '≠', contains: 'contiene', starts: 'inizia con', lt: '<', gt: '>', null: 'è NULL', notnull: 'non è NULL' };
    let grid = null; // { connId, db, table, page, pageSize, search, filters, sort, data }

    function openGrid(c, db, table) {
      grid = { connId: c.id, db, table, page: 1, pageSize: 50, search: '', filters: [], sort: null, data: null };
      loadGrid();
    }

    async function loadGrid() {
      if (!grid) return;
      const g = grid;
      g.selected = new Set(); // la selezione vale per la pagina mostrata
      const c = connections.find(x => x.id === g.connId);
      try {
        g.data = await ctx.api.post(tableUrl(c, g.db, g.table) + '/rows',
          { page: g.page, pageSize: g.pageSize, search: g.search, filters: g.filters, sort: g.sort });
        if (grid === g) renderGrid();
      } catch (e) { if (grid === g) renderError(e.message); }
    }

    // Modifica possibile solo con chiave primaria e connessione scrivibile
    const gridEditable = () => grid?.data?.primaryKey.length > 0 && !connections.find(x => x.id === grid.connId)?.readOnly;
    const isAuto = col => /auto_increment/i.test(col.extra || '');
    // Valore cambiato? (i campi del form sono stringhe, i dati possono essere numeri o NULL)
    const changed = (next, prev) => next === null ? prev !== null : prev === null || next !== String(prev);
    const keyOf = row => Object.fromEntries(grid.data.primaryKey.map(k => [k, row[grid.data.columns.findIndex(c => c.name === k)]]));

    function renderGrid() {
      const { data, sort } = grid;
      const editable = gridEditable();
      const canInsert = !connections.find(x => x.id === grid.connId)?.readOnly;
      const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
      const el = $(ctx.root, 'results');
      const hadFocus = document.activeElement?.dataset?.grid === 'search';
      el.innerHTML = `
        <div class="db-grid-bar">
          <strong class="db-grid-title">${esc(grid.db)}.${esc(grid.table)}</strong>
          <input class="form-input db-grid-search" data-grid="search" placeholder="Cerca in tutte le colonne…" value="${esc(grid.search)}">
          <button class="btn btn-ghost btn-sm" data-grid="add-filter">+ Filtro</button>
          ${canInsert ? '<button class="btn btn-ghost btn-sm" data-grid="insert-dialog">+ Riga</button>' : ''}
          <button class="btn btn-ghost btn-sm" data-grid="export">⤓ Esporta</button>
          ${editable ? `<button class="btn btn-danger btn-sm" data-grid="delete-selected" ${grid.selected.size ? '' : 'hidden'}>🗑 Elimina selezionate (${grid.selected.size})</button>` : ''}
          ${!data.primaryKey.length ? '<span class="db-badge db-badge-warn" title="Senza chiave primaria le righe non si possono identificare">senza chiave primaria: modifica non disponibile</span>' : ''}
          ${grid.filters.map((f, i) => `<span class="db-chip">${esc(f.column)} ${esc(FILTER_LABELS[f.op])}${f.op === 'null' || f.op === 'notnull' ? '' : ` <b>${esc(f.value)}</b>`}<button data-grid="remove-filter" data-i="${i}" title="Rimuovi">✕</button></span>`).join('')}
          <div class="db-pager">
            <button class="btn btn-ghost btn-sm" data-grid="page" data-p="1" ${grid.page <= 1 ? 'disabled' : ''}>«</button>
            <button class="btn btn-ghost btn-sm" data-grid="page" data-p="${grid.page - 1}" ${grid.page <= 1 ? 'disabled' : ''}>‹</button>
            <span>Pagina ${esc(grid.page)} di ${esc(pages)} · ${esc(data.total)} righe</span>
            <button class="btn btn-ghost btn-sm" data-grid="page" data-p="${grid.page + 1}" ${grid.page >= pages ? 'disabled' : ''}>›</button>
            <button class="btn btn-ghost btn-sm" data-grid="page" data-p="${pages}" ${grid.page >= pages ? 'disabled' : ''}>»</button>
            <select class="form-input db-select db-page-size" data-grid="page-size">${data.pageSizes.map(n => `<option ${n === data.pageSize ? 'selected' : ''}>${n}</option>`).join('')}</select>
          </div>
        </div>
        <div class="db-table-wrap"><table class="data-table db-table">
          <thead><tr>${editable ? `<th class="db-row-actions"><input type="checkbox" data-grid="select-all" title="Seleziona tutte le righe della pagina" ${data.rows.length && grid.selected.size === data.rows.length ? 'checked' : ''}></th>` : ''}${data.columns.map(col => `<th data-grid="sort" data-col="${esc(col.name)}" title="${esc(col.type)}${col.key === 'PRI' ? ' · chiave primaria' : ''}">${col.key === 'PRI' ? '🔑 ' : ''}${esc(col.name)}${sort?.column === col.name ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead>
          <tbody>${data.rows.map((row, r) => `<tr data-r="${r}" class="${grid.selected.has(r) ? 'db-selected' : ''}">${editable ? `<td class="db-row-actions">
              <input type="checkbox" data-grid="select" data-r="${r}" ${grid.selected.has(r) ? 'checked' : ''}><button data-grid="edit-dialog" data-r="${r}" title="Modifica">✏️</button><button data-grid="delete-row" data-r="${r}" title="Elimina">🗑</button></td>` : ''}${row.map((v, c) =>
              `<td data-c="${c}" class="${v === null ? 'db-null' : ''}${editable ? ' db-editable' : ''}" title="${esc(v ?? 'NULL')}">${v === null ? 'NULL' : esc(v)}</td>`).join('')}</tr>`).join('')
            || `<tr><td class="db-muted" colspan="${data.columns.length + (editable ? 1 : 0)}">Nessuna riga</td></tr>`}
            ${canInsert ? `<tr class="db-new-row">${editable ? '<td class="db-row-actions"><button data-grid="insert-inline" title="Inserisci la riga">＋</button></td>' : ''}${data.columns.map(col =>
              `<td><input class="db-cell-input" data-new="${esc(col.name)}" placeholder="${isAuto(col) ? 'auto' : esc(col.default ?? (col.nullable ? 'NULL' : ''))}"></td>`).join('')}
              ${editable ? '' : '<td><button class="btn btn-ghost btn-sm" data-grid="insert-inline">＋ Inserisci</button></td>'}</tr>` : ''}</tbody>
        </table></div>`;
      if (hadFocus) { const i = el.querySelector('[data-grid="search"]'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
    }

    // ---- export (il server genera il file in streaming; qui si avvia solo il download) ----
    async function startExport(c, format, source) {
      try {
        const r = await ctx.api.post(`/connections/${encodeURIComponent(c.id)}/exports`, { format, source });
        window.location.href = ctx.api.url(`/connections/${encodeURIComponent(c.id)}/exports/${encodeURIComponent(r.id)}`);
        toast(`Export ${format.toUpperCase()}: ${r.filename}`, 'success');
      } catch (e) { toast(e.message, 'error'); }
    }

    const FORMATS = [['csv', 'CSV'], ['json', 'JSON'], ['sql', 'SQL (INSERT + CREATE TABLE)']];
    function exportMenu(anchor, items) {
      const r = anchor.getBoundingClientRect();
      ctx.ui.contextMenu(r.left, r.bottom + 4, items);
    }

    function exportTableMenu(anchor, c, db, table, withFilters) {
      const filtered = withFilters && (grid.search || grid.filters.length);
      const src = all => ({ type: 'table', db, table, ...(all ? {} : { search: grid.search, filters: grid.filters, sort: grid.sort }) });
      exportMenu(anchor, [
        ...FORMATS.map(([f, label]) => ({ icon: '⤓', label: `${label}${filtered ? ' — righe filtrate' : ''}`, action: () => startExport(c, f, src(!withFilters)) })),
        ...(filtered ? ['separator', ...FORMATS.map(([f, label]) => ({ icon: '⤓', label: `${label} — tutta la tabella`, action: () => startExport(c, f, src(true)) }))] : []),
      ]);
    }

    function exportQuery(anchor) {
      const c = active();
      const sql = statement();
      if (!c || !sql) { toast('Scrivi una SELECT nell\'editor', 'error'); return; }
      exportMenu(anchor, FORMATS.map(([f, label]) => ({
        icon: '⤓', label, action: () => startExport(c, f, { type: 'query', sql, database: activeDb.get(c.id) || null }),
      })));
    }

    // ---- scrittura delle righe: sempre tramite conferma dell'SQL generato ----
    async function saveRow(op, key, values, keys) {
      const c = connections.find(x => x.id === grid.connId);
      const url = tableUrl(c, grid.db, grid.table) + '/row';
      const send = async confirm => {
        try {
          const r = await ctx.api.post(url, { op, key, values, keys, ...(confirm ? { confirm } : {}) });
          const label = { insert: 'Riga inserita', update: 'Riga modificata', delete: 'Riga eliminata', 'delete-many': `${r.affectedRows} righe eliminate` }[op];
          toast(r.affectedRows ? `${label}${r.insertId ? ` (id ${r.insertId})` : ''}` : 'Nessuna riga modificata (già uguale o non trovata)', r.affectedRows ? 'success' : 'info');
          loadGrid();
        } catch (e) { toast(e.message, 'error'); }
      };
      try {
        const res = await fetch(ctx.api.url(url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, key, values, keys }) });
        const data = await res.json().catch(() => ({}));
        if (res.status === 428 && data.needsConfirmation) askConfirmation(data, send, true);
        else toast(data.error || `HTTP ${res.status}`, 'error'); // le scritture chiedono sempre conferma
      } catch (e) { toast(e.message, 'error'); }
    }

    // Modifica in linea: doppio clic sulla cella
    function editCell(td) {
      if (!gridEditable() || td.querySelector('input')) return;
      const r = Number(td.parentElement.dataset.r), c = Number(td.dataset.c);
      const col = grid.data.columns[c];
      const value = grid.data.rows[r][c];
      td.innerHTML = `<div class="db-cell-edit"><input class="db-cell-input" value="${esc(value ?? '')}" placeholder="${value === null ? 'NULL' : ''}">
        ${col.nullable ? '<button title="Imposta NULL" data-null>NULL</button>' : ''}</div>`;
      const input = td.querySelector('input');
      input.focus();
      input.select();
      let done = false;
      const finish = (save, setNull) => {
        if (done) return;
        done = true;
        const next = setNull ? null : input.value;
        if (!save || !changed(next, value) || (next === '' && value === null)) { renderGrid(); return; }
        saveRow('update', keyOf(grid.data.rows[r]), { [col.name]: next });
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => setTimeout(() => finish(false), 150));
      td.querySelector('[data-null]')?.addEventListener('mousedown', e => { e.preventDefault(); finish(true, true); });
    }

    // Dialog con un campo per colonna (inserimento o modifica)
    const LONG_TYPES = /text|blob|json|geometry/i;
    function rowDialog(r) {
      const editing = r != null;
      const row = editing ? grid.data.rows[r] : null;
      const fields = grid.data.columns.map((col, c) => {
        const v = editing ? row[c] : null;
        const id = `f_row_${c}`;
        const input = LONG_TYPES.test(col.dataType)
          ? `<textarea class="form-input" id="${id}" rows="3">${esc(v ?? '')}</textarea>`
          : `<input class="form-input" id="${id}" value="${esc(v ?? '')}" placeholder="${!editing && isAuto(col) ? 'automatico' : esc(col.type)}">`;
        return `<div class="form-row">
          <label>${col.key === 'PRI' ? '🔑 ' : ''}${esc(col.name)} <span class="db-muted">${esc(col.type)}</span></label>
          ${input}
          ${col.nullable ? `<label class="db-check"><input type="checkbox" id="${id}_null" ${editing && v === null ? 'checked' : ''}> NULL</label>` : ''}
        </div>`;
      }).join('');
      openModal(editing ? 'Modifica riga' : 'Nuova riga', `<div class="db-row-form">${fields}</div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">Annulla</button>
         <button class="btn btn-primary" onclick="Ext['db-client'].saveRowDialog(${editing ? r : 'null'})">${editing ? 'Salva' : 'Inserisci'}</button>`);
    }

    function addFilter() {
      const cols = grid.data.columns;
      openModal('Aggiungi filtro', `
        <div class="form-grid">
          <div class="form-row"><label>Colonna</label><select class="form-input" id="f_flt_col">${cols.map(c => `<option>${esc(c.name)}</option>`).join('')}</select></div>
          <div class="form-row"><label>Condizione</label><select class="form-input" id="f_flt_op" onchange="document.getElementById('f_flt_val_row').hidden=['null','notnull'].includes(this.value)">
            ${Object.entries(FILTER_LABELS).map(([op, l]) => `<option value="${op}">${esc(l)}</option>`).join('')}</select></div>
        </div>
        <div class="form-row" id="f_flt_val_row"><label>Valore</label><input class="form-input" id="f_flt_val"></div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">Annulla</button><button class="btn btn-primary" onclick="Ext['db-client'].applyFilter()">Applica</button>`);
    }

    let searchTimer = null;
    $(ctx.root, 'results').addEventListener('input', e => {
      if (e.target.dataset.grid !== 'search') return;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { grid.search = e.target.value; grid.page = 1; loadGrid(); }, 300);
    });
    $(ctx.root, 'results').addEventListener('dblclick', e => {
      const td = e.target.closest('td.db-editable');
      if (td && grid) editCell(td);
    });
    $(ctx.root, 'results').addEventListener('change', e => {
      if (e.target.dataset.grid === 'page-size') { grid.pageSize = Number(e.target.value); grid.page = 1; loadGrid(); }
    });
    $(ctx.root, 'results').addEventListener('click', e => {
      const t = e.target.closest('[data-grid]');
      if (!t || !grid) return;
      const a = t.dataset.grid;
      if (a === 'page') { grid.page = Number(t.dataset.p); loadGrid(); }
      else if (a === 'sort') {
        const col = t.dataset.col;
        grid.sort = grid.sort?.column !== col ? { column: col, dir: 'asc' } : grid.sort.dir === 'asc' ? { column: col, dir: 'desc' } : null;
        grid.page = 1;
        loadGrid();
      } else if (a === 'add-filter') addFilter();
      else if (a === 'insert-dialog') rowDialog(null);
      else if (a === 'export') exportTableMenu(t, connections.find(x => x.id === grid.connId), grid.db, grid.table, true);
      else if (a === 'edit-dialog') rowDialog(Number(t.dataset.r));
      else if (a === 'delete-row') saveRow('delete', keyOf(grid.data.rows[Number(t.dataset.r)]));
      else if (a === 'select' || a === 'select-all') {
        if (a === 'select') { const r = Number(t.dataset.r); grid.selected.has(r) ? grid.selected.delete(r) : grid.selected.add(r); }
        else grid.selected = t.checked ? new Set(grid.data.rows.map((_, i) => i)) : new Set();
        renderGrid();
      } else if (a === 'delete-selected' && grid.selected.size) {
        const keys = [...grid.selected].sort((x, y) => x - y).map(r => keyOf(grid.data.rows[r]));
        saveRow('delete-many', null, null, keys);
      }
      else if (a === 'insert-inline') {
        const values = {};
        for (const input of $(ctx.root, 'results').querySelectorAll('[data-new]')) if (input.value !== '') values[input.dataset.new] = input.value;
        saveRow('insert', null, values);
      }
      else if (a === 'remove-filter') { grid.filters.splice(Number(t.dataset.i), 1); grid.page = 1; loadGrid(); }
    });

    function tableMenu(ev, c, db, name) {
      const t = (cache.get(nodeKey('d', c.id, db)) || []).find?.(x => x.name === name);
      const full = `${quoteId(db)}.${quoteId(name)}`;
      const ro = c.readOnly;
      ctx.ui.contextMenu(ev.clientX, ev.clientY, [
        { icon: '▤', label: 'Apri dati', action: () => openGrid(c, db, name) },
        { icon: '▶', label: 'Prime 100 righe nell\'editor', action: () => runSql(`SELECT * FROM ${full} LIMIT 100;`) },
        { icon: '#', label: 'Conta righe', action: () => runSql(`SELECT COUNT(*) AS righe FROM ${full};`) },
        { icon: '▦', label: 'Struttura', action: () => showStructure(c, db, name) },
        ...FORMATS.map(([f, label]) => ({ icon: '⤓', label: `Esporta ${label}`, action: () => startExport(c, f, { type: 'table', db, table: name }) })),
        { icon: '⌘', label: t?.view ? 'SHOW CREATE VIEW' : 'SHOW CREATE TABLE', action: () => runSql(`SHOW CREATE ${t?.view ? 'VIEW' : 'TABLE'} ${full};`) },
        'separator',
        { icon: '↳', label: 'Inserisci il nome nell\'editor', action: () => {
          sqlInput.setRangeText(full, sqlInput.selectionStart, sqlInput.selectionEnd, 'end');
          sqlInput.dispatchEvent(new Event('input'));
          sqlInput.focus();
        } },
        { icon: '⧉', label: 'Copia il nome', action: () => navigator.clipboard?.writeText(name).then(() => toast('Nome copiato')) },
        'separator',
        ...(t?.view ? [] : [{ icon: '⌫', label: 'Svuota tabella (TRUNCATE)…', danger: true, disabled: ro, action: () => runSql(`TRUNCATE TABLE ${full};`) }]),
        { icon: '✕', label: t?.view ? 'Elimina vista (DROP)…' : 'Elimina tabella (DROP)…', danger: true, disabled: ro, action: () => runSql(`DROP ${t?.view ? 'VIEW' : 'TABLE'} ${full};`) },
      ]);
    }

    async function showStructure(c, db, name) {
      grid = null;
      const el = $(ctx.root, 'results');
      el.innerHTML = '<div class="db-muted db-pad">Caricamento struttura…</div>';
      try {
        const info = await ctx.api.get(tableUrl(c, db, name));
        const table = (head, rows) => `<table class="data-table db-table"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
        el.innerHTML = `
          <div class="db-result-meta">Struttura di ${esc(db)}.${esc(name)}</div>
          <div class="db-table-wrap db-structure">
            <h4>Colonne</h4>
            ${table(['Nome', 'Tipo', 'NULL', 'Chiave', 'Default', 'Extra', 'Commento'], info.columns.map(col => `<tr>
              <td>${esc(col.name)}</td><td>${esc(col.type)}</td><td>${col.nullable ? 'sì' : 'no'}</td><td>${esc(col.key)}</td>
              <td>${col.default === null ? '<span class="db-null">NULL</span>' : esc(col.default)}</td><td>${esc(col.extra)}</td><td>${esc(col.comment)}</td></tr>`))}
            <h4>Indici</h4>
            ${info.indexes.length ? table(['Nome', 'Colonne', 'Univoco'], info.indexes.map(i => `<tr><td>${esc(i.name)}</td><td>${esc(i.columns.join(', '))}</td><td>${i.unique ? 'sì' : 'no'}</td></tr>`)) : '<p class="db-muted db-pad">Nessuno</p>'}
            <h4>Chiavi esterne</h4>
            ${info.foreignKeys.length ? table(['Nome', 'Colonne', 'Riferimento'], info.foreignKeys.map(f => `<tr><td>${esc(f.name)}</td><td>${esc(f.columns.join(', '))}</td><td>${esc(f.refDatabase)}.${esc(f.refTable)} (${esc(f.refColumns.join(', '))})</td></tr>`)) : '<p class="db-muted db-pad">Nessuna</p>'}
          </div>`;
      } catch (e) { renderError(e.message); }
    }

    const target = c => c.tunnel ? `tunnel ${c.tunnel}` : `${c.host}:${c.port}`;

    function renderWorkspace() {
      const c = active();
      $(ctx.root, 'no-connection').hidden = !!c;
      $(ctx.root, 'workspace').hidden = !c;
      if (!c) return;
      $(ctx.root, 'sql').value = editors.get(c.id) || '';
      syncHighlight();
      if (!activeDb.has(c.id) && c.database) activeDb.set(c.id, c.database);
      renderActiveDb();
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
        sql, database: activeDb.get(c.id) || null, limit: Number($(ctx.root, 'limit').value),
        ...(typeof confirmToken === 'object' ? { confirm: confirmToken.token } : {}),
      };
      running = true;
      grid = null;
      $(ctx.root, 'results').innerHTML = '<div class="db-muted db-pad">Esecuzione...</div>';
      try {
        const res = await fetch(ctx.api.url(`/connections/${encodeURIComponent(c.id)}/query`), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 428 && data.needsConfirmation) askConfirmation(data, token => run({ sql: data.sql, token }));
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
    // onConfirm(token) rimanda la stessa richiesta con il token della conferma
    function askConfirmation(data, onConfirm, keepResults = false) {
      pendingConfirm = { data, onConfirm, keepResults };
      if (!keepResults) $(ctx.root, 'results').innerHTML = '<div class="db-muted db-pad">In attesa di conferma…</div>';
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
      saveRowDialog(r) {
        const editing = r != null;
        const row = editing ? grid.data.rows[r] : null;
        const values = {};
        grid.data.columns.forEach((col, c) => {
          const isNull = document.getElementById(`f_row_${c}_null`)?.checked;
          const v = isNull ? null : document.getElementById(`f_row_${c}`).value;
          if (editing ? changed(v, row[c]) : (v !== '' || isNull)) values[col.name] = v; // solo i campi cambiati / compilati
        });
        if (editing && !Object.keys(values).length) { toast('Nessuna modifica'); return; }
        closeModal();
        saveRow(editing ? 'update' : 'insert', editing ? keyOf(row) : null, values);
      },
      applyFilter() {
        const op = document.getElementById('f_flt_op').value;
        grid.filters.push({ column: document.getElementById('f_flt_col').value, op, value: document.getElementById('f_flt_val').value });
        grid.page = 1;
        closeModal();
        loadGrid();
      },
      confirmRun() {
        const p = pendingConfirm;
        pendingConfirm = null;
        closeModal();
        if (p) p.onConfirm(p.data.token);
      },
      cancelConfirm() {
        const p = pendingConfirm;
        pendingConfirm = null;
        if (p && !p.keepResults) $(ctx.root, 'results').innerHTML = '<div class="db-muted db-pad">Esecuzione annullata: nessuna modifica.</div>';
        else toast('Nessuna modifica eseguita');
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
      else if (a === 'export-query') exportQuery(e.target.closest('[data-action]'));
    });
    // Albero: freccia apre/chiude; clic sulla connessione la seleziona, sul database lo rende
    // attivo, sulla tabella apre il menu contestuale (anche con il tasto destro)
    function onTree(e, contextual) {
      const row = e.target.closest('[data-tree]');
      if (!row) return;
      if (row.dataset.tree === 'add') return actions.addConnection();
      const c = connections.find(x => x.id === row.dataset.conn);
      if (!c) return;
      const { db, table } = row.dataset;
      const toggling = e.target.closest('[data-act="toggle"]');
      if (contextual) e.preventDefault();
      if (row.dataset.tree === 'conn') {
        if (toggling) return toggle(nodeKey('c', c.id), () => loadDatabases(c));
        if (!open.has(nodeKey('c', c.id))) toggle(nodeKey('c', c.id), () => loadDatabases(c));
        actions.select(c.id);
      } else if (row.dataset.tree === 'db') {
        if (toggling) return toggle(nodeKey('d', c.id, db), () => loadTables(c, db));
        if (!open.has(nodeKey('d', c.id, db))) toggle(nodeKey('d', c.id, db), () => loadTables(c, db));
        setActiveDb(c, db);
      } else if (row.dataset.tree === 'table') {
        if (toggling) return toggle(nodeKey('t', c.id, db, table), () => loadColumns(c, db, table));
        if (activeId !== c.id || activeDb.get(c.id) !== db) setActiveDb(c, db);
        tableMenu(e, c, db, table);
      }
    }
    ctx.sidebar.addEventListener('click', e => onTree(e, false));
    ctx.sidebar.addEventListener('contextmenu', e => { if (e.target.closest('[data-tree="table"]')) onTree(e, true); });
    ctx.sidebar.addEventListener('click', e => {
      if (e.target.closest('[data-action="vault-menu"]')) vaultMenu();
      else if (e.target.closest('[data-action="add-connection"]')) actions.addConnection();
    });
    ctx.bus.on('npm:projects-changed', () => { if (vault.state === 'unlocked') renderConnections(); });
    ctx.expose(actions);

    // ↻: lo schema può essere cambiato (anche da questa sessione): ricarica i nodi aperti
    function reopen() {
      for (const k of open) {
        const [kind, id, db, table] = k.split('|');
        const c = connections.find(x => x.id === id);
        if (!c) continue;
        if (kind === 'c') loadDatabases(c); else if (kind === 'd') loadTables(c, db); else loadColumns(c, db, table);
      }
    }
    this.show = loadVault;
    this.refresh = async () => { cache.clear(); await loadVault(); reopen(); };
  },
};
