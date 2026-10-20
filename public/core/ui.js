// Helper condivisi della UI (core e estensioni): escape, colori, ANSI, toast, modal, API.
// Le traduzioni sono in i18n.js (UI.t e UI.fmt rimandano lì).
window.UI = (() => {
  // ---- UTILS ----
  function esc(t) {
    return String(t ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // Argomento stringa per un handler inline (onclick="Ext.code.fn(${js(x)})"): esc() da solo
  // non basta, il browser decodifica &#39; in ' prima di eseguire il JS
  function js(v) {
    return esc(JSON.stringify(String(v ?? '')));
  }

  // Colore sicuro da usare in style="" (i valori arrivano da config importabili)
  function cssColor(c) {
    return /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#6b7280';
  }

  // ---- ANSI → HTML ----
  function ansiToHtml(text) {
    const SGR_MAP = {
      0:null, 1:'ansi-bold',2:'ansi-dim',3:'ansi-italic',4:'ansi-underline',
      30:'ansi-black',31:'ansi-red',32:'ansi-green',33:'ansi-yellow',
      34:'ansi-blue',35:'ansi-magenta',36:'ansi-cyan',37:'ansi-white',
      90:'ansi-bright-black',91:'ansi-bright-red',92:'ansi-bright-green',
      93:'ansi-bright-yellow',94:'ansi-bright-blue',95:'ansi-bright-magenta',
      96:'ansi-bright-cyan',97:'ansi-bright-white',
      40:'ansi-bg-black',41:'ansi-bg-red',42:'ansi-bg-green',43:'ansi-bg-yellow',
      44:'ansi-bg-blue',45:'ansi-bg-magenta',46:'ansi-bg-cyan',47:'ansi-bg-white',
    };
    let result='', activeClasses=[], i=0;
    function flushText(raw) {
      if (!raw) return;
      const safe = raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      result += activeClasses.length===0 ? safe : `<span class="${activeClasses.join(' ')}">${safe}</span>`;
    }
    while (i < text.length) {
      const esc = text.indexOf('\x1b[', i);
      if (esc === -1) { flushText(text.slice(i)); break; }
      flushText(text.slice(i, esc));
      const end = text.indexOf('m', esc);
      if (end === -1) { i = esc+1; continue; }
      const codes = text.slice(esc+2, end).split(';').map(Number);
      i = end+1;
      const newClasses=[];
      for (const code of codes) {
        if (code===0) activeClasses=[];
        else if (SGR_MAP[code]) newClasses.push(SGR_MAP[code]);
      }
      if (newClasses.length) activeClasses=[...activeClasses.filter(c=>!c.startsWith('ansi-bg')||newClasses.some(n=>n.startsWith('ansi-bg'))),...newClasses.filter(n=>!activeClasses.includes(n))];
    }
    return result;
  }

  // ---- TOAST ----
  function toast(msg, type='info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3000);
  }

  // ---- MODAL ----
  function openModal(title, bodyHtml, footerHtml) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHtml;
    document.getElementById('modalFooter').innerHTML = footerHtml;
    document.getElementById('modalOverlay').classList.add('open');
  }
  function closeModal() {
    document.getElementById('modalOverlay').classList.remove('open');
  }

  // Client JSON per un prefisso di API (es. '/api/ext/git'); gli errori diventano Error con il messaggio del server
  function apiClient(base = '') {
    const parse = async r => {
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      if (!r.ok) throw Object.assign(new Error(data?.error || text || `HTTP ${r.status}`), { status: r.status, data });
      return data;
    };
    const send = (method, p, body) => fetch(base + p, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(parse);
    return {
      get: p => send('GET', p),
      post: (p, b = {}) => send('POST', p, b),
      put: (p, b = {}) => send('PUT', p, b),
      del: p => send('DELETE', p),
      url: p => base + p,
    };
  }

  // Tempo trascorso da una data ISO, nella lingua attiva ("42 s", "5 min 3 s", "2 h 10 min")
  function formatUptime(startedAt) {
    if (!startedAt) return '—';
    return I18n.fmt.duration((Date.now() - new Date(startedAt)) / 1000);
  }

  // Gli elementi con data-uptime="<ISO>" si aggiornano da soli ogni secondo
  setInterval(() => {
    document.querySelectorAll('[data-uptime]').forEach(el => { el.textContent = formatUptime(el.dataset.uptime); });
  }, 1000);

  // Avviso per uno strumento esterno mancante; recheck è l'handler inline del pulsante (es. "Ext.pm2.recheck()")
  function toolNotice(message, installCmd, recheck) {
    return `<div class="tool-notice">
      <span>⚠️ ${esc(message)}</span>
      ${installCmd ? `<code>${esc(installCmd)}</code>` : ''}
      ${recheck ? `<button class="btn btn-ghost btn-sm" onclick="${esc(recheck)}">${esc(I18n.t('core.tools.recheck'))}</button>` : ''}
    </div>`;
  }

  // Menu contestuale alle coordinate x,y. items: [{ label, icon?, action, danger?, disabled? } | 'separator']
  let menuEl = null;
  function closeContextMenu() { menuEl?.remove(); menuEl = null; }
  function contextMenu(x, y, items) {
    closeContextMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'ctx-menu';
    menuEl.setAttribute('role', 'menu');
    for (const it of items) {
      if (it === 'separator') { menuEl.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' })); continue; }
      const b = document.createElement('button');
      b.className = 'ctx-item' + (it.danger ? ' danger' : '');
      b.disabled = !!it.disabled;
      b.setAttribute('role', 'menuitem');
      b.innerHTML = `<span class="ctx-icon">${esc(it.icon || '')}</span>${esc(it.label)}`;
      b.addEventListener('click', () => { closeContextMenu(); it.action(); });
      menuEl.appendChild(b);
    }
    document.body.appendChild(menuEl);
    // dentro la finestra
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    menuEl.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
    menuEl.querySelector('.ctx-item:not(:disabled)')?.focus();
  }
  document.addEventListener('mousedown', e => { if (menuEl && !menuEl.contains(e.target)) closeContextMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeContextMenu(); });
  window.addEventListener('blur', closeContextMenu);

  // click fuori dal modal lo chiude
  document.getElementById('modalOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });

  return { t: I18n.t, fmt: I18n.fmt, esc, js, cssColor, ansiToHtml, toast, openModal, closeModal, apiClient, formatUptime, toolNotice, contextMenu, closeContextMenu };
})();
