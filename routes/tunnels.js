const express = require('express');
const crypto = require('crypto');
const { loadConfig, getServerMap } = require('../lib/config');
const { hasCommand } = require('../lib/system');
const { isPort } = require('../lib/validate');
const { activeTunnels, spawnTunnel, stopTunnel, stopAllTunnels, RECONNECT_INITIAL_DELAY } = require('../lib/tunnels');

const router = express.Router();

router.get('/tunnels', (req, res) => {
  const list = [];
  for (const [id, t] of activeTunnels) {
    list.push({
      id, serverKey: t.serverKey, label: t.label, port: t.port,
      remote: t.remote, alias: t.alias, type: t.type,
      pid: t.pid, startedAt: t.startedAt,
      reconnecting: !!t.reconnectTimer,
    });
  }
  res.json(list);
});

router.post('/tunnels/start', (req, res) => {
  const { serverKey, port: customPort } = req.body;
  const cfg = loadConfig();
  const serverMap = getServerMap(cfg);
  const srv = serverMap[serverKey];
  if (!srv) return res.status(400).json({ error: 'Server non trovato' });

  const localPort = customPort == null || customPort === '' ? srv.port : Number(customPort);
  if (!isPort(localPort)) return res.status(400).json({ error: 'Porta locale non valida (1-65535)' });
  for (const [, t] of activeTunnels) {
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

  const useAuto = hasCommand('autossh'); // ricontrollato a ogni avvio: può essere installato a server acceso
  const td = {
    serverKey, label: srv.label, port: localPort,
    remote: srv.remote, alias: srv.alias, type: srv.type,
    pid: null, process: null,
    startedAt: new Date().toISOString(),
    logs: [],
    stopping: false,
    reconnectDelay: RECONNECT_INITIAL_DELAY,
    reconnectTimer: null,
  };
  activeTunnels.set(id, td);
  spawnTunnel(id, sshArgs, useAuto);

  res.json({ id, pid: td.pid, port: localPort, label: srv.label });
});

router.delete('/tunnels/:id', (req, res) => {
  const t = activeTunnels.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tunnel non trovato' });
  stopTunnel(t);
  activeTunnels.delete(req.params.id);
  res.json({ ok: true });
});

router.get('/tunnels/:id/logs', (req, res) => {
  const t = activeTunnels.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tunnel non trovato' });
  res.json(t.logs.slice(-100));
});

router.delete('/tunnels', (req, res) => {
  stopAllTunnels();
  res.json({ ok: true });
});

module.exports = router;
