// Impostazioni da ambiente (istanze di test, più installazioni)
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.DEVDOCK_PORT) || 3500;
const CONFIG_PATH = process.env.DEVDOCK_CONFIG || path.join(ROOT, 'config.json');

module.exports = { ROOT, PORT, CONFIG_PATH };
