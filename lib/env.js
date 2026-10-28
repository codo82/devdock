// Impostazioni da ambiente (istanze di test, più installazioni). Variabili KELBO_*; le
// DEVDOCK_* di prima della 2.13 valgono ancora (KELBO_* ha la precedenza)
const path = require('path');
const { homeDir } = require('./home');

const env = name => process.env[`KELBO_${name}`] ?? process.env[`DEVDOCK_${name}`];

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(env('PORT')) || 3500;
const CONFIG_PATH = env('CONFIG') || path.join(ROOT, 'config.json');
const EXTENSIONS_DIR = env('EXTENSIONS_DIR') || path.join(ROOT, 'extensions'); // incluse
// Cartella di Kelbo fuori dal repository: estensioni installate, lock file, backup (~/.kelbo;
// la sposta da ~/.devdock migrateHome, chiamata da server e comandi prima di questo modulo)
const HOME = homeDir();
const INSTALLED_DIR = path.join(HOME, 'extensions');

module.exports = { ROOT, PORT, CONFIG_PATH, EXTENSIONS_DIR, HOME, INSTALLED_DIR, env };
