// Pannello del server MCP: endpoint, token (mostra, copia, rigenera), configurazione
// pronta per Claude Code e Claude Desktop, strumenti delle estensioni.

export default {
  mount(ctx) {
    const { esc, js, toast } = ctx.ui;
    const { t } = ctx;
    const content = ctx.root.querySelector('[data-role="content"]');
    let data = null;
    let showToken = false;

    const names = new Map(); // codice → icona e nome dell'estensione

    async function load() {
      try {
        const [mcp, exts] = await Promise.all([ctx.core.get('/mcp'), ctx.core.get('/extensions')]);
        data = mcp;
        for (const e of exts) names.set(e.code, `${e.icon ? e.icon + ' ' : ''}${ctx.i18n.pick(e.name)}`);
        render();
      } catch (e) { content.innerHTML = `<div class="mcp-muted">${esc(e.message)}</div>`; }
    }

    // Comandi di configurazione con il token
    const snippets = () => {
      const auth = `Bearer ${data.token}`;
      return {
        claudeCode: `claude mcp add --transport http devdock ${data.url} --header "Authorization: ${auth}"`,
        desktop: JSON.stringify({ mcpServers: { devdock: { command: 'npx', args: ['-y', 'mcp-remote', data.url, '--header', `Authorization:${auth}`] } } }, null, 2),
      };
    };
    const masked = () => showToken ? data.token : `${data.token.slice(0, 6)}${'•'.repeat(20)}`;

    function render() {
      if (!data) return;
      const sn = snippets();
      const block = (id, text, shown = text) => `<div class="mcp-row"><pre class="mcp-code">${esc(shown)}</pre>
        <button class="btn btn-ghost btn-sm" onclick="Ext.mcp.copy(${js(id)})">${esc(t('copy'))}</button></div>`;
      const hide = s => showToken ? s : s.split(data.token).join(masked());
      const byExt = new Map();
      for (const tool of data.tools) byExt.set(tool.extension, [...(byExt.get(tool.extension) || []), tool]);
      content.innerHTML = `
        <div class="mcp-section">
          <h4>${esc(t('endpoint'))}</h4>
          ${block('url', data.url)}
          <h4>${esc(t('token'))}</h4>
          <div class="mcp-row"><pre class="mcp-code">${esc(masked())}</pre>
            <button class="btn btn-ghost btn-sm" onclick="Ext.mcp.toggle()">${esc(t(showToken ? 'hide' : 'show'))}</button>
            <button class="btn btn-ghost btn-sm" onclick="Ext.mcp.copy('token')">${esc(t('copy'))}</button>
            <button class="btn btn-ghost btn-sm" onclick="Ext.mcp.regenerate()">${esc(t('regenerate'))}</button></div>
          <p class="mcp-muted">${esc(t('tokenHint'))}</p>
        </div>
        <div class="mcp-section">
          <h4>${esc(t('claudeCode'))}</h4>
          ${block('claudeCode', sn.claudeCode, hide(sn.claudeCode))}
          <h4>${esc(t('claudeDesktop'))}</h4>
          <p class="mcp-muted">${esc(t('claudeDesktopHint'))}</p>
          ${block('desktop', sn.desktop, hide(sn.desktop))}
          <p class="mcp-muted">${esc(t('otherClients'))}</p>
        </div>
        <div class="mcp-section">
          <h4>${esc(t('tools', { count: data.tools.length }))}</h4>
          <p class="mcp-muted">${esc(t('toolsHint'))}</p>
          <div class="mcp-tools">${[...byExt].map(([ext, tools]) => `
            <div class="mcp-ext">${esc(names.get(ext) || ext)}</div>
            ${tools.map(tool => `<div class="mcp-tool-name">${esc(tool.name)}<span class="mcp-badge ${tool.readOnly ? '' : 'write'}">${esc(t(tool.readOnly ? 'read' : 'write'))}</span></div>
              <div class="mcp-muted">${esc(tool.description)}</div>`).join('')}`).join('')}
          </div>
        </div>`;
    }

    ctx.expose({
      toggle() { showToken = !showToken; render(); },
      async copy(what) {
        const sn = snippets();
        const text = { url: data.url, token: data.token, claudeCode: sn.claudeCode, desktop: sn.desktop }[what];
        try { await navigator.clipboard.writeText(text); toast(t('copied'), 'success'); }
        catch { toast(t('copyFailed'), 'error'); }
      },
      async regenerate() {
        if (!confirm(t('confirmRegenerate'))) return;
        try {
          data.token = (await ctx.core.post('/mcp/token')).token;
          toast(t('regenerated'), 'success');
          render();
        } catch (e) { toast(e.message, 'error'); }
      },
    });
    this.load = load;
    this.render = render;
  },

  show() { this.load(); },
  refresh() { this.load(); },
  languageChanged() { this.render(); },
};
