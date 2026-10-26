// Impostazioni da ambiente (istanze di test, più installazioni)
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.DEVDOCK_PORT) || 3500;
const CONFIG_PATH = process.env.DEVDOCK_CONFIG || path.join(ROOT, 'config.json');
const EXTENSIONS_DIR = process.env.DEVDOCK_EXTENSIONS_DIR || path.join(ROOT, 'extensions'); // incluse
// Cartella di Kelbo fuori dal repository: estensioni installate, lock file, backup
const HOME = process.env.DEVDOCK_HOME || path.join(os.homedir(), '.devdock');
const INSTALLED_DIR = path.join(HOME, 'extensions');

module.exports = { ROOT, PORT, CONFIG_PATH, EXTENSIONS_DIR, HOME, INSTALLED_DIR };
