// PM2: tabella dei processi con azioni, statistiche nella sidebar e log nel cassetto di output

const STATUS_CLASS = { online: 'online', stopped: 'stopped', errored: 'errored' };

export default {
  mount(ctx) {
    const { esc, js, toast, output } = ctx.ui;
    const content = ctx.root.querySelector('[data-role="content"]');
    let closeLogs = null;

    const stats = ctx.sidebar.querySelector('[data-role="stats"]');

    async function render() {
      const system = await ctx.core.get('/system').catch(() => ({ tools: {} }));
      if (!system.tools.pm2) {
        stats.innerHTML = '';
        ctx.setBadge(null);
        content.innerHTML = `<div class="tool-notice">
          <span>⚠️ PM2 non è installato o non è nel PATH del server.</span>
          <code>npm install -g pm2</code>
          <button class="btn btn-ghost btn-sm" onclick="Ext.pm2.recheck()">Ricontrolla</button>
        </div>`;
        return;
      }

      let list = [];
      try { list = await ctx.api.get('/list'); } catch (e) { toast(e.message, 'error'); }

      const count = s => list.filter(p => p.status === s).length;
      ctx.setBadge(count('online') || null);
      stats.innerHTML = `
        <div class="pm2-stats">
          <div class="pm2-stat"><span>Online</span><span class="ok">${count('online')}</span></div>
          <div class="pm2-stat"><span>Fermi</span><span>${count('stopped')}</span></div>
          ${count('errored') ? `<div class="pm2-stat"><span>Errori</span><span class="ko">${count('errored')}</span></div>` : ''}
        </div>
        <div class="pm2-hint">Clicca il nome per i log</div>`;

      content.innerHTML = !list.length
        ? '<p class="pm2-muted">Nessun processo PM2 attivo.</p>'
        : `<table class="pm2-table">
            <thead><tr><th>ID</th><th>Nome</th><th>Stato</th><th>PID</th><th>CPU</th><th>Mem</th><th>↺</th><th></th></tr></thead>
            <tbody>${list.map(p => `<tr>
              <td class="pm2-dim">${esc(p.id)}</td>
              <td><span class="pm2-name-link" onclick="Ext.pm2.logs(${js(p.name)})">${esc(p.name)}</span></td>
              <td><span class="pm2-status ${STATUS_CLASS[p.status] || 'stopped'}">${esc(p.status || '?')}</span></td>
              <td class="pm2-dim">${esc(p.pid || '—')}</td>
              <td>${p.cpu != null ? esc(p.cpu) + '%' : '—'}</td>
              <td>${p.memory != null ? Math.round(p.memory / 1024 / 1024) + 'MB' : '—'}</td>
              <td>${esc(p.restarts || 0)}</td>
              <td><div class="pm2-actions">
                ${p.status === 'online'
                  ? `<button class="btn btn-ghost btn-sm" onclick="Ext.pm2.action('restart',${js(p.name)})" title="Riavvia">↺</button>
                     <button class="btn btn-ghost btn-sm" onclick="Ext.pm2.action('stop',${js(p.name)})" title="Ferma">⏹</button>
                     <button class="btn btn-ghost btn-sm" onclick="Ext.pm2.logs(${js(p.name)})" title="Log">📋</button>`
                  : `<button class="btn btn-ghost btn-sm pm2-start" onclick="Ext.pm2.action('start',${js(p.name)})" title="Avvia">▶</button>`}
                <button class="btn btn-ghost btn-sm pm2-delete" onclick="Ext.pm2.action('delete',${js(p.name)})" title="Elimina">✕</button>
              </div></td>
            </tr>`).join('')}</tbody>
          </table>`;
    }

    async function action(name, target) {
      if (name === 'delete' && !confirm(`Eliminare il processo PM2 "${target}"?`)) return;
      try {
        await ctx.api.post('/action', { action: name, target });
        toast(`PM2: ${name} ${target}`, 'success');
        await render();
      } catch (e) { toast('PM2 errore: ' + e.message, 'error'); }
    }

    function logs(name) {
      closeLogs?.();
      output.open(name ? `pm2 logs ${name}` : 'pm2 logs (tutti)');
      const q = name ? `?name=${encodeURIComponent(name)}&lines=100` : '?lines=100';
      closeLogs = ctx.api.events('/logs' + q, ({ type, data }) => {
        output.append(data, type === 'stderr' || type === 'error' ? 'err' : type === 'exit' ? 'sys' : 'out');
        if (type === 'exit') { closeLogs?.(); closeLogs = null; }
      }, () => output.append('\nConnessione persa', 'err'));
    }

    async function recheck() {
      await ctx.core.get('/system?refresh=1').catch(() => {});
      toast('Strumenti ricontrollati', 'info');
      await render();
    }

    for (const el of [ctx.root, ctx.sidebar]) {
      el.addEventListener('click', e => {
        const a = e.target.closest('[data-action]')?.dataset.action;
        if (a === 'refresh') render();
        else if (a === 'logs') logs();
      });
    }

    ctx.expose({ action, logs, recheck });
    this.render = render;
    this.stopLogs = () => { closeLogs?.(); closeLogs = null; };
  },

  show() { this.render(); },
  hide() { this.stopLogs(); },
};
