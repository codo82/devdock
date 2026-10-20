// Shell delle estensioni: tab e pulsanti nell'header, pannelli, caricamento lazy di
// view.html / style.css / view.js e contesto (ctx) passato ai moduli frontend.
// Contratto in docs/EXTENSIONS.md. Navigazione, header e avvio dell'app.
window.Shell = (() => {
  const { esc, js, cssColor, ansiToHtml, toast, openModal, closeModal, apiClient, formatUptime, toolNotice, contextMenu } = window.UI;
  const { t, fmt } = window.I18n;
  const pick = v => window.I18n.pick(v);

  const exts = new Map();   // code → { meta, panel, sidebar, tab, module, ctx, loading }
  const bus = new EventTarget();
  let active = null;        // code dell'estensione visibile
  let extList = [];         // dati di /api/core/extensions
  let notificationsEnabled = false;
  window.Ext = window.Ext || {}; // funzioni esposte per gli handler inline (ctx.expose)

  // ---- avvio: crea tab/pulsanti per le estensioni con frontend ----
  async function init() {
    let list = [];
    let failure = null;
    try { list = await apiClient('/api/core').get('/extensions'); }
    catch (e) { failure = e; }
    // cataloghi del core e delle estensioni attive, prima di creare qualsiasi testo
    await window.I18n.init(list.filter(e => e.state !== 'disabled'));
    window.I18n.apply(document);
    renderLanguageButton();
    if (failure) { toast(t('core.extensions.unavailable', { error: failure.message }), 'error'); return; }
    extList = list;

    for (const meta of list) {
      if (meta.state === 'disabled') { console.warn(`[ext:${meta.code}] disattivata: ${meta.error}`); continue; }
      if (!meta.frontend?.js) continue;
      const entry = { meta, panel: createPanel(meta), sidebar: createSidebar(meta), tab: null, module: null, ctx: null, loading: null };
      entry.tab = meta.position === 'header' ? createHeaderButton(meta) : createTab(meta);
      exts.set(meta.code, entry);
    }

    // preload: modulo montato subito (nascosto), per pill, badge e notifiche in background
    await Promise.all([...exts.values()].filter(e => e.meta.frontend.preload).map(e => load(e).catch(() => {})));
  }

  // Prima estensione in ordine di tab: quella aperta all'avvio
  function firstSection() {
    const first = document.querySelector('.section-nav .section-tab');
    return first ? first.id.replace(/^ext-tab-/, '') : null;
  }

  function warningMark(meta) {
    return meta.warnings?.length
      ? `<span class="ext-warning" title="${esc(meta.warnings.join('\n'))}">⚠</span>` : '';
  }

  function createTab(meta) {
    const btn = document.createElement('button');
    btn.className = 'section-tab';
    btn.id = `ext-tab-${meta.code}`;
    btn.style.setProperty('--tab-color', cssColor(meta.color));
    btn.innerHTML = `
      <span class="section-tab-icon">${esc(meta.icon || '◆')}</span>
      <span class="section-tab-name">${esc(pick(meta.name))}</span>${warningMark(meta)}
      <span class="section-tab-badge" style="display:none"></span>`;
    btn.dataset.order = meta.order;
    btn.addEventListener('click', () => open(meta.code));
    // posizione per "order", insieme ai tab delle sezioni del core (data-order)
    const nav = document.querySelector('.section-nav');
    const next = [...nav.children].find(el => Number(el.dataset.order ?? 100) > meta.order);
    nav.insertBefore(btn, next || null);
    return btn;
  }

  function createHeaderButton(meta) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost ext-header-btn';
    btn.id = `ext-tab-${meta.code}`;
    btn.title = pick(meta.name);
    btn.style.setProperty('--tab-color', cssColor(meta.color));
    btn.innerHTML = `${esc(meta.icon || pick(meta.name))}${warningMark(meta)}<span class="section-tab-badge" style="display:none"></span>`;
    btn.addEventListener('click', () => open(meta.code));
    const actions = document.querySelector('.header-actions');
    actions.insertBefore(btn, actions.querySelector('#stopAllBtn'));
    return btn;
  }

  function createPanel(meta) {
    const panel = document.createElement('div');
    panel.className = 'main-panel ext-panel';
    panel.id = `ext-panel-${meta.code}`;
    panel.style.display = 'none';
    panel.style.setProperty('--ext-color', cssColor(meta.color));
    panel.dataset.i18nNs = meta.code;
    panel.innerHTML = `
      <div class="ext-root"></div>
      <div class="sse-panel">
        <div class="sse-panel-header">
          <span class="sse-title" data-i18n="core.output.title"></span>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn-ghost btn-sm" data-sse="clear" data-i18n-title="core.output.clear">🗑</button>
            <button class="btn btn-ghost btn-sm" data-sse="close" data-i18n-aria-label="core.action.close">✕</button>
          </div>
        </div>
        <div class="sse-body"></div>
      </div>`;
    window.I18n.apply(panel);
    document.querySelector('main.main').appendChild(panel);
    return panel;
  }

  function createSidebar(meta) {
    const sb = document.createElement('div');
    sb.className = 'ext-sidebar';
    sb.id = `ext-sidebar-${meta.code}`;
    sb.style.display = 'none';
    sb.style.setProperty('--ext-color', cssColor(meta.color));
    sb.dataset.i18nNs = meta.code;
    document.getElementById('sidebar').appendChild(sb);
    return sb;
  }

  function pillsContainer(code) {
    let el = document.querySelector(`#activePills [data-ext="${code}"]`);
    if (!el) {
      el = document.createElement('span');
      el.className = 'ext-pills';
      el.dataset.ext = code;
      el.style.setProperty('--ext-color', cssColor(exts.get(code)?.meta.color));
      document.getElementById('activePills').prepend(el);
    }
    return el;
  }

  // ---- caricamento lazy ----
  function load(entry) {
    if (entry.loading) return entry.loading;
    const { meta } = entry;
    const base = `/ext/${meta.code}/`;
    entry.loading = (async () => {
      if (meta.frontend.css) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = base + meta.frontend.css;
        document.head.appendChild(link);
      }
      const root = entry.panel.querySelector('.ext-root');
      const [html, sidebar] = await Promise.all([meta.frontend.html, meta.frontend.sidebar]
        .map(f => f ? fetch(base + f).then(r => r.ok ? r.text() : Promise.reject(new Error(`${f}: HTTP ${r.status}`))) : null));
      // markup statico tradotto con le chiavi dell'estensione (data-i18n…)
      if (html !== null) { root.innerHTML = html; window.I18n.apply(root, meta.code); }
      if (sidebar !== null) { entry.sidebar.innerHTML = sidebar; window.I18n.apply(entry.sidebar, meta.code); }
      const mod = await import(base + meta.frontend.js);
      entry.module = mod.default || mod;
      entry.ctx = makeContext(entry);
      await entry.module.mount?.(entry.ctx);
    })();
    entry.loading.catch(e => {
      entry.loading = null;
      entry.panel.querySelector('.ext-root').innerHTML =
        `<div class="empty-state"><div class="icon">⚠</div><p>${esc(t('core.extensions.loadError', { name: pick(meta.name), error: e.message }))}</p></div>`;
    });
    return entry.loading;
  }

  // ---- contesto per i moduli frontend ----
  function makeContext(entry) {
    const { meta, panel, sidebar } = entry;
    const api = apiClient(`/api/ext/${meta.code}`);

    // POST con risposta SSE (es. azioni git): onEvent({type, data}); restituisce l'exit code
    api.stream = async (p, body, onEvent) => {
      const res = await fetch(api.url(p), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        // stato e corpo restano sull'errore: la UI può reagire ai codici (es. 409 { code })
        throw Object.assign(new Error(window.I18n.errorText(d, `HTTP ${res.status}`)), { status: res.status, code: d.code, data: d });
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', exit = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          const line = part.replace(/^data: /, '').trim();
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'exit') exit = ev.data;
          onEvent?.(ev);
        }
      }
      return exit;
    };

    // GET con risposta SSE (EventSource): restituisce una funzione per chiudere
    api.events = (p, onEvent, onError) => {
      const es = new EventSource(api.url(p));
      es.onmessage = e => { try { onEvent(JSON.parse(e.data)); } catch {} };
      es.onerror = () => { es.close(); onError?.(); };
      return () => es.close();
    };

    const sse = {
      body: panel.querySelector('.sse-body'),
      title: panel.querySelector('.sse-title'),
      box: panel.querySelector('.sse-panel'),
    };
    const output = {
      open(title) {
        delete sse.title.dataset.i18n; // titolo scelto dall'estensione: il cambio di lingua non lo sovrascrive
        sse.title.textContent = title; sse.body.innerHTML = ''; sse.box.classList.add('open');
      },
      append(text, cls = 'out') {
        const el = document.createElement('span');
        if (cls === 'sys') { el.className = 'ansi-sys'; el.textContent = text; }
        else { el.innerHTML = ansiToHtml(String(text)); if (cls === 'err') el.classList.add('ansi-stderr'); }
        sse.body.appendChild(el);
        sse.body.scrollTop = sse.body.scrollHeight;
      },
      clear() { sse.body.innerHTML = ''; },
      close() { sse.box.classList.remove('open'); },
    };
    panel.querySelector('[data-sse="clear"]').addEventListener('click', output.clear);
    panel.querySelector('[data-sse="close"]').addEventListener('click', output.close);

    return {
      code: meta.code,
      meta,
      root: panel.querySelector('.ext-root'),
      sidebar,
      api,
      core: apiClient('/api/core'),
      // traduzioni: chiavi relative all'estensione ("core." per quelle del core)
      t: window.I18n.scoped(meta.code),
      i18n: {
        get lang() { return window.I18n.lang; },
        pick,
        apply: (root) => window.I18n.apply(root, meta.code),
      },
      ui: { esc, js, cssColor, ansiToHtml, toast, openModal, closeModal, output, formatUptime, toolNotice, notify, contextMenu, t, fmt, errorText: window.I18n.errorText },
      bus: {
        on(name, fn) { const h = e => fn(e.detail); bus.addEventListener(name, h); return () => bus.removeEventListener(name, h); },
        emit(name, detail) { bus.dispatchEvent(new CustomEvent(name, { detail })); },
      },
      expose(obj) { window.Ext[meta.code] = obj; },
      setBadge(value) {
        const badge = entry.tab?.querySelector('.section-tab-badge');
        if (!badge) return;
        const empty = value === null || value === undefined || value === '';
        badge.style.display = empty ? 'none' : '';
        badge.textContent = empty ? '' : String(value);
      },
      // HTML delle pill nell'header per questa estensione ('' le rimuove)
      setPills(html) { pillsContainer(meta.code).innerHTML = html || ''; },
      open,
      isActive: () => active === meta.code,
      // Un'altra estensione è caricata e attiva? (per funzioni che si appoggiano a lei)
      hasExtension: code => extList.some(e => e.code === code && e.state !== 'disabled'),
      // Client per le API di un'altra estensione (/api/ext/<code>)
      apiFor: code => apiClient(`/api/ext/${code}`),
    };
  }

  // ---- notifiche desktop (attivate dal pulsante 🔔, usate dalle estensioni con ctx.ui.notify) ----
  function notify(title, body, icon = '🔵') {
    if (!notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification(`${icon} ${title}`, { body, silent: false });
  }

  async function toggleNotifications() {
    const btn = document.getElementById('notifBtn');
    if (notificationsEnabled) {
      notificationsEnabled = false;
      toast(t('core.notifications.off'));
    } else {
      if (!('Notification' in window)) { toast(t('core.notifications.unsupported'), 'error'); return; }
      if (await Notification.requestPermission() !== 'granted') { toast(t('core.notifications.denied'), 'error'); return; }
      notificationsEnabled = true;
      toast(t('core.notifications.on'), 'success');
    }
    btn.classList.toggle('active', notificationsEnabled);
    btn.dataset.i18nTitle = notificationsEnabled ? 'core.notifications.activeTitle' : 'core.notifications.enable';
    window.I18n.apply(btn);
  }

  // ---- export / import: caselle dichiarate dalle estensioni (setting.json → export) ----

  // [{ ext, item }] nell'ordine delle estensioni; item = { id, label, description, sections }
  const exportItems = () => extList
    .filter(e => e.state !== 'disabled')
    .flatMap(e => (e.export || []).map(item => ({ ext: e, item })));

  const checkboxList = (entries, detail) => entries.map(({ ext, item }) => `
    <label class="export-item">
      <input type="checkbox" value="${esc(item.sections.join(','))}" checked>
      <div>
        <div class="export-name">${esc(pick(item.label))} <span class="export-keys">· ${esc(ext.icon ? ext.icon + ' ' : '')}${esc(pick(ext.name))}</span></div>
        <div class="export-keys">${esc(detail(item))}</div>
      </div>
    </label>`).join('');

  const checkedKeys = () => [...new Set([...document.querySelectorAll('.export-list input[type=checkbox]:checked')].flatMap(b => b.value.split(',')))];

  function exportConfig() {
    const entries = exportItems();
    if (!entries.length) { toast(t('core.export.nothing'), 'info'); return; }
    openModal(t('core.export.title'), `
      <div class="export-list">
        <p class="export-hint">${esc(t('core.export.hint'))}</p>
        ${checkboxList(entries, item => pick(item.description) || item.sections.join(', '))}
      </div>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" onclick="Shell.doExport()">↓ ${esc(t('core.export.submit'))}</button>`);
  }

  function doExport() {
    const keys = checkedKeys();
    if (!keys.length) { toast(t('core.export.selectOne'), 'error'); return; }
    const all = !document.querySelector('.export-list input[type=checkbox]:not(:checked)');
    closeModal();
    window.location.href = `/api/core/config/export?name=${all ? 'all' : 'partial'}&sections=${encodeURIComponent(keys.join(','))}`;
  }

  // Import: il file viene letto nel browser, poi si scelgono le estensioni da importare e la modalità
  let pendingImport = null;

  async function importConfig(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const cfg = JSON.parse(await file.text());
      // Caselle dichiarate dalle estensioni di cui il file contiene i dati
      const entries = exportItems().filter(({ item }) => item.sections.some(k => cfg[k] !== undefined));
      if (!entries.length) { toast(t('core.import.nothing'), 'error'); return; }
      pendingImport = cfg;
      const count = k => Array.isArray(cfg[k]) ? ` (${fmt.number(cfg[k].length)})` : '';
      openModal(t('core.import.title'), `
        <div class="export-list">
          <p class="export-hint">${esc(t('core.import.hint', { file: file.name }))}</p>
          ${checkboxList(entries, item => item.sections.filter(k => cfg[k] !== undefined).map(k => k + count(k)).join(', '))}
          <p class="export-hint">${esc(t('core.import.mode'))}</p>
          <label class="export-item"><input type="radio" name="importMode" value="merge" checked>
            <div><div class="export-name">${esc(t('core.import.merge'))}</div><div class="export-keys">${esc(t('core.import.mergeHint'))}</div></div></label>
          <label class="export-item"><input type="radio" name="importMode" value="replace">
            <div><div class="export-name">${esc(t('core.import.replace'))}</div><div class="export-keys">${esc(t('core.import.replaceHint'))}</div></div></label>
        </div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" onclick="Shell.doImport()">↑ ${esc(t('core.import.submit'))}</button>`);
    } catch (e) { toast(t('core.import.error', { error: e.message }), 'error'); }
  }

  async function doImport() {
    const keys = checkedKeys();
    if (!keys.length) { toast(t('core.export.selectOne'), 'error'); return; }
    const mode = document.querySelector('input[name="importMode"]:checked')?.value || 'merge';
    const config = Object.fromEntries(keys.filter(k => pendingImport[k] !== undefined).map(k => [k, pendingImport[k]]));
    try {
      await apiClient('/api/core').post('/config/import', { config, mode });
      closeModal();
      pendingImport = null;
      toast(t(mode === 'replace' ? 'core.import.doneReplace' : 'core.import.doneMerge'), 'success');
      refresh();
    } catch (e) { toast(t('core.import.error', { error: e.message }), 'error'); }
  }

  // ---- lingua: pulsante nell'header (solo con più di una lingua) e cambio senza ricaricare ----
  function renderLanguageButton() {
    const btn = document.getElementById('langBtn');
    if (!btn) return;
    const langs = window.I18n.languages;
    btn.hidden = langs.length < 2;
    btn.querySelector('.lang-code').textContent = window.I18n.lang.toUpperCase();
  }

  function chooseLanguage(event) {
    const r = event.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, window.I18n.languages.map(l => ({
      icon: l.tag === window.I18n.lang ? '●' : '',
      label: l.completeness < 100 ? `${l.nativeName} · ${fmt.number(l.completeness / 100, { style: 'percent' })}` : l.nativeName,
      action: () => window.I18n.setLanguage(l.tag),
    })));
  }

  // Testi creati dalla shell e moduli montati, di nuovo nella lingua attiva
  window.I18n.onChange(() => {
    renderLanguageButton();
    for (const e of exts.values()) {
      const name = pick(e.meta.name);
      const label = e.tab?.querySelector('.section-tab-name');
      if (label) label.textContent = name;
      else if (e.tab) e.tab.title = name;
      if (!e.module || !e.ctx) continue;
      try { (e.module.languageChanged || e.module.refresh)?.call(e.module, e.ctx); } catch (err) { console.error(err); }
    }
  });

  // ---- aggiornamento manuale (pulsante ↻): estensioni montate + sezioni del core ----
  function refresh() {
    for (const e of exts.values()) {
      if (e.module && e.ctx) { try { e.module.refresh?.(e.ctx); } catch (err) { console.error(err); } }
    }
  }

  // ---- navigazione ----
  const has = code => exts.has(code);

  // Mostra l'estensione code (null = nessuna: torna a una sezione del core)
  async function activate(code) {
    if (active === code) return;
    const prev = active && exts.get(active);
    if (prev) {
      prev.panel.style.display = 'none';
      prev.sidebar.style.display = 'none';
      prev.tab?.classList.remove('active-ext');
      try { prev.module?.hide?.(prev.ctx); } catch (e) { console.error(e); }
    }
    active = code;
    // Estensione senza sidebar.html: il pannello occupa tutta la larghezza
    document.querySelector('.app').classList.toggle('no-sidebar', !!code && !exts.get(code).meta.frontend.sidebar);
    if (!code) return;

    const entry = exts.get(code);
    entry.panel.style.display = 'flex';
    entry.sidebar.style.display = '';
    entry.tab?.classList.add('active-ext');
    try {
      await load(entry);
      if (active === code) entry.module?.show?.(entry.ctx);
    } catch { /* errore già mostrato nel pannello */ }
  }

  // Apertura da tab, pulsanti nell'header o altre estensioni
  function open(code) {
    if (exts.has(code)) activate(code);
  }

  // Avvio: estensioni, poi la prima sezione
  (async () => {
    await init();
    const first = firstSection();
    if (first) activate(first);
    else document.querySelector('main.main').innerHTML =
      `<div class="empty-state"><div class="icon">🧩</div><p>${esc(t('core.extensions.none'))}</p></div>`;
  })();

  return { has, activate, open, refresh, toggleNotifications, exportConfig, doExport, importConfig, doImport, chooseLanguage };
})();
