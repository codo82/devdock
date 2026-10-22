// API del core: estensioni caricate e strumenti di sistema
const express = require('express');
const path = require('path');
const { ROOT } = require('../lib/env');
const { SOURCE_LANG, languages } = require('../lib/i18n');
const { getTools, refreshTools } = require('../lib/system');
const { ConfigError, listSections, exportConfig, importConfig } = require('../lib/config');
const { errorBody } = require('../lib/errors');
const projects = require('../lib/projects');

const NAME_RE = /^[a-z0-9-]{1,40}$/;

module.exports = function coreRoutes(extensions) {
  const router = express.Router();

  router.get('/extensions', (req, res) => {
    res.json(extensions.list());
  });

  // Lingue dai cataloghi del core, con la completezza (core + estensioni attive)
  router.get('/i18n/languages', (req, res) => {
    const extCatalogs = extensions.extensions
      .filter(e => e.state !== 'disabled' && e.i18n.length)
      .map(e => ({ code: e.manifest.code, dir: path.join(e.dir, 'i18n') }));
    res.json({ source: SOURCE_LANG, languages: languages(path.join(ROOT, 'public/core/i18n'), extCatalogs) });
  });

  // Server MCP: endpoint, token e strumenti (per il pannello MCP)
  router.get('/mcp', (req, res) => {
    const { getToken } = require('../lib/mcp');
    const { PORT } = require('../lib/env');
    res.json({
      url: `http://127.0.0.1:${PORT}/mcp`,
      token: getToken(),
      tools: extensions.mcpTools().map(t => ({ name: t.name, extension: t.extension, description: t.description, readOnly: t.readOnly })),
    });
  });
  router.post('/mcp/token', (req, res) => {
    res.json({ token: require('../lib/mcp').regenerateToken() });
  });

  // Progetti e cartelle della sidebar (condivisi da npm, git, env…)
  router.get('/projects', (req, res) => {
    res.json({ folders: projects.folders(), projects: projects.list() });
  });
  router.post('/projects', (req, res) => { res.json(projects.createProject(req.body)); });
  router.put('/projects/:id', (req, res) => { res.json(projects.updateProject(req.params.id, req.body)); });
  router.delete('/projects/:id', (req, res) => { projects.deleteProject(req.params.id); res.json({ ok: true }); });
  router.post('/folders', (req, res) => { res.json(projects.createFolder(req.body)); });
  router.put('/folders/:id', (req, res) => { res.json(projects.updateFolder(req.params.id, req.body)); });
  router.delete('/folders/:id', (req, res) => { projects.deleteFolder(req.params.id); res.json({ ok: true }); });

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
      if (!(e instanceof ConfigError)) throw e;
      res.status(400).json(errorBody(e));
    }
  });

  return router;
};
