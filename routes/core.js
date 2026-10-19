// API del core: estensioni caricate e strumenti di sistema
const express = require('express');
const { getTools, refreshTools } = require('../lib/system');

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

  return router;
};
