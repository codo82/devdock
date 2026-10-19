// Shell delle estensioni: tab e pulsanti nell'header, pannelli, caricamento lazy di
// view.html / style.css / view.js e contesto (ctx) passato ai moduli frontend.
// Contratto in docs/EXTENSIONS.md.
window.Shell = (() => {
  const { esc, js, cssColor, ansiToHtml, toast, openModal, closeModal, apiClient } = window.UI;

  const exts = new Map();   // code → { meta, panel, sidebar, tab, module, ctx, loading }
  const bus = new EventTarget();
  let active = null;        // code dell'estensione visibile
  window.Ext = window.Ext || {}; // funzioni esposte per gli handler inline (ctx.expose)

  // ---- avvio: crea tab/pulsanti per le estensioni con frontend ----
  async function init() {
    let list = [];
    try { list = await apiClient('/api/core').get('/extensions'); }
    catch (e) { toast('Estensioni non disponibili: ' + e.message, 'error'); return; }

    for (const meta of list) {
      if (meta.state === 'disabled') { console.warn(`[ext:${meta.code}] disattivata: ${meta.error}`); continue; }
      if (!meta.frontend?.js) continue;
      const entry = { meta, panel: createPanel(meta), sidebar: createSidebar(meta), tab: null, module: null, ctx: null, loading: null };
      entry.tab = meta.position === 'header' ? createHeaderButton(meta) : createTab(meta);
      exts.set(meta.code, entry);
    }
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
      <span>${esc(meta.name)}</span>${warningMark(meta)}
      <span class="section-tab-badge" style="display:none"></span>`;
    btn.addEventListener('click', () => open(meta.code));
    document.querySelector('.section-nav').appendChild(btn);
    return btn;
  }

  function createHeaderButton(meta) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost ext-header-btn';
    btn.id = `ext-tab-${meta.code}`;
    btn.title = meta.name;
    btn.style.setProperty('--tab-color', cssColor(meta.color));
    btn.innerHTML = `${esc(meta.icon || meta.name)}${warningMark(meta)}<span class="section-tab-badge" style="display:none"></span>`;
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
    panel.innerHTML = `
      <div class="ext-root"></div>
      <div class="sse-panel">
        <div class="sse-panel-header">
          <span class="sse-title">Output</span>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn-ghost btn-sm" data-sse="clear" title="Pulisci">🗑</button>
            <button class="btn btn-ghost btn-sm" data-sse="close">✕</button>
          </div>
        </div>
        <div class="sse-body"></div>
      </div>`;
    document.querySelector('main.main').appendChild(panel);
    return panel;
  }

  function createSidebar(meta) {
    const sb = document.createElement('div');
    sb.className = 'ext-sidebar';
    sb.id = `ext-sidebar-${meta.code}`;
    sb.style.display = 'none';
    sb.style.setProperty('--ext-color', cssColor(meta.color));
    document.getElementById('sidebar').appendChild(sb);
    return sb;
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
      if (html !== null) root.innerHTML = html;
      if (sidebar !== null) entry.sidebar.innerHTML = sidebar;
      const mod = await import(base + meta.frontend.js);
      entry.module = mod.default || mod;
      entry.ctx = makeContext(entry);
      await entry.module.mount?.(entry.ctx);
    })();
    entry.loading.catch(e => {
      entry.loading = null;
      entry.panel.querySelector('.ext-root').innerHTML =
        `<div class="empty-state"><div class="icon">⚠</div><p>Errore nel caricamento di ${esc(meta.name)}: ${esc(e.message)}</p></div>`;
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
        throw new Error(d.error || `HTTP ${res.status}`);
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
      open(title) { sse.title.textContent = title; sse.body.innerHTML = ''; sse.box.classList.add('open'); },
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
      ui: { esc, js, cssColor, ansiToHtml, toast, openModal, closeModal, output },
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
      open,
      isActive: () => active === meta.code,
    };
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
    document.getElementById('sidebarContent').style.display = code ? 'none' : '';
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

  // Apertura da tab, pulsanti o altre estensioni: passa dalla navigazione del core
  function open(code) {
    window.App?.goSection ? window.App.goSection(code) : activate(code);
  }

  return { init, has, activate, open };
})();
