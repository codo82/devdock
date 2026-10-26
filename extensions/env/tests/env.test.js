// File .env: parser che conserva il file, confronto con il modello, lettura e modifica
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir } = require('../../../lib/testkit');
const dotenv = require('../dotenv');

test('parser: commenti, export, virgolette, valori su più righe', () => {
  const text = '# app\nAPP=Kelbo # nome\nexport HOST=localhost\n\nQ="a\\"b\\nc"\nM="riga1\nriga2"\nS=\'x # y\'\nE=\nDUP=1\nDUP=2\n';
  const { entries } = dotenv.parse(text);
  const v = Object.fromEntries(entries.map(e => [e.key, e.value]));
  assert.deepEqual(v, { APP: 'Kelbo', HOST: 'localhost', Q: 'a"b\nc', M: 'riga1\nriga2', S: 'x # y', E: '', DUP: '2' });
  assert.equal(entries.find(e => e.key === 'HOST').exported, true);
});

test('modifica: solo le righe toccate, commenti e ordine restano', () => {
  const text = '# app\nAPP=Kelbo # nome\n\nM="riga1\nriga2"\nexport HOST=localhost\n';
  const out = dotenv.apply(text, [
    { op: 'set', key: 'APP', value: 'con spazi' },
    { op: 'delete', key: 'M' },
    { op: 'set', key: 'HOST', value: 'db.local' },
    { op: 'rename', key: 'HOST', to: 'DB_HOST' },
    { op: 'set', key: 'NUOVA', value: 'x' },
  ]);
  assert.equal(out, '# app\nAPP="con spazi" # nome\n\nexport DB_HOST=db.local\n\nNUOVA=x\n');
  assert.throws(() => dotenv.apply(text, [{ op: 'rename', key: 'APP', to: 'HOST' }]), /key_exists/);
  assert.throws(() => dotenv.apply(text, [{ op: 'delete', key: 'NO' }]), /key_missing/);
  assert.throws(() => dotenv.apply(text, [{ op: 'set', key: '1X', value: '' }]), /key_invalid/);
  // valori particolari tornano uguali dopo la scrittura
  for (const value of ['a b', 'x"y', 'riga\nnuova', '#hash', 'back\\slash', '']) {
    const back = dotenv.parse(dotenv.apply('K=1\n', [{ op: 'set', key: 'K', value }])).entries[0].value;
    assert.equal(back, value);
  }
});

let srv, proj;
before(async () => {
  proj = path.join(tmpDir(), 'app');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'package.json'), '{}');
  fs.writeFileSync(path.join(proj, '.env.example'), '# modello\nAPP_NAME=app\nDB_HOST=localhost\nDB_PASSWORD=\n');
  fs.writeFileSync(path.join(proj, '.env'), '# locale\nAPP_NAME=app\nDB_PASSWORD=segreto-locale\nEXTRA=1\n');
  srv = await startServer({ groups: [], servers: [], projects: [{ id: 'app', label: 'App', path: proj }] });
});
after(() => srv?.stop());

const api = (m, p, body) => srv.request(m, `/api/ext/env${p}`, body !== undefined ? { body } : {});

test('confronto con il modello, senza valori', async () => {
  const list = (await api('GET', '/projects')).json;
  assert.deepEqual(list[0], { id: 'app', label: 'App', files: ['.env', '.env.example'], template: '.env.example', issues: 1 });
  const o = (await api('GET', '/projects/app')).json;
  const env = o.files.find(f => f.name === '.env');
  assert.deepEqual([env.missing, env.extra], [['DB_HOST'], ['EXTRA']]);
  assert.deepEqual(o.files.find(f => f.name === '.env.example').empty, ['DB_PASSWORD']);
  assert.doesNotMatch(JSON.stringify(o), /segreto-locale/);
  const v = await api('GET', '/projects/app/files/.env/value?key=DB_PASSWORD');
  assert.equal(v.json.value, 'segreto-locale');
  assert.equal((await api('GET', '/projects/app/files/..%2Fpackage.json/value?key=x')).status, 400);
  assert.doesNotMatch(fs.readFileSync(srv.configPath, 'utf8'), /segreto-locale/);
});

test('modifica con controllo di versione, chiavi mancanti dal modello, nuovo file', async () => {
  let o = (await api('GET', '/projects/app')).json;
  const version = o.files.find(f => f.name === '.env').version;
  let r = await api('PUT', '/projects/app/files/.env', { version, changes: [{ op: 'set', key: 'APP_NAME', value: 'devdock app' }] });
  assert.equal(r.status, 200, r.text);
  assert.equal(fs.readFileSync(path.join(proj, '.env'), 'utf8'), '# locale\nAPP_NAME="devdock app"\nDB_PASSWORD=segreto-locale\nEXTRA=1\n');
  // versione vecchia: il file è cambiato nel frattempo
  r = await api('PUT', '/projects/app/files/.env', { version, changes: [{ op: 'delete', key: 'EXTRA' }] });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'env.file_changed');

  o = (await api('GET', '/projects/app')).json;
  r = await api('POST', '/projects/app/files/.env/add-missing', { version: o.files.find(f => f.name === '.env').version });
  assert.deepEqual(r.json.added, ['DB_HOST']);
  assert.match(fs.readFileSync(path.join(proj, '.env'), 'utf8'), /\nDB_HOST=localhost\n$/);
  assert.equal(r.json.issues, 0);

  r = await api('POST', '/projects/app/files', { name: '.env.local' });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(proj, '.env.local'), 'utf8'), fs.readFileSync(path.join(proj, '.env.example'), 'utf8'));
  assert.equal((await api('POST', '/projects/app/files', { name: '.env.local' })).json.code, 'env.file_exists');
  assert.equal((await api('POST', '/projects/app/files', { name: 'config.json' })).json.code, 'env.file_invalid');
});
