// Variabili nelle richieste: {{nome}} e :nome (come nelle rotte Express), senza toccare i ":"
// che non sono variabili; :nome rimasto nel percorso dell'URL → errore chiaro
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fill, buildUrl } = require('../send');

const vars = { baseUrl: 'http://localhost:3000', id: '42', user: 'ada', true: 'X', site_id: 15 };

test('{{nome}} e :nome sostituiti con lo stesso valore', () => {
  assert.equal(fill('{{baseUrl}}/users/:id', vars), 'http://localhost:3000/users/42');
  assert.equal(fill('/a/:id/b?x=:id&y={{ id }}', vars), '/a/42/b?x=42&y=42');
  assert.equal(fill('{"id": :id, "site": :site_id, "u": ":user"}', vars), '{"id": 42, "site": 15, "u": "ada"}');
  assert.equal(fill('Bearer :user', vars), 'Bearer ada');
  assert.equal(fill(':id', vars), '42');
  // con la codifica del corpo (es. JSON dentro una stringa)
  assert.equal(fill('{"q": ":user"}', { user: 'a"b' }, v => JSON.stringify(v).slice(1, -1)), '{"q": "a\\"b"}');
});

test(':nome resta com\'è quando non è una variabile', () => {
  for (const text of ['http://localhost:3000', 'user:pass', '10:30', 'a::id', 'x:id', '"ok":true', ':missing', 'C:\\temp']) {
    assert.equal(fill(text, vars), text, text);
  }
  // {{nome}} sconosciuto resta un errore
  assert.throws(() => fill('{{nope}}', vars), e => e.key === 'variable_unknown' && e.params.name === 'nope');
});

test('URL: :nome nel percorso senza variabile → errore; i ":" del percorso che non sono parametri passano', () => {
  assert.equal(buildUrl('{{baseUrl}}/users/:id/posts', [{ name: 'by', value: ':user' }], vars).href, 'http://localhost:3000/users/42/posts?by=ada');
  assert.throws(() => buildUrl('{{baseUrl}}/users/:userId', [], vars), e => e.key === 'param_unknown' && e.params.name === 'userId');
  assert.equal(buildUrl('{{baseUrl}}/time/10:30', [], vars).pathname, '/time/10:30');
  assert.equal(buildUrl('{{baseUrl}}/a:b', [], vars).pathname, '/a:b');
});
