const express = require('express');
const { getTools, refreshTools } = require('../lib/system');

const router = express.Router();

// Stato degli strumenti per la UI (?refresh=1 li ricontrolla, es. dopo un'installazione)
router.get('/system', (req, res) => {
  if (req.query.refresh) refreshTools();
  res.json({ platform: process.platform, tools: getTools() });
});

module.exports = router;
