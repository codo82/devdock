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

// ---- autocompletamento dell'editor SQL ----

const SQL_FUNCTIONS = `COUNT SUM AVG MIN MAX NOW CURDATE CURRENT_TIMESTAMP CONCAT CONCAT_WS COALESCE IFNULL NULLIF IF LOWER UPPER LENGTH
SUBSTRING TRIM REPLACE ROUND FLOOR CEIL ABS DATE_FORMAT DATE_ADD DATE_SUB DATEDIFF YEAR MONTH DAY JSON_EXTRACT JSON_UNQUOTE
JSON_OBJECT JSON_ARRAY JSON_CONTAINS GROUP_CONCAT CAST CONVERT UUID`.split(/\s+/);
// parole che possono seguire il nome di una tabella e quindi non sono alias
const NOT_ALIAS = new Set(['WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'ON', 'USING', 'SET', 'GROUP', 'ORDER',
  'LIMIT', 'HAVING', 'VALUES', 'SELECT', 'UNION', 'NATURAL', 'STRAIGHT_JOIN', 'FOR', 'LOCK', 'WINDOW', 'PARTITION', 'AS']);
const unq = id => String(id).replace(/^`|`$/g, '').replace(/``/g, '`');
const quoteIfNeeded = name => (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && !SQL_KEYWORDS.has(name.toUpperCase()) ? name : '`' + name.replace(/`/g, '``') + '`');

// Tabelle citate nel testo (FROM/JOIN/UPDATE/INTO/TABLE, anche "a x, b y") e alias → tabella
function sqlReferences(text) {
  const tables = new Set(), aliases = new Map();
  const ID = '(`(?:[^`]|``)+`|[A-Za-z0-9_$]+)';
  const add = (name, alias) => {
    const tbl = unq(name);
    tables.add(tbl);
    if (alias && !NOT_ALIAS.has(alias.toUpperCase())) aliases.set(unq(alias).toLowerCase(), tbl);
  };
  const re = new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\\s+(?:${ID}\\s*\\.\\s*)?${ID}(?:\\s+(?:AS\\s+)?${ID})?((?:\\s*,\\s*(?:${ID}\\s*\\.\\s*)?${ID}(?:\\s+(?:AS\\s+)?${ID})?)*)`, 'gi');
  for (const m of text.matchAll(re)) {
    add(m[2], m[3]);
    for (const x of (m[4] || '').matchAll(new RegExp(`,\\s*(?:${ID}\\s*\\.\\s*)?${ID}(?:\\s+(?:AS\\s+)?${ID})?`, 'gi'))) add(x[2], x[3]);
  }
  return { tables, aliases };
}

// Popup dei suggerimenti sotto il cursore della textarea. source: { tables(), columns(table) → Promise }
function createAutocomplete({ input, container, esc, source }) {
  const box = document.createElement('div');
  box.className = 'db-ac';
  box.hidden = true;
  box.setAttribute('role', 'listbox');
  document.body.appendChild(box);
  let items = [], index = 0, range = null, seq = 0;

  // Posizione del cursore: copia nascosta della textarea con un segnaposto al posto del cursore
  function caretPoint() {
    const mirror = document.createElement('div');
    const cs = getComputedStyle(input);
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'border', 'boxSizing', 'whiteSpace', 'overflowWrap', 'wordBreak', 'tabSize', 'scrollbarGutter']) mirror.style[k] = cs[k];
    Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '0', width: input.offsetWidth + 'px', overflow: 'hidden' });
    mirror.textContent = input.value.slice(0, input.selectionStart);
    const mark = document.createElement('span');
    mark.textContent = '\u200b';
    mirror.appendChild(mark);
    container.appendChild(mirror);
    const r = input.getBoundingClientRect();
    const point = { x: r.left + mark.offsetLeft - input.scrollLeft, y: r.top + mark.offsetTop - input.scrollTop + mark.offsetHeight };
    mirror.remove();
    return point;
  }

  function close() { box.hidden = true; items = []; range = null; }

  function render() {
    if (!items.length) return close();
    box.innerHTML = items.map((it, i) => `<div class="db-ac-item ${i === index ? 'active' : ''}" data-i="${i}" role="option">
      <span class="db-ac-kind db-ac-${it.kind}">${esc(it.kind === 'column' ? 'col' : it.kind === 'table' ? 'tab' : it.kind === 'function' ? 'fn' : 'sql')}</span>
      <span class="db-ac-label">${esc(it.label)}</span>${it.detail ? `<span class="db-ac-detail">${esc(it.detail)}</span>` : ''}</div>`).join('');
    const p = caretPoint();
    box.hidden = false;
    const w = box.offsetWidth, h = box.offsetHeight;
    box.style.left = Math.max(4, Math.min(p.x, window.innerWidth - w - 8)) + 'px';
    box.style.top = (p.y + h + 4 > window.innerHeight ? p.y - h - 22 : p.y + 2) + 'px';
    box.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  // Suggerimenti per il testo prima del cursore
  async function update(force = false) {
    const pos = input.selectionStart;
    if (pos !== input.selectionEnd) return close();
    const before = input.value.slice(0, pos);
    const m = /(?:(`(?:[^`]|``)+`|[A-Za-z0-9_$]+)\.)?`?([A-Za-z0-9_$]*)$/.exec(before);
    const qualifier = m[1] ? unq(m[1]) : null;
    const prefix = m[2];
    if (!force && !qualifier && !prefix) return close();
    // niente suggerimenti dentro stringhe o commenti della riga
    const line = before.slice(before.lastIndexOf('\n') + 1);
    if (/--\s|#/.test(line) || (line.split("'").length - 1) % 2) return close();
    const mine = ++seq;
    const p = prefix.toLowerCase();
    const start = pos - prefix.length - (before.slice(0, pos - prefix.length).endsWith('`') ? 1 : 0);
    const refs = sqlReferences(input.value);
    let list = [];
    if (qualifier) {
      const table = refs.aliases.get(qualifier.toLowerCase()) || qualifier;
      list = (await source.columns(table)).filter(c => c.name.toLowerCase().startsWith(p))
        .map(c => ({ kind: 'column', label: c.name, detail: c.type, insert: quoteIfNeeded(c.name) }));
    } else {
      const cols = [];
      for (const table of refs.tables) for (const c of await source.columns(table)) cols.push({ ...c, table });
      const seen = new Set();
      const add = it => { const k = it.kind + it.label; if (!seen.has(k) && it.label.toLowerCase().startsWith(p)) { seen.add(k); list.push(it); } };
      cols.forEach(c => add({ kind: 'column', label: c.name, detail: `${c.table} · ${c.type}`, insert: quoteIfNeeded(c.name) }));
      for (const [alias, table] of refs.aliases) add({ kind: 'table', label: alias, detail: table, insert: alias });
      (await source.tables()).forEach(name => add({ kind: 'table', label: name, detail: '', insert: quoteIfNeeded(name) }));
      SQL_FUNCTIONS.forEach(f => add({ kind: 'function', label: f, detail: '', insert: f + '(' }));
      [...SQL_KEYWORDS].sort().forEach(k => add({ kind: 'keyword', label: k, detail: '', insert: k }));
    }
    if (mine !== seq) return; // nel frattempo l'utente ha scritto altro
    // la parola già scritta per intero non va riproposta da sola
    if (list.length === 1 && list[0].label.toLowerCase() === p && !force) list = [];
    items = list.slice(0, 40);
    index = 0;
    range = { start, end: pos };
    render();
  }

  function accept(i = index) {
    const it = items[i];
    if (!it || !range) return;
    input.setRangeText(it.insert, range.start, range.end, 'end');
    close();
    input.dispatchEvent(new Event('input'));
    input.focus();
  }

  // true se il tasto è stato usato dal popup
  function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === ' ') { e.preventDefault(); update(true); return true; }
    if (box.hidden) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      index = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
      return true;
    }
    if ((e.key === 'Enter' && !(e.ctrlKey || e.metaKey)) || e.key === 'Tab') { e.preventDefault(); accept(); return true; }
    if (e.key === 'Escape') { e.preventDefault(); close(); return true; }
    return false;
  }

  box.addEventListener('mousedown', e => {
    const el = e.target.closest('[data-i]');
    if (!el) return;
    e.preventDefault();
    accept(Number(el.dataset.i));
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('click', close);
  input.addEventListener('scroll', () => { if (!box.hidden) render(); });

  return { update, close, onKeyDown, element: box };
}

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal, fmt } = ctx.ui;
    const { t } = ctx;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);

    let vault = { state: 'uninitialized', minLength: 10 };
    let connections = [];
    let tunnelsAvailable = false;
    let treeFilter = '';
    let activeId = null;
    let folders = [];            // cartelle della sidebar (un livello)

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
      try { vault = await ctx.core.get('/vault'); } catch (e) { toast(e.message, 'error'); }
      render();
    }

    function render() {
      const unlocked = vault.state === 'unlocked';
      $(ctx.root, 'gate').hidden = unlocked;
      $(ctx.root, 'main').hidden = !unlocked;
      $(ctx.sidebar, 'vault-btn').hidden = !unlocked;
      $(ctx.sidebar, 'add-btn').hidden = !unlocked;
      $(ctx.sidebar, 'folder-btn').hidden = !unlocked;
      $(ctx.sidebar, 'import-btn').hidden = !unlocked;
      $(ctx.sidebar, 'tree-search').hidden = !unlocked;
      if (!unlocked) {
        $(ctx.sidebar, 'connections').innerHTML = `<p class="db-muted db-pad">${esc(t('sidebar.locked'))}</p>`;
        renderGate();
        return;
      }
      loadConnections();
    }

    // ---- connessioni ----
    async function loadConnections() {
      try {
        ({ connections, folders, tunnelsAvailable } = await ctx.api.get('/connections'));
      } catch (e) { toast(e.message, 'error'); return; }
      if (activeId && !active()) activeId = null;
      ctx.setBadge(connections.length || null);
      renderConnections();
      renderWorkspace();
    }

    // Progetti del core: per scegliere il progetto collegato
    async function projects() {
      try { return (await ctx.core.get('/projects')).projects; } catch { return []; }
    }

    // Cartelle chiuse, ricordate dal browser (localStorage può mancare o fallire)
    const CLOSED_FOLDERS_KEY = 'devdock.dbFolders.collapsed';
    function closedFolders() {
      try { return new Set(JSON.parse(localStorage.getItem(CLOSED_FOLDERS_KEY) || '[]')); } catch { return new Set(); }
    }
    function toggleFolder(id) {
      const closed = closedFolders();
      if (closed.has(id)) closed.delete(id); else closed.add(id);
      try { localStorage.setItem(CLOSED_FOLDERS_KEY, JSON.stringify([...closed])); } catch { /* solo per questa sessione */ }
      renderConnections();
    }

    // Albero: prima le cartelle con le loro connessioni, poi le connessioni senza cartella
    function renderConnections() {
      const el = $(ctx.sidebar, 'connections');
      if (!connections.length && !folders.length) {
        el.innerHTML = `<p class="db-muted db-pad">${esc(t('sidebar.none'))}<br><br><button class="btn btn-ghost btn-sm" data-tree="add">${esc(t('sidebar.addButton'))}</button></p>`;
        return;
      }
      const closed = closedFolders();
      const known = new Set(folders.map(f => f.id));
      const folderNode = f => {
        const list = connections.filter(c => c.folder === f.id);
        const isOpen = !closed.has(f.id);
        return `<div class="db-node">
          <div class="db-row db-row-folder" data-tree="folder" data-folder="${esc(f.id)}" title="${esc(t('folders.hint'))}">
            <span class="db-caret"><svg class="db-chevron ${isOpen ? 'open' : ''}" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.5 7 5 3.5 8.5" /></svg></span>
            <span class="db-row-icon">📁</span><span class="db-row-label">${esc(f.label)}</span>
            <span class="db-folder-count">${esc(fmt.number(list.length))}</span>
            <button class="db-folder-more" data-act="folder-menu" title="${esc(t('folders.actions'))}">⋯</button>
          </div>
          ${isOpen ? `<div class="db-children">${list.map(connNode).join('')}</div>` : ''}
        </div>`;
      };
      el.innerHTML = `<div class="db-tree" role="tree">${folders.map(folderNode).join('')}${
        connections.filter(c => !c.folder || !known.has(c.folder)).map(connNode).join('')}</div>`;
    }

    // ---- cartelle ----
    function folderMenu(e, id) {
      const r = e.target.closest('[data-act="folder-menu"]')?.getBoundingClientRect();
      ctx.ui.contextMenu(e.clientX || r?.left || 0, e.clientY || r?.bottom || 0, [
        { icon: '✎', label: t('folders.rename'), action: () => folderDialog(id) },
        { icon: '🗑', label: t('folders.delete'), danger: true, action: () => actions.deleteFolder(id) },
      ]);
    }
    // Nuova cartella (id assente) o rinomina
    function folderDialog(id) {
      const f = id ? folders.find(x => x.id === id) : null;
      if (id && !f) return;
      // testo JS non ancora escapato: l'escape per l'attributo lo fanno modalButtons ed esc()
      const save = `Ext['db-client'].saveFolder(${JSON.stringify(id || '')})`;
      openModal(t(f ? 'folders.rename' : 'folders.new'), `
        <div class="form-row"><label>${esc(t('folders.name'))}</label>
          <input class="form-input" id="f_dbfolder_label" value="${esc(f?.label || '')}" placeholder="${esc(t('folders.placeholder'))}" onkeydown="if(event.key==='Enter')${esc(save)}"></div>`,
        modalButtons(t(f ? 'core.action.save' : 'core.action.add'), save));
      document.getElementById('f_dbfolder_label')?.focus();
    }

    // Freccia del nodo: punta a destra se chiuso, in basso se aperto
    const caret = (key, leaf) => {
      if (leaf) return '<span class="db-caret"></span>';
      const isOpen = open.has(key);
      return `<span class="db-caret" data-act="toggle" title="${esc(t(isOpen ? 'tree.collapse' : 'tree.expand'))}">
        <svg class="db-chevron ${isOpen ? 'open' : ''}" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.5 7 5 3.5 8.5" /></svg></span>`;
    };
    const loading = entry => !entry || entry.loading ? `<div class="db-tree-msg">${esc(t('tree.loading'))}</div>`
      : entry.error ? `<div class="db-tree-msg db-tree-err">${esc(entry.error)}</div>` : '';
    const attrs = (kind, c, db, table) =>
      `data-tree="${kind}" data-conn="${esc(c.id)}"${db != null ? ` data-db="${esc(db)}"` : ''}${table != null ? ` data-table="${esc(table)}"` : ''}`;

    function connNode(c) {
      const k = nodeKey('c', c.id);
      const entry = cache.get(k);
      return `<div class="db-node">
        <div class="db-row db-row-conn ${c.id === activeId ? 'active' : ''}" ${attrs('conn', c)} title="${esc(target(c))}">
          ${caret(k)}<span class="db-row-icon">${c.readOnly ? '🔒' : '🗄️'}</span><span class="db-row-label">${esc(c.label)}</span>
          ${c.tunnelMissing ? `<span class="db-row-warn" title="${esc(t('conn.tunnelMissing', { tunnel: c.tunnel }))}">⚠</span>` : ''}
        </div>
        ${open.has(k) ? `<div class="db-children">${loading(entry) || [
          entry.defaultMissing ? `<div class="db-tree-msg db-tree-err">${esc(t('conn.dbMissing', { db: entry.default }))}</div>` : '',
          entry.map(db => dbNode(c, db)).join('') || `<div class="db-tree-msg">${esc(t('tree.noDatabases'))}</div>`,
        ].join('')}</div>` : ''}
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
        ${open.has(k) ? `<div class="db-children">${loading(entry) || tablesOf(entry).map(tb => tableNode(c, db, tb)).join('')
          || `<div class="db-tree-msg">${esc(t(entry.length ? 'tree.noMatch' : 'tree.noTables'))}</div>`}</div>` : ''}
      </div>`;
    }

    // Filtro delle tabelle (barra sopra l'albero): parte del nome, senza maiuscole/minuscole
    const tablesOf = list => {
      const f = treeFilter.trim().toLowerCase();
      return f ? list.filter(tb => tb.name.toLowerCase().includes(f)) : list;
    };

    function tableNode(c, db, tb) {
      const k = nodeKey('t', c.id, db, tb.name);
      const entry = cache.get(k);
      return `<div class="db-node">
        <div class="db-row db-row-table" ${attrs('table', c, db, tb.name)} title="${esc(tb.comment || tb.name)}${tb.rowsEstimate != null ? ` · ${esc(t('tree.rowsEstimate', { count: tb.rowsEstimate }))}` : ''}">
          ${caret(k)}<span class="db-row-icon">${tb.view ? '👁' : '▦'}</span><span class="db-row-label">${esc(tb.name)}</span>
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

    const loadDatabases = c => loadNode(nodeKey('c', c.id), `/connections/${encodeURIComponent(c.id)}/databases`,
      r => Object.assign(r.databases, { default: r.default, defaultMissing: r.defaultMissing }));

    // Dopo una modifica della connessione: via i nodi in cache (anche gli errori), poi si
    // ricaricano quelli aperti con i dati nuovi
    // Dopo una modifica di schema: tabelle e colonne di quel database rilette (anche i nodi
    // di tabelle aperte, che tornano chiusi se la tabella non c'è più); con database null
    // si rilegge l'elenco dei database (CREATE/DROP DATABASE)
    async function refreshDatabase(c, db) {
      if (!db) {
        cache.delete(nodeKey('c', c.id));
        if (open.has(nodeKey('c', c.id))) await loadDatabases(c);
        return;
      }
      for (const k of [...cache.keys()]) {
        const [kind, cid, kdb] = k.split('|');
        if (cid === c.id && kdb === db && (kind === 'd' || kind === 't')) cache.delete(k);
      }
      if (!open.has(nodeKey('d', c.id, db))) { renderConnections(); return; }
      await loadTables(c, db);
      const tables = new Set((cache.get(nodeKey('d', c.id, db)) || []).map?.(tb => tb.name) || []);
      for (const k of [...open]) {
        const [kind, cid, kdb, table] = k.split('|');
        if (kind !== 't' || cid !== c.id || kdb !== db) continue;
        if (tables.has(table)) loadColumns(c, db, table); else open.delete(k);
      }
      renderConnections();
    }

    function forgetConnection(id) {
      for (const k of [...cache.keys()]) if (k.split('|')[1] === id) cache.delete(k);
      const c = connections.find(x => x.id === id);
      if (!c) { for (const k of [...open]) if (k.split('|')[1] === id) open.delete(k); return; }
      for (const k of open) {
        const [kind, cid, db, table] = k.split('|');
        if (cid !== id) continue;
        if (kind === 'c') loadDatabases(c); else if (kind === 'd') loadTables(c, db); else loadColumns(c, db, table);
      }
    }
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
      $(ctx.root, 'active-db').innerHTML = db ? `🛢️ ${esc(db)}` : `<span class="db-muted">${esc(t('toolbar.noDb'))}</span>`;
    }

    // Testo nell'editor ed esecuzione (le modifiche passano comunque dalla conferma)
    function runSql(sql) {
      sqlInput.value = sql;
      sqlInput.dispatchEvent(new Event('input'));
      run();
    }

    // ---- anteprima dati (griglia paginata con ricerca, filtri e ordinamento) ----
    const FILTER_OPS = ['eq', 'ne', 'contains', 'starts', 'lt', 'gt', 'null', 'notnull'];
    const filterLabel = op => t(`filter.${op}`);
    let grid = null; // { connId, db, table, page, pageSize, search, filters, sort, data }

    function openGrid(c, db, table) {
      designer = null;
      grid = { connId: c.id, db, table, page: 1, pageSize: 50, search: '', filters: [], sort: null, data: null };
      loadGrid();
    }

    // Modifiche in sospeso di più celle (anche di righe diverse), salvate tutte insieme con
    // Invio o "Salva": valgono per i dati mostrati (griglia o risultato) a cui appartengono
    let edits = null; // { data, cells: Map("r|c" → valore) }
    const pendingOf = data => (edits && edits.data === data ? edits.cells : new Map());
    const pendingCount = data => pendingOf(data).size;
    function setPending(data, r, c, value, original) {
      if (!edits || edits.data !== data) edits = { data, cells: new Map() };
      const k = `${r}|${c}`;
      if (value === original || (value !== null && original !== null && String(value) === String(original))) edits.cells.delete(k);
      else edits.cells.set(k, value);
    }
    const clearEdits = data => { if (edits?.data === data) edits = null; };
    // Valore mostrato in una cella: quello modificato se c'è
    const shown = (data, r, c) => { const p = pendingOf(data); const k = `${r}|${c}`; return p.has(k) ? p.get(k) : data.rows[r][c]; };
    const editsBar = data => {
      const n = pendingCount(data);
      return n ? `<span class="db-edits-bar">${esc(t('edits.count', { count: n }))}
        <button class="btn btn-primary btn-sm" data-edits="save" title="${esc(t('edits.saveTitle'))}">${esc(t('edits.save'))}</button>
        <button class="btn btn-ghost btn-sm" data-edits="discard">${esc(t('edits.discard'))}</button></span>` : '';
    };

    async function loadGrid() {
      if (!grid) return;
      // cambio di pagina, filtro, ordinamento… con modifiche non salvate: si chiede prima
      if (grid.data && pendingCount(grid.data) && !confirm(t('edits.confirmDiscard', { count: pendingCount(grid.data) }))) {
        Object.assign(grid, grid.loaded || {});
        renderGrid();
        return;
      }
      if (grid.data) clearEdits(grid.data);
      const g = grid;
      g.selected = new Set(); // la selezione vale per la pagina mostrata
      const c = connections.find(x => x.id === g.connId);
      try {
        g.data = await ctx.api.post(tableUrl(c, g.db, g.table) + '/rows',
          { page: g.page, pageSize: g.pageSize, search: g.search, filters: g.filters, sort: g.sort });
        g.loaded = { page: g.page, pageSize: g.pageSize, search: g.search, filters: [...g.filters], sort: g.sort };
        if (grid === g) renderGrid();
      } catch (e) { if (grid === g) renderError(e.message); }
    }

    // Modifica possibile solo con chiave primaria e connessione scrivibile
    const gridEditable = () => grid?.data?.primaryKey.length > 0 && !connections.find(x => x.id === grid.connId)?.readOnly;
    const isAuto = col => /auto_increment/i.test(col.extra || '');
    // Valore cambiato? (i campi del form sono stringhe, i dati possono essere numeri o NULL)
    const changed = (next, prev) => next === null ? prev !== null : prev === null || next !== String(prev);
    // Colonne JSON: testo formattato per la modifica, confronto sul contenuto (non sugli spazi)
    const isJsonCol = col => /^json$/i.test(col?.dataType || '');
    const prettyJson = v => { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v ?? ''; } };
    const sameJson = (a, b) => { try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)); } catch { return a === b; } };
    const jsonChanged = (next, prev) => next === null || prev === null ? next !== prev : !sameJson(next, prev);
    const keyOf = row => Object.fromEntries(grid.data.primaryKey.map(k => [k, row[grid.data.columns.findIndex(c => c.name === k)]]));

    function renderGrid() {
      const { data, sort } = grid;
      const editable = gridEditable();
      const canInsert = !connections.find(x => x.id === grid.connId)?.readOnly;
      const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
      const el = $(ctx.root, 'results');
      const hadFocus = document.activeElement?.dataset?.grid === 'search';
      ctx.ui.patch(el, `
        <div class="db-grid-bar">
          <strong class="db-grid-title">${esc(grid.db)}.${esc(grid.table)}</strong>
          <input class="form-input db-grid-search" data-grid="search" placeholder="${esc(t('grid.search'))}" value="${esc(grid.search)}">
          <button class="btn btn-ghost btn-sm" data-grid="add-filter">${esc(t('grid.addFilter'))}</button>
          ${canInsert ? `<button class="btn btn-ghost btn-sm" data-grid="insert-dialog">${esc(t('grid.addRow'))}</button>` : ''}
          <button class="btn btn-ghost btn-sm" data-grid="export">${esc(t('grid.export'))}</button>
          ${editable ? `<button class="btn btn-danger btn-sm" data-grid="delete-selected" ${grid.selected.size ? '' : 'hidden'}>${esc(t('grid.deleteSelected', { count: grid.selected.size }))}</button>` : ''}
          ${editsBar(data)}
          ${!data.primaryKey.length ? `<span class="db-badge db-badge-warn" title="${esc(t('grid.noPkTitle'))}">${esc(t('grid.noPk'))}</span>` : ''}
          ${grid.filters.map((f, i) => `<span class="db-chip">${esc(f.column)} ${esc(filterLabel(f.op))}${f.op === 'null' || f.op === 'notnull' ? '' : ` <b>${esc(f.value)}</b>`}<button data-grid="remove-filter" data-i="${i}" title="${esc(t('grid.removeFilter'))}">✕</button></span>`).join('')}
          <div class="db-pager">
            <button class="btn btn-ghost btn-sm" data-grid="page" data-p="1" ${grid.page <= 1 ? 'disabled' : ''}>«</button>
            <button class="btn btn-ghost btn-sm" data-grid="page" data-p="${grid.page - 1}" ${grid.page <= 1 ? 'disabled' : ''}>‹</button>
            <span>${esc(t('grid.page', { page: grid.page, pages }))} · ${esc(t('grid.rows', { count: data.total }))}</span>
            <button class="btn btn-ghost btn-sm" data-grid="page" data-p="${grid.page + 1}" ${grid.page >= pages ? 'disabled' : ''}>›</button>
            <button class="btn btn-ghost btn-sm" data-grid="page" data-p="${pages}" ${grid.page >= pages ? 'disabled' : ''}>»</button>
            <select class="form-input db-select db-page-size" data-grid="page-size">${data.pageSizes.map(n => `<option ${n === data.pageSize ? 'selected' : ''}>${n}</option>`).join('')}</select>
          </div>
        </div>
        <div class="db-table-wrap"><table class="data-table db-table">
          <thead><tr>${editable ? `<th class="db-row-actions"><input type="checkbox" data-grid="select-all" title="${esc(t('grid.selectAll'))}" ${data.rows.length && grid.selected.size === data.rows.length ? 'checked' : ''}></th>` : ''}${data.columns.map(col => `<th data-grid="sort" data-col="${esc(col.name)}" title="${esc(col.type)}${col.key === 'PRI' ? ` · ${esc(t('grid.primaryKey'))}` : ''}">${col.key === 'PRI' ? '🔑 ' : ''}${esc(col.name)}${sort?.column === col.name ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead>
          <tbody>${data.rows.map((row, r) => `<tr data-r="${r}" class="${grid.selected.has(r) ? 'db-selected' : ''}">${editable ? `<td class="db-row-actions">
              <input type="checkbox" data-grid="select" data-r="${r}" ${grid.selected.has(r) ? 'checked' : ''}><button data-grid="edit-dialog" data-r="${r}" title="${esc(t('grid.edit'))}">✏️</button><button data-grid="delete-row" data-r="${r}" title="${esc(t('grid.delete'))}">🗑</button></td>` : ''}${row.map((_, c) => {
              const v = shown(data, r, c), dirty = pendingOf(data).has(`${r}|${c}`);
              return `<td data-c="${c}" class="${v === null ? 'db-null' : ''}${editable ? ' db-editable' : ''}${dirty ? ' db-dirty' : ''}" title="${esc(dirty ? t('edits.was', { value: data.rows[r][c] ?? 'NULL' }) : v ?? 'NULL')}">${v === null ? 'NULL' : esc(v)}</td>`;
            }).join('')}</tr>`).join('')
            || `<tr><td class="db-muted" colspan="${data.columns.length + (editable ? 1 : 0)}">${esc(t('grid.noRows'))}</td></tr>`}
            ${canInsert ? `<tr class="db-new-row">${editable ? `<td class="db-row-actions"><button data-grid="insert-inline" title="${esc(t('grid.insertTitle'))}">＋</button></td>` : ''}${data.columns.map(col =>
              `<td><input class="db-cell-input" data-new="${esc(col.name)}" placeholder="${isAuto(col) ? esc(t('grid.auto')) : esc(col.default ?? (col.nullable ? 'NULL' : ''))}"></td>`).join('')}
              ${editable ? '' : `<td><button class="btn btn-ghost btn-sm" data-grid="insert-inline">${esc(t('grid.insert'))}</button></td>`}</tr>` : ''}</tbody>
        </table></div>`);
      if (hadFocus) { const i = el.querySelector('[data-grid="search"]'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
    }

    // ---- designer delle tabelle: creazione e modifica (SQL generato e confermato dal server) ----
    // mode 'create': nuova tabella · mode 'alter': tabella esistente, le colonne ricordano
    // il nome originale (_orig) per le rinomine; le operazioni le calcola il server
    let designer = null; // { connId, db, mode, table, def }
    let ddlInfo = null;
    const newColumn = (over = {}) => ({ name: '', type: 'VARCHAR', length: 255, nullable: true, default: { kind: 'none' }, ...over });

    async function openDesigner(c, db, table = null) {
      if (c.readOnly) { toast(t('designer.readOnly'), 'error'); return; }
      if (!db) { toast(t('designer.chooseDb'), 'error'); return; }
      try { ddlInfo = ddlInfo || (await ctx.api.get('/info')).ddl; } catch (e) { toast(e.message, 'error'); return; }
      grid = null;
      if (!table) {
        designer = {
          connId: c.id, db, mode: 'create', table: null,
          def: { name: '', engine: 'InnoDB', charset: 'utf8mb4', comment: '',
                 columns: [newColumn({ name: 'id', type: 'INT', length: '', unsigned: true, nullable: false, autoIncrement: true, pk: true })],
                 indexes: [], foreignKeys: [] },
        };
        renderDesigner();
        return;
      }
      $(ctx.root, 'results').innerHTML = `<div class="db-muted db-pad">${esc(t('structure.loading'))}</div>`;
      try {
        const { definition } = await ctx.api.get(`${tableUrl(c, db, table)}/definition`);
        const pk = new Set(definition.primaryKey || []);
        designer = {
          connId: c.id, db, mode: 'alter', table,
          def: {
            name: table, engine: definition.engine || '', comment: definition.comment || '',
            columns: definition.columns.map(col => ({ ...col, length: col.length ?? '', _orig: col.name, pk: pk.has(col.name) })),
            indexes: (definition.indexes || []).map(i => ({ ...i })),
            foreignKeys: (definition.foreignKeys || []).map(f => ({ ...f })),
          },
        };
        renderDesigner();
      } catch (e) { renderError(e.message); }
    }

    const sel = (name, options, value, attrs = '') =>
      `<select class="form-input db-dz" data-dz="${name}" ${attrs}>${options.map(o => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    const txt = (name, value, attrs = '') => `<input class="form-input db-dz" data-dz="${name}" value="${esc(value ?? '')}" ${attrs}>`;
    const chk = (name, value) => `<input type="checkbox" data-dz="${name}" ${value ? 'checked' : ''}>`;
    const TEMPORAL = new Set(['DATETIME', 'TIMESTAMP']);

    function columnRow(c, i, count) {
      // tipo non gestito dal designer (es. GEOMETRY): la colonna resta com'è
      if (c.unsupported) {
        return `<tr data-col="${i}" class="db-dz-locked"><td>${esc(c.name)}</td><td colspan="11"><code>${esc(c.unsupported)}</code> · ${esc(t('designer.unsupported'))}</td>
          <td>${moveButtons(i, count)}</td></tr>`;
      }
      return `<tr data-col="${i}">
        <td>${txt('name', c.name, `placeholder="${esc(t('designer.columnPlaceholder'))}"`)}${c._orig && c._orig !== c.name ? `<div class="db-muted db-dz-was">${esc(t('designer.was', { name: c._orig }))}</div>` : ''}</td>
        <td>${sel('type', ddlInfo.types, c.type)}</td>
        <td>${txt('length', c.length, 'style="width:70px"')}</td>
        <td>${c.type === 'DECIMAL' ? txt('scale', c.scale ?? 0, 'style="width:50px"') : ''}</td>
        <td>${['ENUM', 'SET'].includes(c.type) ? txt('values', (c.values || []).join(','), 'placeholder="a,b,c"') : ''}</td>
        <td>${chk('unsigned', c.unsigned)}</td>
        <td>${chk('nullable', c.nullable)}</td>
        <td class="db-dz-default">${sel('defaultKind', ['none', 'null', 'value', 'current_timestamp'], c.default?.kind || 'none')}${c.default?.kind === 'value' ? txt('defaultValue', c.default.value, 'style="width:90px"') : ''}</td>
        <td>${TEMPORAL.has(c.type) ? chk('onUpdateCurrentTimestamp', c.onUpdateCurrentTimestamp) : ''}</td>
        <td>${chk('autoIncrement', c.autoIncrement)}</td>
        <td>${chk('pk', c.pk)}</td>
        <td>${txt('comment', c.comment)}</td>
        <td class="db-dz-row-actions">${moveButtons(i, count)}<button class="btn btn-ghost btn-sm" data-dz-act="del-col" title="${esc(t('designer.remove'))}">✕</button></td>
      </tr>`;
    }
    const moveButtons = (i, count) =>
      `<button class="btn btn-ghost btn-sm" data-dz-act="up" ${i ? '' : 'disabled'} title="${esc(t('designer.moveUp'))}">↑</button><button class="btn btn-ghost btn-sm" data-dz-act="down" ${i < count - 1 ? '' : 'disabled'} title="${esc(t('designer.moveDown'))}">↓</button>`;

    function renderDesigner() {
      if (!designer) return;
      const { def, db, mode } = designer;
      const colNames = def.columns.map(c => c.name).filter(Boolean);
      const tables = (cache.get(nodeKey('d', designer.connId, db)) || []).map?.(tb => tb.name) || [];
      const conn = connections.find(x => x.id === designer.connId);
      const linked = migStatus.get(conn?.id)?.linked;
      ctx.ui.patch($(ctx.root, 'results'), `
        <div class="db-designer">
          <div class="db-designer-head">
            <strong>${esc(mode === 'alter' ? t('designer.editTitle', { table: `${db}.${designer.table}` }) : t('designer.title', { db }))}</strong>
            ${txt('name', def.name, `placeholder="${esc(t('designer.tableName'))}" data-scope="table"`)}
            ${sel('engine', ['', ...ddlInfo.engines].filter((e, i) => e || mode === 'alter' && !def.engine || i), def.engine, 'data-scope="table"')}
            ${mode === 'create' ? txt('charset', def.charset, `placeholder="${esc(t('designer.charset'))}" data-scope="table" style="width:100px"`) : ''}
            ${txt('comment', def.comment, `placeholder="${esc(t('designer.comment'))}" data-scope="table"`)}
          </div>
          <p class="db-muted">${esc(t(linked ? 'designer.linkedHint' : 'designer.notLinkedHint'))}</p>
          <h4>${esc(t('designer.columns'))} <button class="btn btn-ghost btn-sm" data-dz-act="add-col">${esc(t('designer.addColumn'))}</button></h4>
          <table class="data-table db-dz-table"><thead><tr>${['name', 'type', 'length', 'scale', 'values', 'unsigned', 'null', 'default', 'onUpdate', 'ai', 'pk', 'comment'].map(k => `<th>${esc(t(`designer.col.${k}`))}</th>`).join('')}<th></th></tr></thead>
          <tbody>${def.columns.map((c, i) => columnRow(c, i, def.columns.length)).join('')}</tbody></table>
          <h4>${esc(t('designer.indexes'))} <button class="btn btn-ghost btn-sm" data-dz-act="add-index">${esc(t('designer.addIndex'))}</button></h4>
          ${def.indexes.map((ix, i) => `<div class="db-dz-line" data-index="${i}">
            ${txt('name', ix.name, `placeholder="${esc(t('designer.indexName'))}"`)}
            ${txt('columns', ix.columns.join(','), `placeholder="${esc(t('designer.indexColumns', { columns: colNames.join(',') }))}"`)}
            <label class="db-check">${chk('unique', ix.unique)} ${esc(t('designer.unique'))}</label>
            <button class="btn btn-ghost btn-sm" data-dz-act="del-index">✕</button></div>`).join('') || `<p class="db-muted db-pad">${esc(t('designer.noIndexes'))}</p>`}
          <h4>${esc(t('designer.foreignKeys'))} <button class="btn btn-ghost btn-sm" data-dz-act="add-fk">${esc(t('designer.addFk'))}</button></h4>
          ${def.foreignKeys.map((fk, i) => `<div class="db-dz-line" data-fk="${i}">
            ${txt('name', fk.name, `placeholder="${esc(t('designer.fkName'))}" style="width:120px"`)}
            ${txt('columns', fk.columns.join(','), `placeholder="${esc(t('designer.fkColumns'))}"`)} →
            ${tables.length ? sel('refTable', ['', ...tables], fk.refTable) : txt('refTable', fk.refTable, `placeholder="${esc(t('designer.fkTable'))}"`)}
            ${txt('refColumns', fk.refColumns.join(','), `placeholder="${esc(t('designer.fkRefColumns'))}"`)}
            ON DELETE ${sel('onDelete', ['', ...ddlInfo.fkActions], fk.onDelete || '')}
            ON UPDATE ${sel('onUpdate', ['', ...ddlInfo.fkActions], fk.onUpdate || '')}
            <button class="btn btn-ghost btn-sm" data-dz-act="del-fk">✕</button></div>`).join('') || `<p class="db-muted db-pad">${esc(t('designer.noFks'))}</p>`}
          <div class="db-dz-actions">
            <button class="btn btn-primary btn-sm" data-dz-act="apply">${esc(t(mode === 'alter' ? 'designer.applyAlter' : 'designer.create'))}</button>
            <button class="btn btn-ghost btn-sm" data-dz-act="cancel">${esc(t('core.action.cancel'))}</button>
          </div>
        </div>`);
    }

    // Aggiorna la definizione dal campo modificato
    function designerInput(el) {
      const { def } = designer;
      const field = el.dataset.dz;
      const value = el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.scope === 'table') { def[field] = value; return false; }
      const colRow = el.closest('[data-col]'), ixRow = el.closest('[data-index]'), fkRow = el.closest('[data-fk]');
      const list = v => String(v).split(',').map(x => x.trim()).filter(Boolean);
      if (colRow) {
        const c = def.columns[Number(colRow.dataset.col)];
        if (field === 'defaultKind') { c.default = { kind: value, value: c.default?.value ?? '' }; return true; }
        if (field === 'defaultValue') { c.default.value = value; return false; }
        if (field === 'values') { c.values = list(value); return false; }
        c[field] = value;
        return field === 'type' || field === 'name'; // celle disponibili e "era: …"
      }
      if (ixRow) { const ix = def.indexes[Number(ixRow.dataset.index)]; ix[field] = field === 'columns' ? list(value) : value; }
      if (fkRow) { const fk = def.foreignKeys[Number(fkRow.dataset.fk)]; fk[field] = ['columns', 'refColumns'].includes(field) ? list(value) : value; }
      return false;
    }

    // Definizione da inviare: chiave primaria dalle caselle PK, campi vuoti tolti;
    // renames { nuovo nome: nome originale } per le colonne rinominate
    function designerDefinition() {
      const d = designer.def;
      const num = v => v === '' || v == null ? undefined : Number(v);
      const renames = {};
      const columns = d.columns.map(c => {
        if (c.unsupported) return { ...c, _orig: undefined, pk: undefined };
        const name = c.name.trim();
        if (c._orig && c._orig !== name) renames[name] = c._orig;
        return {
          name, type: c.type, length: num(c.length), scale: num(c.scale), values: c.values,
          unsigned: !!c.unsigned, nullable: !!c.nullable, autoIncrement: !!c.autoIncrement,
          onUpdateCurrentTimestamp: TEMPORAL.has(c.type) && !!c.onUpdateCurrentTimestamp || undefined,
          default: c.default, comment: c.comment || undefined,
        };
      });
      return {
        renames,
        definition: {
          name: d.name.trim(), engine: d.engine || undefined, charset: d.charset?.trim() || undefined, comment: d.comment || undefined,
          columns,
          primaryKey: d.columns.filter(c => c.pk).map(c => c.name.trim()),
          indexes: d.indexes.filter(i => i.columns.length),
          foreignKeys: d.foreignKeys.filter(f => f.columns.length).map(f => ({ ...f, name: f.name || undefined, onDelete: f.onDelete || undefined, onUpdate: f.onUpdate || undefined })),
        },
      };
    }

    function designerApply() {
      const c = connections.find(x => x.id === designer.connId);
      const { db, mode, table } = designer;
      const { definition, renames } = designerDefinition();
      const body = mode === 'create'
        ? { operations: [{ op: 'create_table', table: definition.name, definition }] }
        : { design: { table, definition, renames, newName: definition.name } };
      migrateFlow(c, db, body, async result => {
        const name = definition.name || table;
        designer = null;
        open.add(nodeKey('d', c.id, db));
        await refreshDatabase(c, db);
        showStructure(c, db, name);
      });
    }

    $(ctx.root, 'results').addEventListener('change', e => {
      if (designer && e.target.dataset.dz && designerInput(e.target)) renderDesigner();
    });
    $(ctx.root, 'results').addEventListener('input', e => {
      if (designer && e.target.dataset.dz && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') designerInput(e.target);
    });
    $(ctx.root, 'results').addEventListener('click', e => {
      const a = e.target.closest('[data-dz-act]')?.dataset.dzAct;
      if (!a || !designer) return;
      const d = designer.def;
      const row = () => Number(e.target.closest('[data-col]').dataset.col);
      if (a === 'add-col') d.columns.push(newColumn());
      else if (a === 'del-col') d.columns.splice(row(), 1);
      else if (a === 'up' || a === 'down') {
        const i = row(), j = a === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= d.columns.length) return;
        [d.columns[i], d.columns[j]] = [d.columns[j], d.columns[i]];
      }
      else if (a === 'add-index') d.indexes.push({ name: '', columns: [], unique: false });
      else if (a === 'del-index') d.indexes.splice(Number(e.target.closest('[data-index]').dataset.index), 1);
      else if (a === 'add-fk') d.foreignKeys.push({ name: '', columns: [], refTable: '', refColumns: [], onDelete: '', onUpdate: '' });
      else if (a === 'del-fk') d.foreignKeys.splice(Number(e.target.closest('[data-fk]').dataset.fk), 1);
      else if (a === 'apply') return designerApply();
      else if (a === 'cancel') { designer = null; $(ctx.root, 'results').innerHTML = ''; return; }
      renderDesigner();
    });

    // ---- applicazione delle modifiche di schema: anteprima SQL + file di migration ----
    // body: { operations } o { design }. onDone(result) dopo l'applicazione riuscita.
    let pendingMigrate = null;
    const fileSlug = v => String(v ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

    const migrateDoneText = r => r.ran === false ? t('migrate.savedOnly', { file: r.file })
      : r.file ? t('migrate.doneFile', { file: r.file }) : t('migrate.done');

    async function migrateFlow(c, db, body, onDone) {
      const url = `/connections/${encodeURIComponent(c.id)}/databases/${encodeURIComponent(db)}/migrate`;
      try {
        const res = await fetch(ctx.api.url(url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (res.status !== 428) { toast(ctx.ui.errorText(data, `HTTP ${res.status}`), 'error'); return; }
        pendingMigrate = { c, db, url, body, data, onDone };
        renderMigrateModal();
      } catch (e) { toast(e.message, 'error'); }
    }

    function migrateFileName() {
      const p = pendingMigrate;
      const prefix = /^\d+/.exec(p.data.migration?.file || '')?.[0] || '';
      const table = fileSlug(document.getElementById('f_mg_table')?.value ?? p.data.proposal.table);
      const op = fileSlug(document.getElementById('f_mg_op')?.value ?? p.data.proposal.operation);
      return `${prefix}_${table || '…'}_${op || '…'}.sql`;
    }

    function renderMigrateModal() {
      const { data, c, db } = pendingMigrate;
      const m = data.migration;
      const warnings = data.warnings || [];
      const fileBlock = m ? `
          <div class="db-mg-name">
            <label class="db-check"><input type="checkbox" id="f_mg_save" checked onchange="Ext['db-client'].migRefresh()"> ${esc(t('migrate.save', { dir: `${m.repo}/${m.dir}` }))}</label>
            <div class="db-mg-fields">
              <span class="db-mono">${esc(/^\d+/.exec(m.file)?.[0] || '')}_</span>
              <input class="form-input" id="f_mg_table" value="${esc(data.proposal.table)}" oninput="Ext['db-client'].migRefresh()" title="${esc(t('migrate.tableField'))}">
              <span class="db-mono">_</span>
              <input class="form-input" id="f_mg_op" value="${esc(data.proposal.operation)}" oninput="Ext['db-client'].migRefresh()" title="${esc(t('migrate.operationField'))}">
              <span class="db-mono">.sql</span>
            </div>
          </div>
          <div class="db-mg-file-name db-mono" data-role="mg-file">${esc(m.file)}</div>
          <pre class="db-confirm-sql" data-role="mg-content">${highlightSql(m.content, esc)}</pre>`
        : `<p class="db-muted">${esc(t('migrate.notLinked'))}</p>`;
      openModal(t('migrate.title', { connection: c.label, db }), `
        <div class="db-mg">
          <div class="db-mg-col">
            <h4>${esc(t('migrate.sqlTitle'))}</h4>
            <pre class="db-confirm-sql">${highlightSql(data.sql, esc)}</pre>
          </div>
          <div class="db-mg-col">
            <h4>${esc(t('migrate.fileTitle'))}</h4>
            ${fileBlock}
          </div>
        </div>
        ${warnings.length ? `<div class="db-mg-warnings">
          <strong>⚠ ${esc(t('migrate.warningsTitle'))}</strong>
          <ul>${warnings.map(w => `<li>${esc(t(`migrate.warn.${w.key}`, w.params))}</li>`).join('')}</ul>
          <label class="db-check"><input type="checkbox" id="f_mg_ack" onchange="Ext['db-client'].migRefresh()"> ${esc(t('migrate.acknowledge'))}</label>
        </div>` : ''}`,
        `<button class="btn btn-ghost" onclick="UI.closeModal();Ext['db-client'].migCancel()">${esc(t('core.action.cancel'))}</button>
         ${m ? `<button class="btn btn-ghost" data-role="mg-save-only" onclick="Ext['db-client'].migApply(false)" title="${esc(t('migrate.saveOnlyTitle'))}">${esc(t('migrate.saveOnly'))}</button>` : ''}
         <button class="btn ${warnings.length ? 'btn-danger' : 'btn-primary'}" data-role="mg-apply" onclick="Ext['db-client'].migApply()" ${warnings.length ? 'disabled' : ''}>${esc(t('migrate.apply'))}</button>`);
      document.getElementById('modal')?.classList.add('modal-wide');
    }

    // Nome del file e pulsante aggiornati mentre si scrive
    function migRefresh() {
      const p = pendingMigrate;
      if (!p) return;
      const save = document.getElementById('f_mg_save');
      const fileEl = document.querySelector('[data-role="mg-file"]');
      if (fileEl) { fileEl.textContent = migrateFileName(); fileEl.classList.toggle('db-mg-off', save && !save.checked); }
      document.querySelector('[data-role="mg-content"]')?.classList.toggle('db-mg-off', save && !save.checked);
      const ack = document.getElementById('f_mg_ack');
      const btn = document.querySelector('[data-role="mg-apply"]');
      if (btn) btn.disabled = !!ack && !ack.checked;
      // solo il file: serve la casella "Salva come migration"; gli avvisi non contano (il DB non cambia)
      const saveOnly = document.querySelector('[data-role="mg-save-only"]');
      if (saveOnly) saveOnly.disabled = !!save && !save.checked;
    }

    // run false: scrive solo il file di migration, senza eseguire le istruzioni sul DB
    async function migApply(run = true) {
      const p = pendingMigrate;
      if (!p) return;
      const save = document.getElementById('f_mg_save');
      const migration = p.data.migration ? {
        save: !!save?.checked, run,
        table: fileSlug(document.getElementById('f_mg_table')?.value),
        operation: fileSlug(document.getElementById('f_mg_op')?.value),
      } : { save: false };
      const body = { ...p.body, migration, confirm: p.data.token, acknowledgeWarnings: !!document.getElementById('f_mg_ack')?.checked };
      closeModal();
      try {
        const res = await fetch(ctx.api.url(p.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (res.status === 428) { // lo schema è cambiato nel frattempo: nuova anteprima
          toast(t('migrate.changed'), 'info');
          pendingMigrate = { ...p, data };
          renderMigrateModal();
          return;
        }
        if (!res.ok) {
          const done = data.executed?.length ? ` ${t('migrate.partial', { count: data.executed.length, file: data.file || '—' })}` : '';
          toast(ctx.ui.errorText(data, `HTTP ${res.status}`) + done, 'error');
          return;
        }
        pendingMigrate = null;
        toast(migrateDoneText(data), 'success');
        loadMigStatus(p.c);
        await p.onDone?.(data);
      } catch (e) { toast(e.message, 'error'); }
    }

    // ---- export (il server genera il file in streaming; qui si avvia solo il download) ----
    async function startExport(c, format, source) {
      try {
        const r = await ctx.api.post(`/connections/${encodeURIComponent(c.id)}/exports`, { format, source });
        window.location.href = ctx.api.url(`/connections/${encodeURIComponent(c.id)}/exports/${encodeURIComponent(r.id)}`);
        toast(t('export.done', { format: format.toUpperCase(), file: r.filename }), 'success');
      } catch (e) { toast(e.message, 'error'); }
    }

    const formats = () => [['csv', 'CSV'], ['json', 'JSON'], ['sql', t('export.sqlLabel')]];
    function exportMenu(anchor, items) {
      const r = anchor.getBoundingClientRect();
      ctx.ui.contextMenu(r.left, r.bottom + 4, items);
    }

    function exportTableMenu(anchor, c, db, table, withFilters) {
      const filtered = withFilters && (grid.search || grid.filters.length);
      const src = all => ({ type: 'table', db, table, ...(all ? {} : { search: grid.search, filters: grid.filters, sort: grid.sort }) });
      exportMenu(anchor, [
        ...formats().map(([f, label]) => ({ icon: '⤓', label: filtered ? t('export.filtered', { format: label }) : label, action: () => startExport(c, f, src(!withFilters)) })),
        ...(filtered ? ['separator', ...formats().map(([f, label]) => ({ icon: '⤓', label: t('export.whole', { format: label }), action: () => startExport(c, f, src(true)) }))] : []),
      ]);
    }

    function exportQuery(anchor) {
      const c = active();
      const sql = statement();
      if (!c || !sql) { toast(t('export.needSelect'), 'error'); return; }
      exportMenu(anchor, formats().map(([f, label]) => ({
        icon: '⤓', label, action: () => startExport(c, f, { type: 'query', sql, database: activeDb.get(c.id) || null }),
      })));
    }

    // ---- scrittura delle righe: sempre tramite conferma dell'SQL generato ----
    // target: { c, db, table, onSaved } — di default la tabella aperta nell'anteprima dati
    async function saveRow(op, key, values, keys, target = null) {
      const { c, db, table, onSaved, changes } = target || { c: connections.find(x => x.id === grid.connId), db: grid.db, table: grid.table, onSaved: loadGrid };
      const url = tableUrl(c, db, table) + '/row';
      const payload = { op, key, values, keys, changes };
      const send = async confirm => {
        try {
          const r = await ctx.api.post(url, { ...payload, ...(confirm ? { confirm } : {}) });
          const label = op === 'delete-many' ? t('row.deletedMany', { count: r.affectedRows })
            : op === 'update-many' ? t('row.updatedMany', { count: r.affectedRows })
            : t({ insert: 'row.inserted', update: 'row.updated', delete: 'row.deleted' }[op]);
          toast(r.affectedRows ? `${label}${r.insertId ? ` ${t('row.insertId', { id: String(r.insertId) })}` : ''}` : t('row.unchanged'), r.affectedRows ? 'success' : 'info');
          onSaved?.(r);
        } catch (e) { toast(e.message, 'error'); }
      };
      try {
        const res = await fetch(ctx.api.url(url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json().catch(() => ({}));
        if (res.status === 428 && data.needsConfirmation) askConfirmation(data, send, true);
        else toast(ctx.ui.errorText(data, `HTTP ${res.status}`), 'error'); // le scritture chiedono sempre conferma
      } catch (e) { toast(e.message, 'error'); }
    }

    // Campo di modifica in una cella. onDone(mode, value): mode 'keep' (resta in sospeso),
    // 'save' (Invio: salva tutte le modifiche), 'next'/'prev' (Tab), 'cancel' (Esc)
    function cellInput(td, value, nullable, onDone) {
      td.innerHTML = `<div class="db-cell-edit"><input class="db-cell-input" value="${esc(value ?? '')}" placeholder="${value === null ? 'NULL' : ''}">
        ${nullable ? `<button title="${esc(t('grid.setNull'))}" data-null>NULL</button>` : ''}</div>`;
      const input = td.querySelector('input');
      input.focus();
      input.select();
      let done = false;
      const finish = (mode, setNull) => {
        if (done) return;
        done = true;
        // '' su un valore NULL resta NULL (campo lasciato vuoto)
        const next = setNull ? null : input.value === '' && value === null ? null : input.value;
        onDone(mode, next);
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); finish('save'); }
        else if (e.key === 'Escape') finish('cancel');
        else if (e.key === 'Tab') { e.preventDefault(); finish(e.shiftKey ? 'prev' : 'next'); }
      });
      input.addEventListener('blur', () => setTimeout(() => finish('keep'), 150));
      td.querySelector('[data-null]')?.addEventListener('mousedown', e => { e.preventDefault(); finish('keep', true); });
    }

    // Cella modificabile accanto (Tab / Maiusc+Tab) nella stessa tabella, anche su altre righe
    function neighbourCell(table, r, c, dir) {
      const cells = [...table.querySelectorAll('td.db-editable')];
      const i = cells.findIndex(td => Number(td.parentElement.dataset.r) === r && Number(td.dataset.c) === c);
      return i === -1 ? null : cells[i + dir] || null;
    }

    // Modifica in linea: doppio clic sulla cella
    function editCell(td) {
      if (!gridEditable() || td.querySelector('input')) return;
      const data = grid.data;
      const r = Number(td.parentElement.dataset.r), c = Number(td.dataset.c);
      const col = data.columns[c];
      if (isJsonCol(col)) return jsonDialog(r, c);
      cellInput(td, shown(data, r, c), col.nullable, (mode, next) => {
        if (grid?.data !== data) return;
        if (mode !== 'cancel') setPending(data, r, c, next, data.rows[r][c]);
        renderGrid();
        if (mode === 'save') return saveEdits(data);
        if (mode === 'next' || mode === 'prev') {
          const near = neighbourCell($(ctx.root, 'results').querySelector('.db-table'), r, c, mode === 'next' ? 1 : -1);
          if (near) editCell(near);
        }
      });
    }

    // Salvataggio di tutte le modifiche in sospeso: un UPDATE per riga, una sola conferma,
    // eseguiti dal server in un'unica transazione
    function saveEdits(data) {
      const cells = pendingOf(data);
      if (!cells.size) return;
      const byRow = new Map();
      for (const [k, v] of cells) {
        const [r, c] = k.split('|').map(Number);
        if (!byRow.has(r)) byRow.set(r, {});
        byRow.get(r)[c] = v;
      }
      const inGrid = grid?.data === data;
      const target = inGrid ? null : resultTarget(data);
      if (!inGrid && !target) return;
      const changes = [...byRow].map(([r, vals]) => ({
        key: inGrid ? keyOf(data.rows[r]) : Object.fromEntries(target.info.pk.map((pk, i) => [pk, data.rows[r][target.pkIdx[i]]])),
        values: Object.fromEntries(Object.entries(vals).map(([c, v]) => [inGrid ? data.columns[c].name : target.colOf[c], v])),
      }));
      const c = inGrid ? connections.find(x => x.id === grid.connId) : target.c;
      const db = inGrid ? grid.db : target.db, table = inGrid ? grid.table : target.table;
      saveRow('update-many', null, null, null, {
        c, db, table, changes,
        onSaved: () => {
          if (inGrid) { clearEdits(data); loadGrid(); return; }
          for (const [k, v] of cells) { const [r, ci] = k.split('|').map(Number); data.rows[r][ci] = v; }
          clearEdits(data);
          if (lastResult === data) renderResult(data, true);
        },
      });
    }

    function discardEdits(data) {
      clearEdits(data);
      if (grid?.data === data) renderGrid(); else if (lastResult === data) renderResult(data, true);
    }

    // Finestra di un valore JSON: testo formattato, validato prima di salvare.
    // readOnly: solo lettura (risultati non modificabili); onSave(next) con il testo compatto o null
    let jsonEdit = null; // { value, onSave }
    function jsonDialog(r, c) {
      const col = grid.data.columns[c];
      const data = grid.data;
      openJsonEditor({ title: col.name, value: shown(data, r, c), nullable: col.nullable, apply: true,
        onSave: next => { const orig = data.rows[r][c]; setPending(data, r, c, jsonChanged(next, orig) ? next : orig, orig); if (grid?.data === data) renderGrid(); } });
    }
    // apply: il valore resta tra le modifiche in sospeso (pulsante "Applica" invece di "Salva")
    function openJsonEditor({ title, value, nullable = false, readOnly = false, apply = false, onSave }) {
      jsonEdit = readOnly ? null : { value, onSave };
      openModal(t(readOnly ? 'json.viewTitle' : 'json.title', { column: title }), `
        <textarea class="form-input db-json-editor" id="f_json" spellcheck="false" ${readOnly ? 'readonly' : ''}>${esc(value === null ? '' : prettyJson(value))}</textarea>
        <div class="db-json-error" id="f_json_error"></div>`,
        readOnly
          ? `<button class="btn btn-primary" onclick="UI.closeModal()">${esc(t('core.action.close'))}</button>`
          : `${nullable ? `<button class="btn btn-ghost" style="margin-inline-end:auto" onclick="Ext['db-client'].saveJson(true)">${esc(t('json.setNull'))}</button>` : ''}
         <button class="btn btn-ghost" onclick="Ext['db-client'].formatJson()">${esc(t('json.format'))}</button>
         <button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" onclick="Ext['db-client'].saveJson(false)">${esc(t(apply ? 'json.apply' : 'core.action.save'))}</button>`);
      document.getElementById('modal').classList.add('modal-wide');
      setTimeout(() => document.getElementById('f_json')?.focus(), 0);
    }

    // Testo JSON valido in forma compatta, oppure l'errore mostrato nel dialog
    function readJson(id, errorId) {
      const text = document.getElementById(id).value;
      try { return { value: JSON.stringify(JSON.parse(text)) }; }
      catch (e) { const el = document.getElementById(errorId); if (el) el.textContent = t('json.invalid', { error: e.message }); return null; }
    }

    // Dialog con un campo per colonna (inserimento o modifica)
    const LONG_TYPES = /text|blob|json|geometry/i;
    function rowDialog(r) {
      const editing = r != null;
      const row = editing ? grid.data.rows[r] : null;
      const fields = grid.data.columns.map((col, c) => {
        const v = editing ? row[c] : null;
        const id = `f_row_${c}`;
        const input = isJsonCol(col)
          ? `<textarea class="form-input db-json-field" id="${id}" rows="6" spellcheck="false">${esc(v === null ? '' : prettyJson(v))}</textarea>`
          : LONG_TYPES.test(col.dataType)
          ? `<textarea class="form-input" id="${id}" rows="3">${esc(v ?? '')}</textarea>`
          : `<input class="form-input" id="${id}" value="${esc(v ?? '')}" placeholder="${!editing && isAuto(col) ? esc(t('row.autoPlaceholder')) : esc(col.type)}">`;
        return `<div class="form-row">
          <label>${col.key === 'PRI' ? '🔑 ' : ''}${esc(col.name)} <span class="db-muted">${esc(col.type)}</span></label>
          ${input}
          ${col.nullable ? `<label class="db-check"><input type="checkbox" id="${id}_null" ${editing && v === null ? 'checked' : ''}> NULL</label>` : ''}
        </div>`;
      }).join('');
      openModal(t(editing ? 'row.editTitle' : 'row.newTitle'), `<div class="db-row-form">${fields}</div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" onclick="Ext['db-client'].saveRowDialog(${editing ? r : 'null'})">${esc(editing ? t('core.action.save') : t('row.insert'))}</button>`);
    }

    function addFilter() {
      const cols = grid.data.columns;
      openModal(t('filterDialog.title'), `
        <div class="form-grid">
          <div class="form-row"><label>${esc(t('filterDialog.column'))}</label><select class="form-input" id="f_flt_col">${cols.map(c => `<option>${esc(c.name)}</option>`).join('')}</select></div>
          <div class="form-row"><label>${esc(t('filterDialog.condition'))}</label><select class="form-input" id="f_flt_op" onchange="document.getElementById('f_flt_val_row').hidden=['null','notnull'].includes(this.value)">
            ${FILTER_OPS.map(op => `<option value="${op}">${esc(filterLabel(op))}</option>`).join('')}</select></div>
        </div>
        <div class="form-row" id="f_flt_val_row"><label>${esc(t('filterDialog.value'))}</label><input class="form-input" id="f_flt_val"></div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button><button class="btn btn-primary" onclick="Ext['db-client'].applyFilter()">${esc(t('filterDialog.apply'))}</button>`);
    }

    let searchTimer = null;
    $(ctx.root, 'results').addEventListener('input', e => {
      if (e.target.dataset.grid !== 'search') return;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { grid.search = e.target.value; grid.page = 1; loadGrid(); }, 300);
    });
    $(ctx.root, 'results').addEventListener('click', e => {
      const ed = e.target.closest('[data-edits]')?.dataset.edits;
      if (ed) {
        const data = grid ? grid.data : lastResult;
        if (data) { if (ed === 'save') saveEdits(data); else discardEdits(data); }
        return;
      }
      const th = e.target.closest('[data-result-sort]');
      if (!th || !lastResult || grid || designer) return;
      const col = Number(th.dataset.resultSort);
      resultSort = resultSort?.col !== col ? { col, dir: 'asc' } : resultSort.dir === 'asc' ? { col, dir: 'desc' } : null;
      renderResult(lastResult, true);
    });
    $(ctx.root, 'results').addEventListener('dblclick', e => {
      if (grid) {
        const td = e.target.closest('td.db-editable');
        if (td) return editCell(td);
        // tabella senza chiave primaria: il JSON si guarda in sola lettura
        const cell = e.target.closest('td[data-c]');
        const col = cell && grid.data.columns[Number(cell.dataset.c)];
        const value = cell && grid.data.rows[Number(cell.parentElement.dataset.r)]?.[Number(cell.dataset.c)];
        if (col && isJsonCol(col) && value !== null && value !== undefined) openJsonEditor({ title: col.name, value, readOnly: true });
        return;
      }
      const td = e.target.closest('.db-result-table td[data-c]');
      if (td && lastResult && !designer) editResultCell(td);
    });
    $(ctx.root, 'results').addEventListener('change', e => {
      if (e.target.dataset.grid === 'page-size') { grid.pageSize = Number(e.target.value); grid.page = 1; loadGrid(); }
    });
    $(ctx.root, 'results').addEventListener('click', e => {
      const el = e.target.closest('[data-grid]');
      if (!el || !grid) return;
      const a = el.dataset.grid;
      if (a === 'page') { grid.page = Number(el.dataset.p); loadGrid(); }
      else if (a === 'sort') {
        const col = el.dataset.col;
        grid.sort = grid.sort?.column !== col ? { column: col, dir: 'asc' } : grid.sort.dir === 'asc' ? { column: col, dir: 'desc' } : null;
        grid.page = 1;
        loadGrid();
      } else if (a === 'add-filter') addFilter();
      else if (a === 'insert-dialog') rowDialog(null);
      else if (a === 'export') exportTableMenu(el, connections.find(x => x.id === grid.connId), grid.db, grid.table, true);
      else if (a === 'edit-dialog') rowDialog(Number(el.dataset.r));
      else if (a === 'delete-row') saveRow('delete', keyOf(grid.data.rows[Number(el.dataset.r)]));
      else if (a === 'select' || a === 'select-all') {
        if (a === 'select') { const r = Number(el.dataset.r); grid.selected.has(r) ? grid.selected.delete(r) : grid.selected.add(r); }
        else grid.selected = el.checked ? new Set(grid.data.rows.map((_, i) => i)) : new Set();
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
      else if (a === 'remove-filter') { grid.filters.splice(Number(el.dataset.i), 1); grid.page = 1; loadGrid(); }
    });

    function tableMenu(ev, c, db, name) {
      const tb = (cache.get(nodeKey('d', c.id, db)) || []).find?.(x => x.name === name);
      const full = `${quoteId(db)}.${quoteId(name)}`;
      const ro = c.readOnly;
      ctx.ui.contextMenu(ev.clientX, ev.clientY, [
        { icon: '▤', label: t('menu.openData'), action: () => openGrid(c, db, name) },
        { icon: '▶', label: t('menu.first100'), action: () => runSql(`SELECT * FROM ${full} LIMIT 100;`) },
        { icon: '#', label: t('menu.count'), action: () => runSql(`SELECT COUNT(*) AS ${quoteId(t('menu.countAlias'))} FROM ${full};`) },
        { icon: '▦', label: t('menu.structure'), action: () => showStructure(c, db, name) },
        ...(tb?.view ? [] : [{ icon: '✎', label: t('menu.alter'), disabled: ro, action: () => openDesigner(c, db, name) }]),
        ...formats().map(([f, label]) => ({ icon: '⤓', label: t('menu.export', { format: label }), action: () => startExport(c, f, { type: 'table', db, table: name }) })),
        { icon: '⌘', label: tb?.view ? 'SHOW CREATE VIEW' : 'SHOW CREATE TABLE', action: () => runSql(`SHOW CREATE ${tb?.view ? 'VIEW' : 'TABLE'} ${full};`) },
        'separator',
        { icon: '↳', label: t('menu.insertName'), action: () => {
          sqlInput.setRangeText(full, sqlInput.selectionStart, sqlInput.selectionEnd, 'end');
          sqlInput.dispatchEvent(new Event('input'));
          sqlInput.focus();
        } },
        { icon: '⧉', label: t('menu.copyName'), action: () => navigator.clipboard?.writeText(name).then(() => toast(t('menu.copied'))) },
        'separator',
        ...(tb?.view ? [] : [{ icon: '⌫', label: t('menu.truncate'), danger: true, disabled: ro, action: () => runSql(`TRUNCATE TABLE ${full};`) }]),
        { icon: '✕', label: t(tb?.view ? 'menu.dropView' : 'menu.dropTable'), danger: true, disabled: ro, action: () => runSql(`DROP ${tb?.view ? 'VIEW' : 'TABLE'} ${full};`) },
      ]);
    }

    async function showStructure(c, db, name) {
      grid = null;
      const el = $(ctx.root, 'results');
      el.innerHTML = `<div class="db-muted db-pad">${esc(t('structure.loading'))}</div>`;
      try {
        const info = await ctx.api.get(tableUrl(c, db, name));
        const table = (head, rows) => `<table class="data-table db-table"><thead><tr>${head.map(h => `<th>${esc(t(`structure.${h}`))}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
        const yesNo = v => esc(t(v ? 'structure.yes' : 'structure.no'));
        const none = `<p class="db-muted db-pad">${esc(t('structure.none'))}</p>`;
        el.innerHTML = `
          <div class="db-result-meta">${esc(t('structure.title', { name: `${db}.${name}` }))}</div>
          <div class="db-table-wrap db-structure">
            <h4>${esc(t('structure.columns'))}</h4>
            ${table(['name', 'type', 'null', 'key', 'default', 'extra', 'comment'], info.columns.map(col => `<tr>
              <td>${esc(col.name)}</td><td>${esc(col.type)}</td><td>${yesNo(col.nullable)}</td><td>${esc(col.key)}</td>
              <td>${col.default === null ? '<span class="db-null">NULL</span>' : esc(col.default)}</td><td>${esc(col.extra)}</td><td>${esc(col.comment)}</td></tr>`))}
            <h4>${esc(t('structure.indexes'))}</h4>
            ${info.indexes.length ? table(['name', 'indexColumns', 'unique'], info.indexes.map(i => `<tr><td>${esc(i.name)}</td><td>${esc(i.columns.join(', '))}</td><td>${yesNo(i.unique)}</td></tr>`)) : none}
            <h4>${esc(t('structure.foreignKeys'))}</h4>
            ${info.foreignKeys.length ? table(['name', 'indexColumns', 'reference'], info.foreignKeys.map(f => `<tr><td>${esc(f.name)}</td><td>${esc(f.columns.join(', '))}</td><td>${esc(f.refDatabase)}.${esc(f.refTable)} (${esc(f.refColumns.join(', '))})</td></tr>`)) : none}
          </div>`;
      } catch (e) { renderError(e.message); }
    }

    const target = c => c.tunnel ? t('conn.tunnel', { name: c.tunnel }) : `${c.host}:${c.port}`;

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
        ${c.readOnly ? `<span class="db-badge">${esc(t('conn.readOnly'))}</span>` : ''}
        ${c.hasPassword ? '' : `<span class="db-badge db-badge-warn">${esc(t('conn.noPassword'))}</span>`}
        ${c.tunnelMissing ? `<span class="db-badge db-badge-danger">${esc(t('conn.tunnelMissing', { tunnel: c.tunnel }))}</span>` : ''}
        <span class="db-mig-badge" data-role="mig-badge"></span>
        <div class="db-conn-actions">
          <button class="btn btn-ghost btn-sm" onclick="Ext['db-client'].migrationsDialog(${js(c.id)})" title="${esc(t('mig.buttonTitle'))}">${esc(t('mig.button'))}</button>
          <button class="btn btn-ghost btn-sm" onclick="Ext['db-client'].testConnection(${js(c.id)})">${esc(t('conn.test'))}</button>
          <button class="btn btn-ghost btn-sm" onclick="Ext['db-client'].editConnection(${js(c.id)})">${esc(t('conn.edit'))}</button>
          <button class="btn btn-ghost btn-sm db-danger" onclick="Ext['db-client'].deleteConnection(${js(c.id)})" title="${esc(t('core.action.delete'))}">🗑</button>
        </div>`;
      renderMigBadge();
    }

    // ---- migration: collegamento a repository e cartella, numerazione NNN_ ----
    const migStatus = new Map(); // id connessione → stato (GET /connections/:id/migrations)

    async function loadMigStatus(c) {
      try { migStatus.set(c.id, await ctx.api.get(`/connections/${encodeURIComponent(c.id)}/migrations`)); }
      catch (e) { migStatus.set(c.id, { linked: false, error: e.message }); }
      if (active()?.id === c.id) renderMigBadge();
    }

    function renderMigBadge() {
      const el = $(ctx.root, 'mig-badge');
      const c = active();
      if (!el || !c) return;
      const st = migStatus.get(c.id);
      if (!st) { el.innerHTML = ''; loadMigStatus(c); return; }
      if (!st.linked) { el.innerHTML = `<span class="db-muted">${esc(t('mig.notLinked'))}</span>`; return; }
      if (st.repo?.missing) { el.innerHTML = `<span class="db-badge db-badge-warn">${esc(t('mig.repoMissing', { repo: st.repo.id }))}</span>`; return; }
      el.innerHTML = `<span class="db-badge" title="${esc(`${st.repo.label} / ${st.dir || '.'}`)}">📁 ${esc(st.repo.label)}/${esc(st.dir || '.')} · ${esc(t('mig.next', { prefix: st.nextPrefix }))}</span>`;
    }

    // Stato del dialog: connessione, repository e cartella in esame
    let migDlg = null;

    async function migrationsDialog(connId) {
      const c = connections.find(x => x.id === connId);
      if (!c) return;
      let repos;
      try { repos = await ctx.api.get('/migrations/repos'); } catch (e) { toast(e.message, 'error'); return; }
      const st = migStatus.get(c.id) || await ctx.api.get(`/connections/${encodeURIComponent(c.id)}/migrations`).catch(() => ({ linked: false }));
      const linkedRepo = st.linked && repos.repos.some(r => r.id === st.repo?.id) ? st.repo.id : null;
      migDlg = { connId: c.id, linked: !!st.linked, repos, repo: linkedRepo || repos.repos[0]?.id || null, dir: linkedRepo ? st.dir : '', folders: null, scan: null };
      openModal(t('mig.title', { name: c.label }), '<div data-role="mig-dialog"></div>',
        `${st.linked ? `<button class="btn btn-ghost db-danger" onclick="Ext['db-client'].migUnlink()">${esc(t('mig.unlink'))}</button>` : ''}
         <button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" data-role="mig-link" onclick="Ext['db-client'].migLink()">${esc(t('mig.link'))}</button>`);
      await migLoad();
    }

    // Cartelle e numerazione della cartella corrente, poi il disegno del dialog
    async function migLoad() {
      const d = migDlg;
      if (!d) return;
      if (d.repo) {
        const base = `/migrations/repos/${encodeURIComponent(d.repo)}`;
        const q = `?dir=${encodeURIComponent(d.dir)}`;
        try {
          [d.folders, d.scan] = await Promise.all([ctx.api.get(`${base}/folders${q}`), ctx.api.get(`${base}/scan${q}`)]);
          d.error = null;
        } catch (e) { d.error = e.message; d.folders = null; d.scan = null; }
      }
      if (migDlg === d) renderMigDialog();
    }

    function renderMigDialog() {
      const d = migDlg;
      const el = document.querySelector('[data-role="mig-dialog"]');
      if (!el || !d) return;
      const linkBtn = document.querySelector('[data-role="mig-link"]');
      if (linkBtn) linkBtn.disabled = !d.repo || !d.folders;
      if (!d.repos.repos.length) {
        el.innerHTML = `<p class="db-muted">${esc(t(d.repos.source ? 'mig.noRepos' : 'mig.noReposExt'))}</p>`;
        return;
      }
      const parts = d.dir ? d.dir.split('/') : [];
      const crumbs = [`<button class="db-mig-crumb" onclick="Ext['db-client'].migNav('')">${esc(d.repos.repos.find(r => r.id === d.repo)?.label || d.repo)}</button>`,
        ...parts.map((p, i) => `<button class="db-mig-crumb" onclick="Ext['db-client'].migNav(${js(parts.slice(0, i + 1).join('/'))})">${esc(p)}</button>`)].join('<span class="db-muted">/</span>');
      const sc = d.scan;
      el.innerHTML = `
        <div class="form-row"><label>${esc(t('mig.repo'))}</label>
          <select class="form-input" onchange="Ext['db-client'].migRepo(this.value)">${d.repos.repos.map(r =>
            `<option value="${esc(r.id)}" ${r.id === d.repo ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select>
          ${d.repos.source === 'projects' ? `<p class="db-muted">${esc(t('mig.projectsFallback'))}</p>` : ''}</div>
        <div class="form-row"><label>${esc(t('mig.folder'))}</label>
          <div class="db-mig-crumbs">${crumbs}</div>
          <div class="db-mig-folders">
            ${d.dir ? `<button class="db-mig-folder" onclick="Ext['db-client'].migNav(${js(parts.slice(0, -1).join('/'))})">↑ ..</button>` : ''}
            ${d.error ? `<div class="db-error">${esc(d.error)}</div>` : ''}
            ${(d.folders?.folders || []).map(f => `<button class="db-mig-folder" onclick="Ext['db-client'].migNav(${js(d.dir ? `${d.dir}/${f}` : f)})">📁 ${esc(f)}</button>`).join('')
              || (d.error ? '' : `<span class="db-muted">${esc(t('mig.noSubfolders'))}</span>`)}
          </div>
          <div class="db-mig-new">
            <input class="form-input" id="f_mig_folder" placeholder="${esc(t('mig.newFolderPlaceholder'))}">
            <button class="btn btn-ghost btn-sm" onclick="Ext['db-client'].migNewFolder()">${esc(t('mig.newFolder'))}</button>
          </div>
        </div>
        ${sc ? `<div class="db-mig-scan">
          <div><strong>${esc(t('mig.selected', { dir: d.dir || '.' }))}</strong></div>
          <div>${esc(t('mig.found', { count: sc.files.length }))}${sc.files.length ? ` · ${esc(t('mig.last', { name: sc.files[sc.files.length - 1].name }))}` : ''}</div>
          <div>${esc(t('mig.nextFile', { prefix: sc.nextPrefix }))} <code>${esc(sc.nextPrefix)}_${esc(t('mig.example'))}.sql</code></div>
          ${sc.duplicates.length ? `<div class="db-mig-warn">⚠ ${esc(t('mig.duplicates', { numbers: sc.duplicates.map(n => String(n)).join(', ') }))}</div>` : ''}
          ${sc.ignored.length ? `<div class="db-muted">${esc(t('mig.ignored', { files: sc.ignored.join(', ') }))}</div>` : ''}
        </div>` : ''}`;
    }

    const migActions = {
      migrationsDialog,
      migRefresh: () => migRefresh(),
      migApply: run => migApply(run !== false),
      migCancel() { pendingMigrate = null; },
      migRepo(id) { migDlg.repo = id; migDlg.dir = ''; migLoad(); },
      migNav(dir) { migDlg.dir = dir; migLoad(); },
      async migNewFolder() {
        const name = (document.getElementById('f_mig_folder')?.value || '').trim();
        if (!name) return;
        try {
          const r = await ctx.api.post(`/migrations/repos/${encodeURIComponent(migDlg.repo)}/folders`, { parent: migDlg.dir, name });
          migDlg.dir = r.dir;
          await migLoad();
        } catch (e) { toast(e.message, 'error'); }
      },
      async migLink() {
        const d = migDlg;
        try {
          await ctx.api.put(`/connections/${encodeURIComponent(d.connId)}/migrations`, { repo: d.repo, dir: d.dir });
          closeModal();
          migDlg = null;
          toast(t('mig.linked', { dir: d.dir || '.' }), 'success');
          await loadConnections();
          loadMigStatus(connections.find(x => x.id === d.connId));
        } catch (e) { toast(e.message, 'error'); }
      },
      async migUnlink() {
        const d = migDlg;
        if (!confirm(t('mig.confirmUnlink'))) return;
        try {
          await ctx.api.del(`/connections/${encodeURIComponent(d.connId)}/migrations`);
          closeModal();
          migDlg = null;
          toast(t('mig.unlinked'), 'success');
          await loadConnections();
          loadMigStatus(connections.find(x => x.id === d.connId));
        } catch (e) { toast(e.message, 'error'); }
      },
    };

    async function connectionForm(c = {}) {
      const tunnelServers = tunnelsAvailable
        ? (await ctx.apiFor('tunnels').get('/state').catch(() => ({ servers: [] }))).servers : [];
      const projectList = await projects();
      const opt = (value, label, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
      return `
        <div class="form-grid">
          <div class="form-row"><label>${esc(t('form.id'))}</label><input class="form-input" id="f_db_id" value="${esc(c.id || '')}" placeholder="${esc(t('form.idPlaceholder'))}" ${c.id ? 'disabled' : ''}></div>
          <div class="form-row"><label>${esc(t('form.name'))}</label><input class="form-input" id="f_db_label" value="${esc(c.label || '')}" placeholder="${esc(t('form.namePlaceholder'))}"></div>
        </div>
        ${tunnelsAvailable ? `<div class="form-row"><label>${esc(t('form.link'))}</label>
          <select class="form-input" id="f_db_tunnel" onchange="document.getElementById('f_db_direct').hidden=!!this.value">
            ${opt('', t('form.direct'), !c.tunnel)}
            ${c.tunnelMissing ? opt(c.tunnel, t('form.tunnelDeleted', { tunnel: c.tunnel }), true) : ''}
            ${tunnelServers.map(s => opt(s.key, t('form.tunnel', { name: s.label, remote: s.remote }), c.tunnel === s.key)).join('')}
          </select></div>` : ''}
        <div class="form-grid" id="f_db_direct" ${c.tunnel ? 'hidden' : ''}>
          <div class="form-row"><label>${esc(t('form.host'))}</label><input class="form-input" id="f_db_host" value="${esc(c.host || '127.0.0.1')}"></div>
          <div class="form-row"><label>${esc(t('form.port'))}</label><input class="form-input" id="f_db_port" type="number" min="1" max="65535" value="${esc(c.port || 3306)}"></div>
        </div>
        <div class="form-grid">
          <div class="form-row"><label>${esc(t('form.user'))}</label><input class="form-input" id="f_db_user" value="${esc(c.user || '')}" autocomplete="off"></div>
          <div class="form-row"><label>${esc(t(c.id ? 'form.passwordKeep' : 'form.password'))}</label><input class="form-input" id="f_db_password" type="password" autocomplete="new-password" placeholder="${c.hasPassword ? '••••••••' : ''}"></div>
        </div>
        <div class="form-grid">
          <div class="form-row"><label>${esc(t('form.database'))}</label><input class="form-input" id="f_db_database" value="${esc(c.database || '')}"></div>
          ${projectList.length ? `<div class="form-row"><label>${esc(t('form.project'))}</label><select class="form-input" id="f_db_project">
            ${opt('', t('form.noProject'), !c.projectId)}${projectList.map(p => opt(p.id, p.label, c.projectId === p.id)).join('')}</select></div>` : ''}
        </div>
        <div class="form-row"><label>${esc(t('form.folder'))}</label><select class="form-input" id="f_db_folder">
          ${opt('', t('form.noFolder'), !c.folder)}${folders.map(f => opt(f.id, f.label, c.folder === f.id)).join('')}</select></div>
        <label class="db-check"><input type="checkbox" id="f_db_readonly" ${c.readOnly ? 'checked' : ''}> ${esc(t('form.readOnly'))}</label>
        ${c.hasPassword ? `<label class="db-check"><input type="checkbox" id="f_db_clear"> ${esc(t('form.clearPassword'))}</label>` : ''}`;
    }

    function formValues() {
      const v = id => (document.getElementById(id)?.value ?? '').trim();
      const tunnel = v('f_db_tunnel');
      const password = document.getElementById('f_db_password')?.value || '';
      return {
        id: v('f_db_id'), label: v('f_db_label'), user: v('f_db_user'), database: v('f_db_database'),
        projectId: v('f_db_project'), folder: v('f_db_folder'), tunnel,
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
    // Autocompletamento: tabelle del database attivo e colonne (lette quando servono, in cache)
    const acColumns = new Map(); // "conn|db|table" → Promise<[{ name, type }]>
    const ac = createAutocomplete({
      input: sqlInput, container: $(ctx.root, 'editor'), esc,
      source: {
        async tables() {
          const c = active(), db = c && activeDb.get(c.id);
          if (!c || !db) return [];
          const k = nodeKey('d', c.id, db);
          if (!Array.isArray(cache.get(k))) await loadTables(c, db).catch(() => {});
          return Array.isArray(cache.get(k)) ? cache.get(k).map(tb => tb.name) : [];
        },
        columns(table) {
          const c = active(), db = c && activeDb.get(c.id);
          if (!c || !db || !table) return Promise.resolve([]);
          const k = `${c.id}|${db}|${table}`;
          if (!acColumns.has(k)) {
            acColumns.set(k, ctx.api.get(tableUrl(c, db, table))
              .then(r => r.columns.map(x => ({ name: x.name, type: x.type })))
              .catch(() => { acColumns.delete(k); return []; }));
          }
          return acColumns.get(k);
        },
      },
    });
    sqlInput.addEventListener('input', e => {
      // solo quando si scrive (non per gli inserimenti dal codice)
      if (e.isTrusted && /^insert(Text|CompositionText)$/.test(e.inputType || '') && /[A-Za-z0-9_$.`]$/.test(e.data || '')) ac.update();
      else if (e.isTrusted && e.inputType === 'deleteContentBackward') ac.update();
    });
    sqlInput.addEventListener('keydown', e => {
      if (ac.onKeyDown(e)) return;
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

    // ---- storico delle query (sessionStorage: dura quanto la scheda) ----
    const HISTORY_KEY = 'devdock.db-client.history';
    const HISTORY_MAX = 100;
    const readHistory = () => { try { return JSON.parse(sessionStorage.getItem(HISTORY_KEY)) || []; } catch { return []; } };
    function addHistory(entry) {
      const list = readHistory().filter(h => !(h.sql === entry.sql && h.connId === entry.connId && h.db === entry.db));
      list.unshift(entry);
      try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch {}
    }

    function showHistory() {
      const list = readHistory();
      const label = id => connections.find(c => c.id === id)?.label || id;
      // summary: { rows } o { affected } (le voci più vecchie hanno un testo già pronto)
      const summary = s => typeof s === 'string' ? s : s?.rows != null ? t('history.rows', { count: s.rows }) : t('history.affected', { count: s?.affected ?? 0 });
      openModal(t('history.title'), list.length ? `
        <div class="db-history">${list.map((h, i) => `
          <button class="db-history-item" onclick="Ext['db-client'].useHistory(${i})" title="${esc(t('history.load'))}">
            <span class="db-history-meta">${esc(fmt.date(h.at, { timeStyle: 'medium' }))} · ${esc(label(h.connId))}${h.db ? ` / ${esc(h.db)}` : ''} · ${h.ok ? `✓ ${esc(summary(h.summary))}` : esc(t('history.error'))}</span>
            <code>${esc(h.sql.length > 300 ? h.sql.slice(0, 300) + '…' : h.sql)}</code>
          </button>`).join('')}</div>` : `<p class="db-muted">${esc(t('history.none'))}</p>`,
        `${list.length ? `<button class="btn btn-ghost" onclick="Ext['db-client'].clearHistory()">${esc(t('history.clear'))}</button>` : ''}<button class="btn btn-primary" onclick="UI.closeModal()">${esc(t('core.action.close'))}</button>`);
    }

    let running = false;
    // opts: { sql, token } per rimandare un'istruzione confermata; { sql, params, paramInfo }
    // con i valori dei parametri (query con ? o :nome)
    async function run(opts) {
      const c = active();
      const sql = opts?.sql || statement();
      if (!c || !sql || running) return;
      const body = {
        sql, database: activeDb.get(c.id) || null, limit: Number($(ctx.root, 'limit').value),
        ...(opts?.token ? { confirm: opts.token } : {}),
        ...(opts?.params ? { params: opts.params } : {}),
      };
      running = true;
      grid = null;
      designer = null;
      $(ctx.root, 'results').innerHTML = `<div class="db-muted db-pad">${esc(t('run.running'))}</div>`;
      try {
        const res = await fetch(ctx.api.url(`/connections/${encodeURIComponent(c.id)}/query`), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        const record = (ok, summary) => addHistory({ sql, connId: c.id, db: body.database, at: Date.now(), ok, summary });
        if (res.status === 422 && data.needsParams) await needParams(c, sql, data.params);
        else if (res.status === 428 && data.needsConfirmation) askConfirmation(data, token => run({ sql: data.sql, token, paramInfo: opts?.paramInfo }));
        else if (!res.ok) { renderError(ctx.ui.errorText(data, `HTTP ${res.status}`), sql); showParamsUsed(opts?.paramInfo); record(false); }
        else {
          data.paramInfo = opts?.paramInfo || null;
          renderResult(data);
          record(true, data.kind === 'rows' ? { rows: data.rowCount } : { affected: data.affectedRows });
          // istruzione di schema eseguita dall'editor: l'albero si aggiorna da solo
          if (/^\s*(CREATE|ALTER|DROP|RENAME|TRUNCATE)\b/i.test(sql.replace(/^(\s*(--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/))*/, ''))) {
            refreshDatabase(c, /^\s*(CREATE|DROP)\s+(DATABASE|SCHEMA)\b/i.test(sql) ? null : body.database);
          }
        }
      } catch (e) {
        renderError(e.message, sql);
      } finally {
        running = false;
      }
    }

    // ---- query parametriche: un campo per parametro ----
    // I valori restano nella memoria di Kelbo (persi al riavvio), per query (connessione +
    // testo) e per nome. Una query già eseguita riparte con i suoi valori senza chiederli;
    // "Cambia" li riapre. Nel browser non resta nulla (le versioni 1.20.0 usavano localStorage).
    try { localStorage.removeItem('devdock.db.queryParams'); localStorage.removeItem('devdock.db.paramNames'); } catch { /* niente da togliere */ }
    async function savedParams(c, sql, list) {
      try { return await ctx.api.post('/param-values', { connection: c.id, sql, names: list.map(p => p.name) }); }
      catch { return { query: null, byName: {} }; }
    }
    // values: { chiave: { value, type } }
    function rememberParams(c, sql, list, values) {
      ctx.api.put('/param-values', { connection: c.id, sql, params: list.map(p => ({ key: p.key, name: p.name })), values }).catch(() => {});
    }
    // Valori da inviare, o null se un valore salvato non è più valido
    function paramsFrom(list, values) {
      const params = {};
      for (const p of list) {
        const v = paramValue(values[p.key].value, values[p.key].type);
        if (v.error) return null;
        params[p.key] = v.value;
      }
      return params;
    }

    // Risposta 422: valori salvati per questa query → si riparte subito, altrimenti la modale
    async function needParams(c, sql, list) {
      const { query: saved, byName } = await savedParams(c, sql, list);
      const params = saved && list.every(p => saved[p.key]) ? paramsFrom(list, saved) : null;
      if (params) {
        setTimeout(() => run({ sql, params, paramInfo: { sql, list, values: saved } }), 0); // dopo la fine di questa esecuzione
        return;
      }
      askParams(c, sql, list, saved || {}, byName);
    }

    let pendingParams = null; // { c, sql, list }
    function askParams(c, sql, list, saved, byName = {}) {
      pendingParams = { c, sql, list };
      $(ctx.root, 'results').innerHTML = `<div class="db-muted db-pad">${esc(t('params.waiting'))}</div>`;
      const types = ['auto', 'text', 'number', 'null'];
      const rows = list.map((p, i) => {
        const v = saved[p.key] || byName[p.name] || { value: '', type: 'auto' };
        const label = p.kind === 'named' ? `:${p.name}` : p.name;
        const hint = p.kind === 'named' ? '' : t(p.guessed ? 'params.positional' : 'params.positionalUnknown', { n: p.key.slice(1) });
        return `<div class="db-param-row">
          <label for="f_param_${i}"><span class="db-mono">${esc(label)}</span>${hint ? `<span class="db-param-hint">${esc(hint)}</span>` : ''}</label>
          <input class="form-input" id="f_param_${i}" value="${esc(v.value)}" autocomplete="off" ${v.type === 'null' ? 'disabled' : ''}
                 onkeydown="if(event.key==='Enter'){event.preventDefault();Ext['db-client'].runWithParams()}">
          <select class="form-input db-select" id="f_param_type_${i}" onchange="document.getElementById('f_param_${i}').disabled=this.value==='null'" title="${esc(t('params.typeTitle'))}">
            ${types.map(ty => `<option value="${ty}" ${ty === v.type ? 'selected' : ''}>${esc(t(`params.type.${ty}`))}</option>`).join('')}
          </select>
        </div>`;
      }).join('');
      openModal(t('params.title', { count: list.length }), `<p class="db-muted">${esc(t('params.hint'))}</p><div class="db-params">${rows}</div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal();Ext['db-client'].cancelParams()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" onclick="Ext['db-client'].runWithParams()">${esc(t('params.run'))}</button>`);
      setTimeout(() => { const f = document.getElementById('f_param_0'); f?.focus(); f?.select(); }, 0);
    }
    // Valore da inviare: auto → numero se ha la forma di un numero (senza zeri iniziali), altrimenti testo
    function paramValue(raw, type) {
      if (type === 'null') return { value: null };
      if (type === 'text') return { value: raw };
      const numeric = /^-?(0|[1-9]\d*)(\.\d+)?$/.test(String(raw).trim());
      if (type === 'number') return numeric ? { value: Number(raw) } : { error: true };
      return { value: numeric ? Number(raw) : raw };
    }
    function runWithParams() {
      if (!pendingParams) return;
      const { c, sql, list } = pendingParams;
      const values = {};
      for (const [i, p] of list.entries()) {
        const raw = document.getElementById(`f_param_${i}`)?.value ?? '';
        const type = document.getElementById(`f_param_type_${i}`)?.value || 'auto';
        if (paramValue(raw, type).error) { toast(t('params.notNumber', { name: p.name }), 'error'); document.getElementById(`f_param_${i}`)?.focus(); return; }
        values[p.key] = { value: raw, type };
      }
      pendingParams = null;
      closeModal();
      rememberParams(c, sql, list, values);
      run({ sql, params: paramsFrom(list, values), paramInfo: { sql, list, values } });
    }

    // Valori usati, sopra i risultati, con "Cambia" per riaprire la modale
    function paramsUsed(info) {
      if (!info) return '';
      const shown = info.list.map(p => {
        const v = info.values[p.key];
        const text = v.type === 'null' ? 'NULL' : paramValue(v.value, v.type).value;
        return `${p.kind === 'named' ? ':' : ''}${p.name} = ${typeof text === 'number' ? text : text === 'NULL' ? 'NULL' : `'${text}'`}`;
      }).join(', ');
      return `<div class="db-params-used"><span class="db-muted">${esc(t('params.used'))}</span> <span class="db-mono" title="${esc(shown)}">${esc(shown)}</span>
        <button class="btn btn-ghost btn-sm" data-action="change-params">✎ ${esc(t('params.change'))}</button></div>`;
    }
    let lastParamInfo = null;
    function showParamsUsed(info) {
      lastParamInfo = info || null;
      if (info) $(ctx.root, 'results').insertAdjacentHTML('afterbegin', paramsUsed(info));
    }
    function changeParams() {
      const info = lastParamInfo;
      const c = active();
      if (!info || !c) return;
      askParams(c, info.sql, info.list, info.values);
    }

    // Nessuna modifica parte senza che l'utente veda e confermi l'istruzione esatta
    let pendingConfirm = null;
    // onConfirm(token) rimanda la stessa richiesta con il token della conferma
    function askConfirmation(data, onConfirm, keepResults = false) {
      pendingConfirm = { data, onConfirm, keepResults };
      if (!keepResults) $(ctx.root, 'results').innerHTML = `<div class="db-muted db-pad">${esc(t('run.waiting'))}</div>`;
      // parametri in grassetto: il testo tradotto è escapato, poi i segnaposto diventano <strong>
      const strong = v => `\u0000${v}\u0001`;
      const text = esc(t(data.database ? 'confirm.textDb' : 'confirm.text', {
        verb: strong(data.verb || t('confirm.unknownVerb')), database: strong(data.database || ''), connection: strong(active()?.label || ''),
      })).replace(/\u0000/g, '<strong>').replace(/\u0001/g, '</strong>');
      openModal(t('confirm.title'), `
        <p class="db-confirm-text">${text}${data.reason ? ` <span class="db-muted">(${esc(t(`reason.${data.reason}`, { word: data.word || '' }))})</span>` : ''}</p>
        <pre class="db-confirm-sql">${highlightSql(data.sql, esc)}</pre>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal();Ext['db-client'].cancelConfirm()">${esc(t('core.action.cancel'))}</button>
         ${data.migration ? `<button class="btn btn-ghost" onclick="Ext['db-client'].confirmRun()">${esc(t('confirm.runOnly'))}</button>
           <button class="btn btn-primary" onclick="Ext['db-client'].saveAsMigration()">${esc(t('confirm.saveMigration'))}</button>`
         : `<button class="btn btn-danger" onclick="Ext['db-client'].confirmRun()">${esc(t('confirm.run'))}</button>`}`);
      if (data.migration) {
        document.getElementById('modalBody').insertAdjacentHTML('beforeend', `<p class="db-muted">${esc(t('confirm.migrationHint'))}</p>`);
      }
    }

    function renderError(message, sql) {
      $(ctx.root, 'results').innerHTML = `<div class="db-error">✖ ${esc(message)}</div>`;
    }

    // Ordinamento lato client dei risultati dell'editor (numeri come numeri, NULL in fondo):
    // indici delle righe, così la riga modificata resta quella giusta
    let lastResult = null, resultSort = null;
    function sortedIndexes(data) {
      const idx = data.rows.map((_, i) => i);
      if (!resultSort) return idx;
      const { col, dir } = resultSort;
      const numeric = data.rows.every(r => r[col] === null || (r[col] !== '' && !isNaN(Number(r[col]))));
      const cmp = (a, b) => {
        if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
        return numeric ? Number(a) - Number(b) : String(a).localeCompare(String(b), undefined, { numeric: true });
      };
      return idx.sort((x, y) => (dir === 'desc' ? -1 : 1) * cmp(data.rows[x][col], data.rows[y][col]));
    }

    // Risultati modificabili: tutte le colonne non calcolate vengono da una sola tabella e la
    // chiave primaria è tra le colonne (anche con alias). Struttura delle tabelle in cache.
    const tableInfoCache = new Map(); // "conn|db|table" → { pk, columns: Map(nome → colonna) } | 'loading' | null
    function resultTarget(data) {
      const c = active();
      if (!c || c.readOnly || data.kind !== 'rows') return null;
      const sources = new Set(data.columns.filter(col => col.table && col.column).map(col => `${col.db}\u0000${col.table}`));
      if (sources.size !== 1) return null;
      const [db, table] = [...sources][0].split('\u0000');
      const k = `${c.id}|${db}|${table}`;
      const info = tableInfoCache.get(k);
      if (info === undefined) {
        tableInfoCache.set(k, 'loading');
        ctx.api.get(tableUrl(c, db, table)).then(r => {
          tableInfoCache.set(k, { pk: r.columns.filter(x => x.key === 'PRI').map(x => x.name), columns: new Map(r.columns.map(x => [x.name, x])) });
        }).catch(() => tableInfoCache.set(k, null)).then(() => { if (lastResult === data) renderResult(data, true); });
        return null;
      }
      if (!info || info === 'loading' || !info.pk.length) return null;
      const colOf = data.columns.map(col => (col.table === table && col.db === db ? col.column : null));
      const pkIdx = info.pk.map(name => colOf.indexOf(name));
      if (pkIdx.some(i => i === -1)) return null;
      return { c, db, table, info, colOf, pkIdx };
    }

    function editResultCell(td) {
      const data = lastResult;
      const target = data && resultTarget(data);
      const r = Number(td.parentElement.dataset.r), ci = Number(td.dataset.c);
      const col = data?.columns[ci];
      const value = data ? shown(data, r, ci) : undefined;
      const isJson = /^json$/i.test(col?.type || '');
      const name = target?.colOf[ci];
      if (!target || !name) { if (isJson && value !== null) openJsonEditor({ title: col.name, value, readOnly: true }); return; }
      const meta = target.info.columns.get(name) || {};
      if (isJson) {
        return openJsonEditor({ title: col.name, value, nullable: meta.nullable, apply: true,
          onSave: next => { const orig = data.rows[r][ci]; setPending(data, r, ci, jsonChanged(next, orig) ? next : orig, orig); if (lastResult === data) renderResult(data, true); } });
      }
      if (td.querySelector('input')) return;
      cellInput(td, value, meta.nullable, (mode, next) => {
        if (lastResult !== data) return;
        if (mode !== 'cancel') setPending(data, r, ci, next, data.rows[r][ci]);
        renderResult(data, true);
        if (mode === 'save') return saveEdits(data);
        if (mode === 'next' || mode === 'prev') {
          const near = neighbourCell($(ctx.root, 'results').querySelector('.db-result-table'), r, ci, mode === 'next' ? 1 : -1);
          if (near) editResultCell(near);
        }
      });
    }

    function renderResult(data, keepSort) {
      const el = $(ctx.root, 'results');
      if (!keepSort) resultSort = null;
      lastResult = data;
      lastParamInfo = data.paramInfo || null;
      if (data.kind === 'result') {
        el.innerHTML = `${paramsUsed(data.paramInfo)}<div class="db-ok">${esc(t('result.affected', { count: data.affectedRows }))}${data.insertId ? ` · insertId ${esc(data.insertId)}` : ''}${data.info ? ` · ${esc(data.info)}` : ''} <span class="db-muted">(${esc(t('result.ms', { ms: data.ms }))})</span></div>`;
        return;
      }
      const target = resultTarget(data);
      const editable = i => !!target?.colOf[i];
      ctx.ui.patch(el, `
        ${paramsUsed(data.paramInfo)}
        <div class="db-result-meta">${esc(t('result.rows', { count: data.rowCount }))}${data.truncated ? ` ${esc(t('result.truncated', { limit: data.limit }))}` : ''} · ${esc(t('result.ms', { ms: data.ms }))}
          ${target ? `<span class="db-badge" title="${esc(t('result.editableHint'))}">✎ ${esc(t('result.editable', { table: target.table }))}</span>` : ''}
          ${target ? editsBar(data) : ''}</div>
        <div class="db-table-wrap"><table class="data-table db-table db-result-table">
          <thead><tr>${data.columns.map((col, i) => `<th data-result-sort="${i}" title="${esc(t('result.sortTitle', { type: col.type }))}">${esc(col.name)}${resultSort?.col === i ? (resultSort.dir === 'desc' ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead>
          <tbody>${sortedIndexes(data).map(r => `<tr data-r="${r}">${data.rows[r].map((_, i) => {
            const v = shown(data, r, i), dirty = pendingOf(data).has(`${r}|${i}`);
            const cls = [v === null ? 'db-null' : '', editable(i) ? 'db-editable' : '', /^json$/i.test(data.columns[i].type) ? 'db-json-cell' : '', dirty ? 'db-dirty' : ''].filter(Boolean).join(' ');
            return `<td data-c="${i}" class="${cls}" title="${esc(dirty ? t('edits.was', { value: data.rows[r][i] ?? 'NULL' }) : v ?? 'NULL')}">${v === null ? 'NULL' : esc(v)}</td>`;
          }).join('')}</tr>`).join('')}</tbody>
        </table></div>`);
    }

    const modalButtons = (label, call) =>
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button><button class="btn btn-primary" onclick="${esc(call)}">${esc(label)}</button>`;

    function renderGate() {
      const creating = vault.state === 'uninitialized';
      $(ctx.root, 'gate-title').textContent = t(creating ? 'gate.createTitle' : 'gate.lockedTitle');
      $(ctx.root, 'gate-text').textContent = creating
        ? t('gate.createText', { min: vault.minLength })
        : t('gate.unlockText', { count: vault.lockAfterMinutes });
      $(ctx.root, 'gate-password').placeholder = t('gate.placeholder');
      $(ctx.root, 'gate-confirm').hidden = !creating;
      $(ctx.root, 'gate-forgot').hidden = creating;
      $(ctx.root, 'gate-submit').textContent = t(creating ? 'gate.create' : 'gate.unlock');
      $(ctx.root, 'gate-error').textContent = '';
      setTimeout(() => $(ctx.root, 'gate-password').focus(), 0);
    }

    async function submitGate(e) {
      e.preventDefault();
      const pwd = $(ctx.root, 'gate-password').value;
      const error = $(ctx.root, 'gate-error');
      if (vault.state === 'uninitialized') {
        if ([...pwd].length < vault.minLength) { error.textContent = t('gate.tooShort', { min: vault.minLength }); return; }
        if (pwd !== $(ctx.root, 'gate-confirm').value) { error.textContent = t('gate.mismatch'); return; }
      }
      const submit = $(ctx.root, 'gate-submit');
      submit.disabled = true;
      try {
        await ctx.core.post(vault.state === 'uninitialized' ? '/vault/init' : '/vault/unlock', { password: pwd });
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
      openModal(t('vault.title'), `
        <div class="form-row"><label>${esc(t('vault.oldPassword'))}</label><input class="form-input" type="password" id="f_vault_old" autocomplete="off"></div>
        <div class="form-row"><label>${esc(t('vault.newPassword', { min: vault.minLength }))}</label><input class="form-input" type="password" id="f_vault_new" autocomplete="off"></div>
        <div class="form-row"><label>${esc(t('vault.repeatPassword'))}</label><input class="form-input" type="password" id="f_vault_new2" autocomplete="off"></div>
        <div class="form-row"><label>${esc(t('vault.lockAfter'))}</label><input class="form-input" type="number" min="1" max="1440" id="f_vault_minutes" value="${esc(vault.lockAfterMinutes)}"></div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-ghost" onclick="Ext['db-client'].lock()">${esc(t('vault.lockNow'))}</button>
         <button class="btn btn-primary" onclick="Ext['db-client'].saveVault()">${esc(t('core.action.save'))}</button>`);
    }

    async function saveVault() {
      const val = id => document.getElementById(id)?.value || '';
      try {
        const minutes = Number(val('f_vault_minutes'));
        if (minutes !== vault.lockAfterMinutes) await ctx.core.post('/vault/settings', { lockAfterMinutes: minutes });
        if (val('f_vault_new')) {
          if (val('f_vault_new') !== val('f_vault_new2')) { toast(t('vault.mismatch'), 'error'); return; }
          const r = await ctx.core.post('/vault/change', { oldPassword: val('f_vault_old'), newPassword: val('f_vault_new') });
          toast(t('vault.changed', { count: r.reencrypted }), 'success');
        } else {
          toast(t('vault.saved'), 'success');
        }
        closeModal();
        await loadVault();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function lock() {
      closeModal();
      await ctx.core.post('/vault/lock').catch(() => {});
      await loadVault();
    }

    async function resetVault() {
      if (prompt(t('vault.resetPrompt')) !== 'RESET') return;
      try {
        await ctx.core.post('/vault/reset', { confirm: 'RESET' });
        toast(t('vault.resetDone'), 'success');
        await loadVault();
      } catch (e) { toast(e.message, 'error'); }
    }

    const actions = {
      ...migActions,
      lock, saveVault,
      run: () => run(),
      importConnections() {
        openModal(t('import.title'), `
          <p class="db-muted">${esc(t('import.hint'))}</p>
          <div class="form-row"><label>${esc(t('import.file'))}</label><input class="form-input" type="file" accept=".json" id="f_imp_file"></div>
          <div class="form-row"><label>${esc(t('import.password'))}</label><input class="form-input" type="password" id="f_imp_password" autocomplete="off"></div>
          <label class="db-check"><input type="radio" name="f_imp_mode" value="merge" checked> ${esc(t('import.merge'))}</label>
          <label class="db-check"><input type="radio" name="f_imp_mode" value="replace"> ${esc(t('import.replace'))}</label>`,
          `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button><button class="btn btn-primary" onclick="Ext['db-client'].doImportConnections()">${esc(t('import.submit'))}</button>`);
      },
      async doImportConnections() {
        const file = document.getElementById('f_imp_file')?.files[0];
        if (!file) { toast(t('import.chooseFile'), 'error'); return; }
        try {
          const config = JSON.parse(await file.text());
          const mode = document.querySelector('input[name="f_imp_mode"]:checked')?.value || 'merge';
          if (mode === 'replace' && !confirm(t('import.confirmReplace'))) return;
          const r = await ctx.api.post('/connections/import', { config, password: document.getElementById('f_imp_password').value, mode });
          closeModal();
          toast(t('import.done', { count: r.imported }) + (r.skipped ? `, ${t('import.skipped', { count: r.skipped })}` : ''), 'success');
          await loadConnections();
        } catch (e) { toast(e instanceof SyntaxError ? t('import.invalid') : e.message, 'error'); }
      },
      useHistory(i) {
        const h = readHistory()[i];
        if (!h) return;
        closeModal();
        if (h.connId !== activeId && connections.some(c => c.id === h.connId)) actions.select(h.connId);
        if (h.db) activeDb.set(h.connId, h.db);
        renderActiveDb();
        sqlInput.value = h.sql;
        sqlInput.dispatchEvent(new Event('input'));
        sqlInput.focus();
      },
      clearHistory() { try { sessionStorage.removeItem(HISTORY_KEY); } catch {} closeModal(); toast(t('history.cleared')); },
      saveRowDialog(r) {
        const editing = r != null;
        const row = editing ? grid.data.rows[r] : null;
        const values = {};
        let invalid = null;
        grid.data.columns.forEach((col, c) => {
          const isNull = document.getElementById(`f_row_${c}_null`)?.checked;
          let v = isNull ? null : document.getElementById(`f_row_${c}`).value;
          if (isJsonCol(col) && v !== null && v.trim() !== '') {
            try { v = JSON.stringify(JSON.parse(v)); } catch (e) { invalid = invalid || t('json.invalidColumn', { column: col.name, error: e.message }); return; }
          }
          const differs = isJsonCol(col) ? jsonChanged(v === '' ? null : v, row?.[c] ?? null) : changed(v, row?.[c]);
          if (editing ? differs : (v !== '' || isNull)) values[col.name] = v; // solo i campi cambiati / compilati
        });
        if (invalid) { toast(invalid, 'error'); return; }
        if (editing && !Object.keys(values).length) { toast(t('row.noChanges')); return; }
        closeModal();
        saveRow(editing ? 'update' : 'insert', editing ? keyOf(row) : null, values);
      },
      formatJson() {
        const el = document.getElementById('f_json');
        const ok = readJson('f_json', 'f_json_error');
        if (ok) { el.value = JSON.stringify(JSON.parse(ok.value), null, 2); document.getElementById('f_json_error').textContent = ''; }
      },
      saveJson(setNull) {
        if (!jsonEdit) return;
        const { value: prev, onSave } = jsonEdit;
        let next = null;
        if (!setNull) {
          const ok = readJson('f_json', 'f_json_error');
          if (!ok) return;
          next = ok.value;
        }
        closeModal();
        jsonEdit = null;
        if (!jsonChanged(next, prev)) { toast(t('row.noChanges')); return; }
        onSave(next);
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
      // Istruzione di schema dall'editor: stessa anteprima del designer (SQL + file di migration)
      saveAsMigration() {
        const p = pendingConfirm;
        pendingConfirm = null;
        closeModal();
        const c = active();
        if (!p || !c) return;
        const { sql, database, migration } = p.data;
        const { table, operation } = migration.proposal;
        migrateFlow(c, database, { operations: [{ op: 'raw', sql, table, operation }], migration: { table: fileSlug(table) || undefined, operation } }, result => {
          if (result.ran !== false) addHistory({ sql, connId: c.id, db: database, at: Date.now(), ok: true, summary: { affected: 0 } });
          $(ctx.root, 'results').innerHTML = `<div class="db-ok">✓ ${esc(migrateDoneText(result))}</div>`;
          if (result.ran !== false) refreshDatabase(c, database);
        });
        if (!p.keepResults) $(ctx.root, 'results').innerHTML = '';
      },
      runWithParams: () => runWithParams(),
      cancelParams() {
        pendingParams = null;
        $(ctx.root, 'results').innerHTML = `<div class="db-muted db-pad">${esc(t('run.cancelled'))}</div>`;
      },
      cancelConfirm() {
        const p = pendingConfirm;
        pendingConfirm = null;
        if (p && !p.keepResults) $(ctx.root, 'results').innerHTML = `<div class="db-muted db-pad">${esc(t('run.cancelled'))}</div>`;
        else toast(t('run.nothingDone'));
      },
      select(id) { activeId = id; renderConnections(); renderWorkspace(); },
      addFolder: () => folderDialog(null),
      async saveFolder(id) {
        const label = (document.getElementById('f_dbfolder_label')?.value || '').trim();
        if (!label) { toast(t('folders.nameRequired'), 'error'); return; }
        try {
          if (id) await ctx.api.put(`/folders/${encodeURIComponent(id)}`, { label });
          else await ctx.api.post('/folders', { label });
          closeModal();
          await loadConnections();
        } catch (e) { toast(e.message, 'error'); }
      },
      async deleteFolder(id) {
        const f = folders.find(x => x.id === id);
        if (!f || !confirm(t('folders.confirmDelete', { name: f.label }))) return;
        try {
          await ctx.api.del(`/folders/${encodeURIComponent(id)}`);
          await loadConnections();
        } catch (e) { toast(e.message, 'error'); }
      },
      async addConnection() { openModal(t('connections.newTitle'), await connectionForm(), modalButtons(t('connections.create'), "Ext['db-client'].saveConnection()")); },
      async editConnection(id) {
        const c = connections.find(x => x.id === id);
        if (c) openModal(t('connections.editTitle'), await connectionForm(c), modalButtons(t('core.action.save'), `Ext['db-client'].saveConnection(${JSON.stringify(id)})`));
      },
      async saveConnection(existingId) {
        const body = formValues();
        if (!body.label || !body.user || (!existingId && !body.id)) { toast(t('connections.required'), 'error'); return; }
        try {
          const r = existingId
            ? await ctx.api.put(`/connections/${encodeURIComponent(existingId)}`, body)
            : await ctx.api.post('/connections', body);
          closeModal();
          toast(t('connections.saved'), 'success');
          activeId = r.connection.id;
          if (existingId) activeDb.delete(existingId); // riparte dal database predefinito (forse cambiato)
          await loadConnections();
          // errori e dati vecchi della connessione non valgono più
          forgetConnection(r.connection.id);
          if (existingId && existingId === activeId && $(ctx.root, 'results').querySelector('.db-error')) $(ctx.root, 'results').innerHTML = '';
        } catch (e) { toast(e.message, 'error'); }
      },
      async deleteConnection(id) {
        const c = connections.find(x => x.id === id);
        if (!c || !confirm(t('connections.confirmDelete', { name: c.label }))) return;
        try {
          await ctx.api.del(`/connections/${encodeURIComponent(id)}`);
          if (activeId === id) activeId = null;
          toast(t('connections.deleted'), 'success');
          await loadConnections();
          forgetConnection(id);
        } catch (e) { toast(e.message, 'error'); }
      },
      async testConnection(id) {
        toast(t('connections.testing'));
        try {
          const r = await ctx.api.post(`/connections/${encodeURIComponent(id)}/test`);
          toast(t(r.via ? 'connections.testOkTunnel' : 'connections.testOk', { version: r.version, user: r.user, via: r.via, ms: r.ms }), 'success');
        } catch (e) { toast(e.message, 'error'); }
      },
    };

    $(ctx.root, 'gate-form').addEventListener('submit', submitGate);
    ctx.root.addEventListener('click', e => {
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (a === 'vault-reset') resetVault();
      else if (a === 'run') run();
      else if (a === 'change-params') changeParams();
      else if (a === 'export-query') exportQuery(e.target.closest('[data-action]'));
      else if (a === 'history') showHistory();
      else if (a === 'new-table') { const c = active(); if (c) openDesigner(c, activeDb.get(c.id)); }
    });
    // Albero: freccia apre/chiude; clic sulla connessione la seleziona, sul database lo rende
    // attivo, sulla tabella apre il menu contestuale (anche con il tasto destro)
    function onTree(e, contextual) {
      const row = e.target.closest('[data-tree]');
      if (!row) return;
      if (row.dataset.tree === 'add') return actions.addConnection();
      if (row.dataset.tree === 'folder') {
        if (contextual || e.target.closest('[data-act="folder-menu"]')) { e.preventDefault(); return folderMenu(e, row.dataset.folder); }
        return toggleFolder(row.dataset.folder);
      }
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
    $(ctx.sidebar, 'tree-filter').addEventListener('input', e => { treeFilter = e.target.value; renderConnections(); });
    ctx.sidebar.addEventListener('contextmenu', e => {
      if (e.target.closest('[data-tree="table"], [data-tree="folder"]')) return onTree(e, true);
      const dbRow = e.target.closest('[data-tree="db"]');
      if (!dbRow) return;
      e.preventDefault();
      const c = connections.find(x => x.id === dbRow.dataset.conn);
      const db = dbRow.dataset.db;
      ctx.ui.contextMenu(e.clientX, e.clientY, [
        { icon: '＋', label: t('menu.newTable'), disabled: c.readOnly, action: () => { setActiveDb(c, db); openDesigner(c, db); } },
        { icon: '↻', label: t('menu.refreshTables'), action: () => { open.add(nodeKey('d', c.id, db)); refreshDatabase(c, db); } },
      ]);
    });
    ctx.sidebar.addEventListener('click', e => {
      if (e.target.closest('[data-action="vault-menu"]')) vaultMenu();
      else if (e.target.closest('[data-action="add-connection"]')) actions.addConnection();
      else if (e.target.closest('[data-action="add-folder"]')) actions.addFolder();
      else if (e.target.closest('[data-action="import-connections"]')) actions.importConnections();
    });
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
    // Testi delle opzioni del limite di righe ("1000 righe")
    function renderLimitOptions() {
      for (const o of $(ctx.root, 'limit').options) o.textContent = t('toolbar.limit', { count: Number(o.value) });
    }
    renderLimitOptions();

    this.show = loadVault;
    this.refresh = async () => { cache.clear(); migStatus.clear(); await loadVault(); reopen(); };
    // Cambio di lingua: testi dinamici di nuovo, senza ricaricare dati né perdere l'editor
    this.languageChanged = () => {
      renderLimitOptions();
      if (vault.state !== 'unlocked') { render(); return; }
      renderConnections();
      renderWorkspace();
      renderMigDialog();
      if (designer) renderDesigner();
      else if (grid?.data) renderGrid();
      else if (lastResult) renderResult(lastResult, true);
    };
  },
};
