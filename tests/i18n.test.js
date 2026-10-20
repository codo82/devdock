const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir } = require('./helpers');
const { parseCatalog, CatalogError, isLocalizedText, sourceText } = require('../lib/i18n');

function ext(root, code, files) {
  const dir = path.join(root, code);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
}

const manifest = (code, extra = {}) => ({ name: code, code, color: '#336699', position: 'tab', frontend: { js: 'view.js' }, ...extra });

let srv;
before(async () => {
  const root = tmpDir('devdock-i18n-');
  ext(root, 'alpha', {
    'setting.json': manifest('alpha', { name: { it: 'Alfa', en: 'Alpha' } }),
    'view.js': 'export default {}',
    'i18n/it.json': { 'title': 'Titolo', 'items': { one: '{count} elemento', other: '{count} elementi' } },
    'i18n/en.json': { 'title': 'Title' },
    'i18n/xx-bad.json': '{ not json',
    'i18n/ar.json': { 'title': 'عنوان' },
  });
  ext(root, 'core', { 'setting.json': manifest('core'), 'view.js': '' });
  ext(root, 'beta', { 'setting.json': manifest('beta', { name: { it: '' } }), 'view.js': '' });
  srv = await startServer(undefined, { env: { DEVDOCK_EXTENSIONS_DIR: root } });
});
after(() => srv?.stop());

test('elenco delle lingue dai cataloghi del core, con completezza', async () => {
  const { status, json } = await srv.request('GET', '/api/core/i18n/languages');
  assert.equal(status, 200);
  assert.equal(json.source, 'it');
  const it = json.languages.find(l => l.tag === 'it');
  const en = json.languages.find(l => l.tag === 'en');
  assert.equal(it.nativeName, 'Italiano');
  assert.equal(it.completeness, 100);
  assert.equal(en.dir, 'ltr');
  assert.ok(en.completeness < 100, 'manca alpha.items in inglese');
  assert.equal(en.core, true);
  // lingua fornita solo da un'estensione: nomi e direzione da Intl
  const ar = json.languages.find(l => l.tag === 'ar');
  assert.equal(ar.core, false);
  assert.equal(ar.dir, 'rtl');
  assert.equal(ar.name, 'Arabic');
});

test('cataloghi delle estensioni: elenco, file serviti, cataloghi non validi ignorati', async () => {
  const list = (await srv.request('GET', '/api/core/extensions')).json;
  const alpha = list.find(e => e.code === 'alpha');
  assert.deepEqual(alpha.i18n, ['ar', 'en', 'it']);
  assert.deepEqual(alpha.name, { it: 'Alfa', en: 'Alpha' });
  assert.ok(alpha.warnings.some(w => w.includes('xx-bad')));
  const cat = await srv.request('GET', '/ext/alpha/i18n/en.json');
  assert.equal(cat.status, 200);
  assert.equal(cat.json.title, 'Title');
  assert.equal((await srv.request('GET', '/ext/alpha/i18n/xx-bad.json')).status, 404);
  assert.equal((await srv.request('GET', '/ext/alpha/i18n/../setting.json')).status, 404);
});

test('"core" è un codice riservato; name localizzato non può essere vuoto', async () => {
  const list = (await srv.request('GET', '/api/core/extensions')).json;
  assert.equal(list.find(e => e.code === 'core').state, 'disabled');
  assert.equal(list.find(e => e.code === 'beta').state, 'disabled');
});

test('validazione dei cataloghi', () => {
  assert.throws(() => parseCatalog({ x: { one: 'a' } }), CatalogError, 'plurale senza other');
  assert.throws(() => parseCatalog({ x: { few: 'a', other: 'b', lots: 'c' } }), CatalogError);
  assert.throws(() => parseCatalog({ 'bad key': 'a' }), CatalogError);
  assert.throws(() => parseCatalog({ x: 1 }), CatalogError);
  assert.throws(() => parseCatalog({ x: 'a' }, { metaRequired: true }), CatalogError);
  assert.throws(() => parseCatalog({ _meta: { name: 'A', nativeName: 'A', dir: 'up' } }), CatalogError);
  const { meta, entries } = parseCatalog({ _meta: { name: 'Arabic', nativeName: 'العربية', dir: 'rtl' }, 'a.b': 'x' });
  assert.equal(meta.dir, 'rtl');
  assert.deepEqual(entries, { 'a.b': 'x' });
  assert.ok(isLocalizedText({ 'pt-BR': 'Olá' }));
  assert.ok(!isLocalizedText({ 'not a tag': 'x' }));
  assert.equal(sourceText({ en: 'Hi', it: 'Ciao' }), 'Ciao');
});
