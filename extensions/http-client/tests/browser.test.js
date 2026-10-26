// Browser dei login OAuth: percorso scelto dall'utente (es. Firefox di Windows da WSL), container
// Firefox, errore visibile con il link quando il browser non parte; non esportato
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir, freePort } = require('../../../lib/testkit');

let srv, dir, sectionId;
before(async () => {
  dir = tmpDir();
  // apertura reale del browser (il kit la disattiva di solito): qui il "browser" è uno script
  srv = await startServer({ projects: [] }, { env: { DEVDOCK_NO_BROWSER: '0' } });
  await srv.request('POST', '/api/core/vault/init', { body: { password: 'master-password-1' } });
  sectionId = (await call('POST', '/sections', { label: 'API', baseUrl: 'http://127.0.0.1:9' })).json.id;
});
after(() => srv?.stop());

const call = (m, p, body) => srv.request(m, `/api/ext/http-client${p}`, body !== undefined ? { body } : {});
const wait = ms => new Promise(r => setTimeout(r, ms));

test('percorso del browser: assoluto, esistente, non esportato', async () => {
  assert.deepEqual((await call('GET', '/browser')).json.path, null);
  let r = await call('PUT', '/browser', { path: 'firefox' });
  assert.equal(r.json.code, 'http-client.browser_invalid');
  r = await call('PUT', '/browser', { path: path.join(dir, 'nope.exe') });
  assert.equal(r.json.code, 'http-client.browser_not_found');
  const fake = path.join(dir, 'browser.sh');
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${path.join(dir, 'args.txt')}"\n`, { mode: 0o755 });
  r = await call('PUT', '/browser', { path: fake });
  assert.equal(r.json.path, fake);
  assert.equal(srv.readConfig().httpBrowser.path, fake);
  const exp = await srv.request('GET', '/api/core/config/export');
  assert.equal(exp.json.httpBrowser, undefined);
});

test('login OAuth: il browser scelto riceve l\'URL nel container', { skip: process.platform === 'win32' }, async () => {
  const port = await freePort();
  const user = (await call('POST', `/sections/${sectionId}/users`, {
    label: 'Company', auth: {
      type: 'oauth', authorizationEndpoint: 'https://sso.example.invalid/realms/dev/protocol/openid-connect/auth',
      tokenEndpoint: 'https://sso.example.invalid/realms/dev/protocol/openid-connect/token', clientId: 'app', scope: 'openid',
      flow: 'pkce', redirectUri: `http://localhost:${port}/callback`, container: 'company',
    },
  })).json;
  let st = (await call('POST', `/sections/${sectionId}/users/${user.id}/login`, {})).json;
  assert.match(st.pendingLogin, /^https:\/\/sso\.example\.invalid\/.*client_id=app/);
  assert.equal(st.browserError, null);
  let args = '';
  for (let i = 0; i < 50 && !args; i++) { await wait(50); try { args = fs.readFileSync(path.join(dir, 'args.txt'), 'utf8').trim(); } catch { /* non ancora */ } }
  assert.match(args, /^ext\+container:name=company&url=https%3A%2F%2Fsso\.example\.invalid%2F/);
  await call('DELETE', `/sections/${sectionId}/users/${user.id}/token`); // annulla il login in corso

  // browser che non parte (file non eseguibile): l'errore torna all'interfaccia con il link
  const broken = path.join(dir, 'broken.exe');
  fs.writeFileSync(broken, 'x', { mode: 0o644 });
  await call('PUT', '/browser', { path: broken });
  st = (await call('POST', `/sections/${sectionId}/users/${user.id}/login`, {})).json;
  assert.ok(st.pendingLogin);
  assert.match(st.browserError, /broken\.exe/);
  await call('DELETE', `/sections/${sectionId}/users/${user.id}/token`);
});
