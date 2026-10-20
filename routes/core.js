// API del core: estensioni caricate e strumenti di sistema
const express = require('express');
const { getTools, refreshTools } = require('../lib/system');
const { ConfigError, listSections, exportConfig, importConfig } = require('../lib/config');

const NAME_RE = /^[a-z0-9-]{1,40}$/;

module.exports = function coreRoutes(extensions) {
  const router = express.Router();

  router.get('/extensions', (req, res) => {
    res.json(extensions.list());
  });

  // ?refresh=1 ricontrolla gli strumenti (es. dopo un'installazione)
  router.get('/system', (req, res) => {
    if (req.query.refresh) refreshTools();
    res.json({ platform: process.platform, tools: getTools() });
  });

  // Sezioni di config.json con il loro proprietario (core o codice dell'estensione)
  router.get('/config/sections', (req, res) => {
    res.json(listSections());
  });

  // Export come download. ?sections=a,b limita alle sezioni indicate; ?name= per il nome file
  router.get('/config/export', (req, res) => {
    const keys = req.query.sections ? String(req.query.sections).split(',').filter(Boolean) : null;
    const name = NAME_RE.test(req.query.name || '') ? req.query.name : 'all';
    res.setHeader('Content-Disposition', `attachment; filename="devdock-config-${name}-${new Date().toISOString().slice(0, 10)}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(exportConfig(keys), null, 2));
  });

  // Import: { config, mode: 'replace' | 'merge' } — solo le sezioni presenti nel file
  router.post('/config/import', (req, res) => {
    try {
      res.json({ ok: true, ...importConfig(req.body?.config, req.body?.mode) });
    } catch (e) {
      res.status(e instanceof ConfigError ? 400 : 500).json({ error: e.message });
    }
  });

  // ---- Export/import forniti dalle estensioni (setting.json → transfer) ----

  router.get('/transfers', (req, res) => {
    res.json(extensions.list()
      .filter(e => e.state !== 'disabled' && e.transfer.length)
      .flatMap(e => e.transfer.map(t => ({ ...t, code: e.code, extension: e.name }))));
  });

  // Il backend restituisce una stringa (o un oggetto, salvato come JSON)
  router.get('/transfers/:code/:id/export', async (req, res, next) => {
    const t = extensions.transfer(req.params.code, req.params.id, 'export');
    if (!t) return res.status(404).json({ error: 'Export non disponibile' });
    try {
      const out = await t.fn();
      const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
      const filename = t.entry.filename || `devdock-${req.params.code}-${req.params.id}.${typeof out === 'string' ? 'txt' : 'json'}`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', typeof out === 'string' ? 'text/plain; charset=utf-8' : 'application/json');
      res.send(text);
    } catch (e) { next(e); }
  });

  // Il contenuto del file arriva come testo: { content }; il backend restituisce un messaggio
  router.post('/transfers/:code/:id/import', async (req, res, next) => {
    const t = extensions.transfer(req.params.code, req.params.id, 'import');
    if (!t) return res.status(404).json({ error: 'Import non disponibile' });
    const content = req.body?.content;
    if (typeof content !== 'string') return res.status(400).json({ error: 'Contenuto del file mancante' });
    try {
      res.json({ ok: true, message: (await t.fn(content)) || 'Import completato' });
    } catch (e) {
      if (e instanceof ConfigError) return res.status(400).json({ error: e.message });
      next(e);
    }
  });

  return router;
};
