const express = require('express');
const {
  EMPTY_CONFIG, ConfigError, loadConfig, saveConfig,
  pick, normalizeServer, GROUP_FIELDS, PROJECT_FIELDS, getServerMap,
} = require('../lib/config');

const router = express.Router();

router.get('/config', (req, res) => {
  res.json(loadConfig());
});

// Export config come download (type: 'all'|'tunnels'|'git')
router.get('/config/export', (req, res) => {
  const cfg = loadConfig();
  const type = req.query.type || 'all';
  let data;
  let suffix;
  if (type === 'tunnels') {
    data = { groups: cfg.groups || [], servers: cfg.servers || [] };
    suffix = 'tunnels';
  } else if (type === 'git') {
    data = { projects: cfg.projects || [] };
    suffix = 'git';
  } else {
    data = cfg;
    suffix = 'all';
  }
  res.setHeader('Content-Disposition', `attachment; filename="devdock-config-${suffix}-${new Date().toISOString().slice(0,10)}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(data, null, 2));
});

// Import config. Si importano solo le sezioni presenti nel file (groups, servers,
// projects), così anche gli export parziali "Solo tunnel" e "Solo Git/NPM":
//   replace → le sezioni presenti sostituiscono quelle attuali, le altre restano
//   merge   → si aggiungono gli elementi nuovi (stessa chiave = si tiene l'attuale);
//             per i gruppi già esistenti si uniscono le liste di server
router.post('/config/import', (req, res) => {
  try {
    const { config: incoming, mode } = req.body;
    if (mode !== 'replace' && mode !== 'merge') return res.status(400).json({ error: 'Modalità di import non valida' });
    if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'Config non valida' });
    const sections = Object.keys(EMPTY_CONFIG).filter(k => Array.isArray(incoming[k]));
    if (!sections.length) return res.status(400).json({ error: 'Il file non contiene gruppi, server o progetti' });

    const normalize = {
      servers:  list => list.map(normalizeServer),
      groups:   list => list.map(g => pick(g || {}, GROUP_FIELDS)),
      projects: list => list.map(p => pick(p || {}, PROJECT_FIELDS)),
    };
    const idField = { servers: 'key', groups: 'key', projects: 'id' };

    const cfg = loadConfig();
    for (const sec of sections) {
      const items = normalize[sec](incoming[sec]);
      if (mode === 'replace') { cfg[sec] = items; continue; }
      const id = idField[sec];
      for (const item of items) {
        const cur = cfg[sec].find(x => x[id] === item[id]);
        if (!cur) cfg[sec].push(item);
        else if (sec === 'groups' && Array.isArray(item.servers)) {
          item.servers.forEach(sk => { if (!cur.servers.includes(sk)) cur.servers.push(sk); });
        }
      }
    }
    saveConfig(cfg); // valida il risultato (es. gruppi che puntano a server mancanti)
    res.json({ ok: true, sections });
  } catch (e) {
    res.status(e instanceof ConfigError ? 400 : 500).json({ error: e.message });
  }
});

// Salva intera config
router.put('/config', (req, res) => {
  try {
    // Le chiavi non gestite qui (es. dati di estensioni) restano quelle attuali
    const cfg = { ...loadConfig(), ...pick(req.body || {}, Object.keys(EMPTY_CONFIG)) };
    saveConfig(cfg);
    res.json({ ok: true });
  } catch (e) {
    res.status(e instanceof ConfigError ? 400 : 500).json({ error: e.message });
  }
});

// Gruppo — crea
router.post('/config/groups', (req, res) => {
  const cfg = loadConfig();
  const { key, label, color } = req.body;
  if (!key || !label) return res.status(400).json({ error: 'key e label obbligatori' });
  if (cfg.groups.find(g => g.key === key)) return res.status(409).json({ error: 'Chiave già esistente' });
  cfg.groups.push({ key, label, color: color || '#6b7280', servers: [] }); // validato da saveConfig
  saveConfig(cfg);
  res.json({ ok: true });
});

// Gruppo — aggiorna
router.put('/config/groups/:key', (req, res) => {
  const cfg = loadConfig();
  const idx = cfg.groups.findIndex(g => g.key === req.params.key);
  if (idx === -1) return res.status(404).json({ error: 'Gruppo non trovato' });
  cfg.groups[idx] = { ...cfg.groups[idx], ...pick(req.body, ['label', 'color', 'servers']) };
  saveConfig(cfg);
  res.json({ ok: true });
});

// Gruppo — elimina
router.delete('/config/groups/:key', (req, res) => {
  const cfg = loadConfig();
  cfg.groups = cfg.groups.filter(g => g.key !== req.params.key);
  saveConfig(cfg);
  res.json({ ok: true });
});

// Server — crea
router.post('/config/servers', (req, res) => {
  const cfg = loadConfig();
  const { key, label, port, remote, alias, type, groupKey } = req.body;
  if (!key || !label || !port || !remote || !alias) return res.status(400).json({ error: 'Campi obbligatori mancanti' });
  if (cfg.servers.find(s => s.key === key)) return res.status(409).json({ error: 'Chiave già esistente' });
  cfg.servers.push(normalizeServer({ key, label, port, remote, alias, type: type || 'TCP' }));
  if (groupKey) {
    const g = cfg.groups.find(g => g.key === groupKey);
    if (g) g.servers.push(key);
  }
  saveConfig(cfg);
  res.json({ ok: true });
});

// Server — aggiorna
router.put('/config/servers/:key', (req, res) => {
  const cfg = loadConfig();
  const idx = cfg.servers.findIndex(s => s.key === req.params.key);
  if (idx === -1) return res.status(404).json({ error: 'Server non trovato' });
  cfg.servers[idx] = { ...cfg.servers[idx], ...normalizeServer(pick(req.body, ['label', 'port', 'remote', 'alias', 'type'])) };
  saveConfig(cfg);
  res.json({ ok: true });
});

// Server — elimina
router.delete('/config/servers/:key', (req, res) => {
  const cfg = loadConfig();
  cfg.servers = cfg.servers.filter(s => s.key !== req.params.key);
  cfg.groups.forEach(g => { g.servers = g.servers.filter(sk => sk !== req.params.key); });
  saveConfig(cfg);
  res.json({ ok: true });
});

// Sposta server tra gruppi / riordina
router.put('/config/groups/:key/servers', (req, res) => {
  const cfg = loadConfig();
  const g = cfg.groups.find(g => g.key === req.params.key);
  if (!g) return res.status(404).json({ error: 'Gruppo non trovato' });
  g.servers = req.body.servers;
  saveConfig(cfg);
  res.json({ ok: true });
});

// Gruppi con i server risolti, per la UI principale
router.get('/groups', (req, res) => {
  const cfg = loadConfig();
  const serverMap = getServerMap(cfg);
  const result = cfg.groups.map(g => ({
    key: g.key,
    label: g.label,
    color: g.color,
    servers: g.servers.map(sk => serverMap[sk]).filter(Boolean),
  }));
  res.json(result);
});

module.exports = router;
