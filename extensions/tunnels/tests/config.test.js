// Sezioni di config dei tunnel: proprietà, casella di export, import con i riferimenti
// tra gruppi e server
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../../../lib/testkit');

let srv;
before(async () => { srv = await startServer({ groups: [], servers: [], projects: [] }); });
after(() => srv.stop());

const server = (over = {}) => ({ key: 'db', label: 'DB', port: 3306, remote: '10.0.0.1:3306', alias: 'bastion', ...over });

test('groups e servers appartengono all\'estensione, con la casella Tunnel SSH', async () => {
  const sections = Object.fromEntries((await srv.request('GET', '/api/core/config/sections')).json.map(x => [x.key, x.owner]));
  assert.equal(sections.groups, 'tunnels');
  assert.equal(sections.servers, 'tunnels');
  const ext = (await srv.request('GET', '/api/core/extensions')).json.find(e => e.code === 'tunnels');
  assert.deepEqual(ext.export.map(x => x.sections), [['groups', 'servers']]);
});

test('import: gruppi verso server mancanti rifiutati, config invariata', async () => {
  const tunnels = { groups: [{ key: 'g2', label: 'G2', color: '#112233', servers: ['s1'] }], servers: [server({ key: 's1', port: 1001 })] };
  let r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'merge', config: tunnels } });
  assert.equal(r.status, 200, r.text);
  assert.ok(srv.readConfig().servers.some(s => s.key === 's1'));
  r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'replace', config: { servers: [] } } });
  assert.equal(r.status, 400);
  assert.ok(srv.readConfig().servers.some(s => s.key === 's1'));
  const exp = await srv.request('GET', '/api/core/config/export?name=tunnels&sections=groups,servers');
  assert.deepEqual(Object.keys(exp.json).sort(), ['groups', 'servers']);
});
