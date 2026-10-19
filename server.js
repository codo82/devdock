// DevDock — entry point: middleware di sicurezza, route API, file statici, avvio
const express = require('express');
const path = require('path');
const { ROOT, PORT, CONFIG_PATH } = require('./lib/env');
const { applySecurity } = require('./lib/security');
const { ConfigError } = require('./lib/config');
const { stopAllTunnels } = require('./lib/tunnels');
const { stopAllProcesses } = require('./lib/process');

const app = express();

applySecurity(app);
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

app.use('/api', require('./routes/system'));
app.use('/api', require('./routes/config'));
app.use('/api', require('./routes/tunnels'));
app.use('/api', require('./routes/projects'));
app.use('/api', require('./routes/pm2'));
app.use('/api', require('./routes/git'));

// Errori non gestiti nelle route: le validazioni della config diventano 400 JSON
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof ConfigError) return res.status(400).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON non valido' });
  console.error(err);
  res.status(500).json({ error: err.message || 'Errore interno' });
});

function shutdown(signal) {
  console.log(`\n${signal} — termino tunnel e processi npm...`);
  stopAllTunnels();
  stopAllProcesses();
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP',  () => shutdown('SIGHUP')); // chiusura del terminale

app.listen(PORT, '127.0.0.1', () => {
  console.log(`DevDock → http://127.0.0.1:${PORT}`);
  console.log(`Config: ${CONFIG_PATH}`);
});
