// Disposizione della shell scelta dall'utente: sezione "layout" di config.json, del core.
// layout.tabs: codici delle estensioni nell'ordine delle tab; quelle non in lista (nuove)
// vanno dopo, nell'ordine dei manifest; i codici di estensioni rimosse sono ignorati.
const { registerSection, loadConfig, saveConfig } = require('./config');
const { coreError } = require('./errors');

const CODE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_TABS = 100;

function validateLayout(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw coreError.config('layout_invalid');
  if (v.tabs !== undefined) {
    if (!Array.isArray(v.tabs) || v.tabs.length > MAX_TABS || !v.tabs.every(c => typeof c === 'string' && CODE_RE.test(c))
        || new Set(v.tabs).size !== v.tabs.length) throw coreError.config('layout_tabs');
  }
}

// solo i campi noti
const normalize = v => (v && typeof v === 'object' && !Array.isArray(v) ? (Array.isArray(v.tabs) ? { tabs: v.tabs } : {}) : v);

registerSection('layout', { owner: 'core', empty: {}, validate: validateLayout, normalize });

const get = () => ({ tabs: loadConfig().layout.tabs || [] });

// tabs: ordine scelto; known: codici delle tab esistenti (gli altri vengono scartati)
function setTabs(tabs, known) {
  if (!Array.isArray(tabs) || !tabs.every(c => typeof c === 'string')) throw coreError(400, 'layout_tabs');
  const list = [...new Set(tabs)].filter(c => known.includes(c));
  const cfg = loadConfig();
  cfg.layout = { ...cfg.layout, tabs: list };
  saveConfig(cfg);
  return { tabs: list };
}

// Ordine predefinito: quello dei manifest
function resetTabs() {
  const cfg = loadConfig();
  const { tabs, ...rest } = cfg.layout;
  cfg.layout = rest;
  saveConfig(cfg);
  return { tabs: [] };
}

module.exports = { get, setTabs, resetTabs };
