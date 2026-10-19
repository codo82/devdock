const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir, makeRepo, commitFile, git } = require('./helpers');

let srv, base, repo;
before(async () => {
  base = tmpDir();
  repo = makeRepo(path.join(base, 'repo'));
  // origin con due pushurl verso due repo bare distinti (caso del backlog #1)
  git(base, 'init', '-q', '--bare', 'A.git');
  git(repo, 'remote', 'add', 'origin', path.join(base, 'A.git'));
  git(repo, 'push', '-q', 'origin', 'main');
  git(base, 'clone', '-q', '--bare', 'A.git', 'B.git');
  git(repo, 'remote', 'set-url', '--add', '--push', 'origin', path.join(base, 'A.git'));
  git(repo, 'remote', 'set-url', '--add', '--push', 'origin', path.join(base, 'B.git'));
  git(repo, 'fetch', '-q', 'origin');
  srv = await startServer({ groups: [], servers: [], projects: [{ id: 'r', label: 'Repo', path: repo }] });
});
after(() => srv.stop());

const action = body => srv.request('POST', '/api/git/repos/r/action', { body });
const exitOf = r => r.events.find(e => e.type === 'exit')?.data;

test('repo ricavato dai progetti', async () => {
  const r = await srv.request('GET', '/api/git/repos');
  assert.deepEqual(r.json.map(x => x.id), ['r']);
});

test('validazione di azione, branch, remote', async () => {
  const cases = [
    [{ action: 'rm' }, /Azione non supportata/],
    [{ action: 'checkout', branch: '--upload-pack=touch /tmp/pwn' }, /Nome branch non valido/],
    [{ action: 'merge', branch: 'a..b' }, /Nome branch non valido/],
    [{ action: 'push', remote: '--exec=x', branch: 'main' }, /Remote sconosciuto/],
    [{ action: 'push', remote: 'origin' }, /Branch obbligatorio/],
  ];
  for (const [body, re] of cases) {
    const r = await action(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.json.error, re);
  }
});

test('hash del commit validato', async () => {
  assert.equal((await srv.request('GET', '/api/git/repos/r/commit/--output=x')).status, 400);
  const hash = git(repo, 'rev-parse', '--short', 'HEAD').trim();
  const r = await srv.request('GET', `/api/git/repos/r/commit/${hash}`);
  assert.equal(r.json.body, 'init');
});

test('status con nomi file speciali e commit selettivo', async () => {
  fs.writeFileSync(path.join(repo, 'file con spazi.txt'), 'a');
  fs.writeFileSync(path.join(repo, "a');x=1;('.txt"), 'b');
  fs.writeFileSync(path.join(repo, 'resta.txt'), 'c');
  const status = await srv.request('GET', '/api/git/repos/r/status');
  const names = status.json.files.map(f => f.name).sort();
  assert.deepEqual(names, ["a');x=1;('.txt", 'file con spazi.txt', 'resta.txt']);

  let r = await action({ action: 'commit', message: 'x', files: ['--exec=evil'] });
  assert.equal(r.events[0].type, 'error');
  r = await action({ action: 'commit', message: 'x', files: 'resta.txt' });
  assert.equal(r.events[0].type, 'error');

  r = await action({ action: 'commit', message: 'selettivo', files: ['file con spazi.txt', "a');x=1;('.txt"] });
  assert.equal(exitOf(r), 0);
  assert.equal(git(repo, 'status', '--porcelain').trim(), '?? resta.txt');
  fs.unlinkSync(path.join(repo, 'resta.txt'));
});

test('push di più commit su due pushurl', async () => {
  for (const f of ['p1', 'p2', 'p3']) commitFile(repo, f);
  const r = await action({ action: 'push', remote: 'origin', branch: 'main' });
  assert.equal(exitOf(r), 0);
  const head = git(repo, 'rev-parse', 'main').trim();
  assert.equal(git(base, '--git-dir=A.git', 'rev-parse', 'main').trim(), head);
  assert.equal(git(base, '--git-dir=B.git', 'rev-parse', 'main').trim(), head);
});

test('azioni concorrenti sullo stesso repo: una sola alla volta (backlog #1)', async () => {
  for (const f of ['c1', 'c2', 'c3']) commitFile(repo, f);
  const [a, b] = await Promise.all([
    action({ action: 'push', remote: 'origin', branch: 'main' }),
    action({ action: 'push', remote: 'origin', branch: 'main' }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const ok = a.status === 200 ? a : b;
  assert.equal(exitOf(ok), 0);
  assert.doesNotMatch(ok.text, /cannot lock ref/);
});

test('log con mappa dei ref e branch locali', async () => {
  git(repo, 'branch', 'feature/x');
  const r = await srv.request('GET', '/api/git/repos/r/log?limit=50');
  assert.ok(r.json.entries.length >= 5);
  assert.ok(r.json.localBranches.includes('feature/x'));
  assert.ok(r.json.localBranches.includes('main'));
  const refNames = Object.values(r.json.refs).flat();
  assert.ok(refNames.includes('origin/main'));
  assert.ok(!refNames.includes('origin')); // origin/HEAD escluso
});

test('checkout di un branch esistente', async () => {
  let r = await action({ action: 'checkout', branch: 'feature/x' });
  assert.equal(exitOf(r), 0);
  assert.equal(git(repo, 'branch', '--show-current').trim(), 'feature/x');
  r = await action({ action: 'checkout', branch: 'main' });
  assert.equal(exitOf(r), 0);
});
