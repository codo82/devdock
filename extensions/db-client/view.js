// Database: connessioni, vault della master password, editor delle query e risultati

export default {
  async mount(ctx) {
    const info = await ctx.api.get('/info').catch(() => null);
    ctx.sidebar.querySelector('[data-role="connections"]').innerHTML =
      `<p class="db-muted db-pad">${info ? `Driver ${ctx.ui.esc(info.driver)} ${ctx.ui.esc(info.version)}` : 'Driver non disponibile'}</p>`;
  },
};
