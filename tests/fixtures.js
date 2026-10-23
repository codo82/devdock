// Estensioni di prova per i test del core: nessuna dipendenza dalle estensioni incluse,
// così togliere una di quelle lascia verde la suite del core.
const { tmpDir, writeExtension, manifest } = require('../lib/testkit');

// "sample": sezioni items/links (links punta a items), casella di export, strumenti MCP;
// "second", "third": tab senza backend; "panel": pulsante dell'header
function sampleExtensions() {
  const root = tmpDir('devdock-fixtures-');
  writeExtension(root, 'sample', {
    'setting.json': manifest('sample', {
      order: 10, config: ['items', 'links'],
      export: [{ id: 'all', label: 'Sample', sections: ['items', 'links'] }],
      backend: { module: 'server.js', routes: [{ method: 'GET', path: '/items', handler: 'items' }] },
      mcp: { tools: [
        { name: 'items', handler: 'items', description: 'Items of the sample extension' },
        { name: 'touch', handler: 'touch', readOnly: false, description: 'Changes something', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      ] },
      frontend: { js: 'view.js' },
    }),
    'server.js': `module.exports = ctx => ({
      handlers: { items: (req, res) => res.json(ctx.config.get('items')) },
      config: {
        items: { empty: [], idField: 'id', validate(list) { if (!Array.isArray(list) || list.some(x => typeof x?.id !== 'string')) throw ctx.lib.config.ConfigError ? new ctx.lib.config.ConfigError('items non validi') : new Error('x'); } },
        links: { empty: [], idField: 'id', validate(list, cfg) {
          for (const l of list) if (!(cfg.items || []).some(i => i.id === l.item)) throw new ctx.lib.config.ConfigError('link verso un item mancante');
        } },
      },
      mcp: {
        items: () => ({ items: ctx.config.get('items') }),
        touch: ({ id }) => { if (id === 'nope') throw ctx.error(404, 'not_found', { id }); return { touched: id }; },
      },
    });`,
    'view.js': 'export default { mount() {} };',
    'i18n/it.json': { 'errors.not_found': 'Non trovato: {id}' },
  });
  writeExtension(root, 'second', { 'setting.json': manifest('second', { order: 20, frontend: { js: 'view.js' } }), 'view.js': 'export default { mount() {} };' });
  writeExtension(root, 'third', { 'setting.json': manifest('third', { order: 30, frontend: { js: 'view.js' } }), 'view.js': 'export default { mount() {} };' });
  writeExtension(root, 'panel', { 'setting.json': manifest('panel', { position: 'header', frontend: { js: 'view.js' } }), 'view.js': 'export default { mount() {} };' });
  return root;
}

module.exports = { sampleExtensions };
