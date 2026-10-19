// Tunnel SSH: port forwarding -L con ssh o autossh, riconnessione con backoff,
// gruppi e server salvati nelle sezioni "groups" e "servers" di config.json
const { spawn } = require('child_process');
const crypto = require('crypto');

const RECONNECT_INITIAL_DELAY = 5000;   // 5s primo tentativo
const RECONNECT_MAX_DELAY     = 60000;  // max 60s tra un tentativo e l'altro
const RECONNECT_BACKOFF       = 1.5;    // moltiplicatore backoff

const SERVER_FIELDS = ['key', 'label', 'port', 'remote', 'alias', 'type'];
const GROUP_FIELDS  = ['key', 'label', 'color', 'servers'];

module.exports = function createTunnels(ctx) {
  const { ConfigError, pick } = ctx.lib.config;
  const { KEY_RE, COLOR_RE, REMOTE_RE, ALIAS_RE, isPort, isText } = ctx.lib.validate;
  const { hasCommand } = ctx.lib.system;

  const active = new Map(); // id → { serverKey, label, port, remote, alias, type, pid, process, logs, stopping, reconnectDelay, reconnectTimer }

  // ---- config ----

  const groups  = () => ctx.config.get('groups');
  const servers = () => ctx.config.get('servers');

  // Salva entrambe le sezioni insieme (i gruppi fanno riferimento ai server)
  function save(nextGroups, nextServers) {
    if (nextServers) ctx.config.set('servers', nextServers);
    if (nextGroups) ctx.config.set('groups', nextGroups);
  }

  function normalizeServer(srv) {
    const out = pick(srv || {}, SERVER_FIELDS);
    if (out.port !== undefined) out.port = Number(out.port);
    return out;
  }

  function validateServer(srv) {
    const where = `server "${srv?.key}"`;
    if (!srv || typeof srv !== 'object') throw new ConfigError('Server non valido');
    if (!KEY_RE.test(srv.key || '')) throw new ConfigError(`${where}: chiave non valida (lettere, numeri, _ e -)`);
    if (!isText(srv.label)) throw new ConfigError(`${where}: nome obbligatorio`);
    if (!isPort(srv.port)) throw new ConfigError(`${where}: porta locale non valida (1-65535)`);
    const m = REMOTE_RE.exec(srv.remote || '');
    if (!m || !isPort(Number(m[2]))) throw new ConfigError(`${where}: remote non valido (formato host:porta)`);
    if (!ALIAS_RE.test(srv.alias || '')) throw new ConfigError(`${where}: alias SSH non valido`);
    if (srv.type != null && !isText(srv.type, 40)) throw new ConfigError(`${where}: tipo non valido`);
  }

  function validateGroup(g, serverKeys) {
    const where = `gruppo "${g?.key}"`;
    if (!g || typeof g !== 'object') throw new ConfigError('Gruppo non valido');
    if (!KEY_RE.test(g.key || '')) throw new ConfigError(`${where}: chiave non valida (lettere, numeri, _ e -)`);
    if (!isText(g.label)) throw new ConfigError(`${where}: nome obbligatorio`);
    if (!COLOR_RE.test(g.color || '')) throw new ConfigError(`${where}: colore non valido (#rrggbb)`);
    if (!Array.isArray(g.servers)) throw new ConfigError(`${where}: lista server non valida`);
    const missing = g.servers.filter(k => !serverKeys.has(k));
    if (missing.length) throw new ConfigError(`${where}: server inesistenti ${missing.join(', ')}`);
  }

  function assertList(value, key) {
    if (!Array.isArray(value)) throw new ConfigError(`Config non valida: "${key}" deve essere una lista`);
  }

  function assertUnique(list, field, what) {
    const seen = new Set();
    for (const x of list) {
      if (seen.has(x[field])) throw new ConfigError(`${what} duplicato: ${x[field]}`);
      seen.add(x[field]);
    }
  }

  const config = {
    servers: {
      empty: [], idField: 'key',
      normalize: v => (Array.isArray(v) ? v.map(normalizeServer) : v),
      validate(list) {
        assertList(list, 'servers');
        list.forEach(validateServer);
        assertUnique(list, 'key', 'Server');
      },
    },
    groups: {
      empty: [], idField: 'key',
      normalize: v => (Array.isArray(v) ? v.map(g => pick(g || {}, GROUP_FIELDS)) : v),
      validate(list, cfg) {
        assertList(list, 'groups');
        const serverKeys = new Set((cfg.servers || []).map(s => s.key));
        list.forEach(g => validateGroup(g, serverKeys));
        assertUnique(list, 'key', 'Gruppo');
      },
      // Gruppi già esistenti: si uniscono le liste di server
      merge(current, incoming) {
        const out = current.map(g => ({ ...g, servers: [...g.servers] }));
        for (const g of incoming) {
          const cur = out.find(x => x.key === g.key);
          if (!cur) out.push(g);
          else if (Array.isArray(g.servers)) g.servers.forEach(sk => { if (!cur.servers.includes(sk)) cur.servers.push(sk); });
        }
        return out;
      },
    },
  };

  // ---- tunnel ----

  function publicTunnel(id, t) {
    return {
      id, serverKey: t.serverKey, label: t.label, port: t.port,
      remote: t.remote, alias: t.alias, type: t.type,
      pid: t.pid, startedAt: t.startedAt,
      reconnecting: !!t.reconnectTimer,
    };
  }

  function spawnTunnel(id, sshArgs, useAuto) {
    const td = active.get(id);
    if (!td || td.stopping) return;

    const proc = useAuto ? spawn('autossh', ['-M', '0', ...sshArgs]) : spawn('ssh', sshArgs);
    td.process = proc;
    td.pid = proc.pid;

    const log = text => {
      td.logs.push({ ts: Date.now(), text });
      if (td.logs.length > 200) td.logs.splice(0, td.logs.length - 200);
    };

    log(`Connessione a ${td.alias} → 127.0.0.1:${td.port} ↔ ${td.remote} [${useAuto ? 'autossh' : 'ssh'}, pid ${proc.pid}]`);
    proc.stdout.on('data', d => log(d.toString()));
    proc.stderr.on('data', d => log(d.toString()));
    proc.on('error', err => log(`Errore spawn: ${err.message}`));

    proc.on('close', code => {
      const t = active.get(id);
      if (!t) return; // già rimosso manualmente
      if (t.stopping) { active.delete(id); return; }
      const delay = Math.min(t.reconnectDelay, RECONNECT_MAX_DELAY);
      log(`Tunnel chiuso (exit ${code}). Riconnessione tra ${Math.round(delay / 1000)}s...`);
      t.reconnectDelay = Math.round(delay * RECONNECT_BACKOFF);
      t.reconnectTimer = setTimeout(() => {
        const cur = active.get(id);
        if (!cur || cur.stopping) return;
        cur.reconnectTimer = null;
        spawnTunnel(id, sshArgs, useAuto);
      }, delay);
    });
  }

  function stop(t) {
    t.stopping = true;
    if (t.reconnectTimer) clearTimeout(t.reconnectTimer);
    try { t.process && t.process.kill('SIGTERM'); } catch {}
  }

  function stopAllTunnels() {
    for (const [, t] of active) stop(t);
    active.clear();
  }

  const notFound = (res, what) => res.status(404).json({ error: `${what} non trovato` });

  return {
    config,

    handlers: {
      // Stato completo per la UI: gruppi (con i server risolti), server e tunnel attivi
      state(req, res) {
        const srvList = servers();
        const byKey = new Map(srvList.map(s => [s.key, s]));
        res.json({
          groups: groups().map(g => ({ ...g, servers: g.servers.map(k => byKey.get(k)).filter(Boolean) })),
          servers: srvList,
          tunnels: [...active].map(([id, t]) => publicTunnel(id, t)),
        });
      },

      startTunnel(req, res) {
        const { serverKey, port: customPort } = req.body;
        const srv = servers().find(s => s.key === serverKey);
        if (!srv) return res.status(400).json({ error: 'Server non trovato' });

        const localPort = customPort == null || customPort === '' ? srv.port : Number(customPort);
        if (!isPort(localPort)) return res.status(400).json({ error: 'Porta locale non valida (1-65535)' });
        for (const [, t] of active) {
          if (t.port === localPort) return res.status(409).json({ error: `Porta ${localPort} già in uso da "${t.label}"` });
        }

        const id = crypto.randomUUID();
        const sshArgs = [
          '-o', 'ServerAliveInterval=15',
          '-o', 'ServerAliveCountMax=3',
          '-o', 'ExitOnForwardFailure=yes',
          '-o', 'TCPKeepAlive=yes',
          '-L', `127.0.0.1:${localPort}:${srv.remote}`,
          '-N', srv.alias,
        ];
        const td = {
          serverKey, label: srv.label, port: localPort,
          remote: srv.remote, alias: srv.alias, type: srv.type,
          pid: null, process: null,
          startedAt: new Date().toISOString(),
          logs: [], stopping: false,
          reconnectDelay: RECONNECT_INITIAL_DELAY, reconnectTimer: null,
        };
        active.set(id, td);
        spawnTunnel(id, sshArgs, hasCommand('autossh')); // ricontrollato a ogni avvio
        res.json({ id, pid: td.pid, port: localPort, label: srv.label });
      },

      stopTunnel(req, res) {
        const t = active.get(req.params.id);
        if (!t) return notFound(res, 'Tunnel');
        stop(t);
        active.delete(req.params.id);
        res.json({ ok: true });
      },

      stopAll(req, res) {
        stopAllTunnels();
        res.json({ ok: true });
      },

      tunnelLogs(req, res) {
        const t = active.get(req.params.id);
        if (!t) return notFound(res, 'Tunnel');
        res.json(t.logs.slice(-100));
      },

      createGroup(req, res) {
        const { key, label, color } = req.body;
        if (!key || !label) return res.status(400).json({ error: 'key e label obbligatori' });
        const list = groups();
        if (list.some(g => g.key === key)) return res.status(409).json({ error: 'Chiave già esistente' });
        save([...list, { key, label, color: color || '#6b7280', servers: [] }]);
        res.json({ ok: true });
      },

      updateGroup(req, res) {
        const list = groups();
        const idx = list.findIndex(g => g.key === req.params.key);
        if (idx === -1) return notFound(res, 'Gruppo');
        list[idx] = { ...list[idx], ...pick(req.body, ['label', 'color', 'servers']) };
        save(list);
        res.json({ ok: true });
      },

      deleteGroup(req, res) {
        save(groups().filter(g => g.key !== req.params.key));
        res.json({ ok: true });
      },

      createServer(req, res) {
        const { key, label, port, remote, alias, type, groupKey } = req.body;
        if (!key || !label || !port || !remote || !alias) return res.status(400).json({ error: 'Campi obbligatori mancanti' });
        const srvList = servers();
        if (srvList.some(s => s.key === key)) return res.status(409).json({ error: 'Chiave già esistente' });
        const grpList = groups();
        const g = groupKey && grpList.find(x => x.key === groupKey);
        if (g) g.servers.push(key);
        save(g ? grpList : null, [...srvList, normalizeServer({ key, label, port, remote, alias, type: type || 'TCP' })]);
        res.json({ ok: true });
      },

      updateServer(req, res) {
        const list = servers();
        const idx = list.findIndex(s => s.key === req.params.key);
        if (idx === -1) return notFound(res, 'Server');
        list[idx] = { ...list[idx], ...normalizeServer(pick(req.body, ['label', 'port', 'remote', 'alias', 'type'])) };
        save(null, list);
        res.json({ ok: true });
      },

      // Elimina il server e lo toglie dai gruppi (prima i gruppi, poi i server: i riferimenti restano validi)
      deleteServer(req, res) {
        const key = req.params.key;
        save(groups().map(g => ({ ...g, servers: g.servers.filter(k => k !== key) })), null);
        save(null, servers().filter(s => s.key !== key));
        res.json({ ok: true });
      },
    },

    shutdown: stopAllTunnels,
  };
};
