// Porte in uso: tabella con ricerca, filtro sui processi dell'utente e arresto
// del processo (tramite l'estensione che l'ha avviato, se è di DevDock)

export default {
  mount(ctx) {
    const { esc, js, toast, openModal, closeModal } = ctx.ui;
    const { t } = ctx;
    const $ = role => ctx.root.querySelector(`[data-role="${role}"]`);
    let ports = [];
    let platform = null;

    async function load() {
      try { ({ ports, platform } = await ctx.api.get('/list')); }
      catch (e) { $('content').innerHTML = `<div class="ports-muted">${esc(e.message)}</div>`; return; }
      render();
    }

    const ownerLabel = o => o && o.type !== 'devdock' ? `${t(`owner.${o.type}`)}: ${o.label}` : o ? t('owner.devdock') : '';

    function render() {
      const q = $('search').value.trim().toLowerCase();
      const mine = $('mine').checked;
      const list = ports.filter(p => (!mine || p.own) && (!q || [p.port, p.pid, p.name, p.command, p.owner?.label]
        .some(v => String(v ?? '').toLowerCase().includes(q))));
      $('count').textContent = t('count', { count: list.length });
      $('content').innerHTML = !list.length ? `<div class="ports-muted">${esc(t(ports.length ? 'noMatch' : 'none'))}</div>` : `
        <table class="data-table ports-table">
          <thead><tr><th>${esc(t('col.port'))}</th><th>${esc(t('col.process'))}</th><th>${esc(t('col.pid'))}</th><th>${esc(t('col.user'))}</th><th>${esc(t('col.devdock'))}</th><th>${esc(t('col.command'))}</th><th></th></tr></thead>
          <tbody>${list.map(p => `<tr>
            <td><span class="ports-port">${esc(p.port)}</span> <span class="ports-addr">${esc(p.addresses.join(', '))}</span></td>
            <td>${esc(p.name || '—')}</td>
            <td>${esc(p.pid ?? '—')}</td>
            <td>${esc(p.user || '—')}</td>
            <td>${p.owner ? `<span class="ports-owner">${esc(ownerLabel(p.owner))}</span>` : ''}</td>
            <td><div class="ports-cmd" title="${esc(p.command || '')}">${esc(p.command || '')}</div></td>
            <td>${p.own && p.pid && p.owner?.type !== 'devdock'
              ? `<button class="btn btn-ghost btn-sm" onclick="Ext.ports.askStop(${js(String(p.port))}, ${js(String(p.pid))})">${esc(t('stop'))}</button>` : ''}</td>
          </tr>`).join('')}</tbody>
        </table>`;
    }

    // Conferma con PID e comando; per i processi non avviati da DevDock si può forzare
    function askStop(port, pid) {
      const p = ports.find(x => String(x.port) === port && String(x.pid) === pid);
      if (!p) return;
      openModal(t('confirm.title', { port: p.port }), `
        <p>${esc(t('confirm.text', { name: p.name || '?', pid: String(p.pid), port: String(p.port) }))}</p>
        <pre class="ports-cmd" style="white-space:pre-wrap">${esc(p.command || '')}</pre>
        ${p.owner ? `<p class="ports-muted">${esc(t('confirm.via', { owner: ownerLabel(p.owner) }))}</p>` : ''}
        <p class="ports-muted">${esc(t(platform === 'win32' ? 'confirm.forceHintWin' : 'confirm.forceHint'))}</p>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-danger" onclick="Ext.ports.stop(${js(port)}, ${js(pid)}, true)">${esc(t('forceStop'))}</button>
         <button class="btn btn-primary" onclick="Ext.ports.stop(${js(port)}, ${js(pid)}, false)">${esc(t('stop'))}</button>`);
    }

    async function stop(port, pid, force) {
      closeModal();
      try {
        const r = await ctx.api.post('/stop', { port: Number(port), pid: Number(pid), force });
        if (r.freed) toast(t(`stopped.${r.via}`, { port }) + (r.force ? ` · ${t('forced')}` : ''), 'success');
        // ancora in ascolto: si propone la chiusura forzata
        else if (!r.force && confirm(t('stillListening', { port }))) return stop(port, pid, true);
        else if (r.force) toast(t('stillListeningForced', { port }), 'error');
      } catch (e) { toast(e.message, 'error'); }
      load();
    }

    $('search').addEventListener('input', render);
    $('mine').addEventListener('change', render);
    ctx.root.addEventListener('click', e => { if (e.target.closest('[data-action="refresh"]')) load(); });
    ctx.expose({ askStop, stop });
    this.load = load;
    this.render = render;
  },

  show() { this.load(); },
  refresh() { this.load(); },
  languageChanged() { this.render(); },
};
