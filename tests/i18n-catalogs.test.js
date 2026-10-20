// Cataloghi delle traduzioni (core ed estensioni): validi, coerenti con la lingua
// sorgente e con le chiavi usate nel codice. Le traduzioni mancanti non sono errori:
// compaiono nel report (npm run i18n:report).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { catalogSets, checkSet, usedKeys, hardcodedTexts } = require('../lib/i18n-check');

const sets = catalogSets();
const core = checkSet(sets[0]);

test('ogni catalogo è valido, senza chiavi obsolete e con gli stessi segnaposto della sorgente', () => {
  const problems = sets.flatMap(set => checkSet(set).problems);
  assert.deepEqual(problems, []);
});

test('la lingua sorgente contiene ogni chiave usata nel codice', () => {
  const missing = [];
  for (const set of sets) {
    const { source } = checkSet(set);
    for (const key of usedKeys(set)) {
      const found = key.startsWith('core.') ? key in core.source : key.slice(set.prefix.length) in source;
      if (!found) missing.push(`${set.scope}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('il core ha _meta in ogni catalogo e ogni estensione ha il catalogo sorgente', () => {
  assert.ok(Object.keys(core.catalogs).length >= 2, 'almeno la sorgente e una lingua');
  for (const set of sets.slice(1)) {
    const files = set.files.map(f => f.split('/').pop());
    if (!files.some(f => f.endsWith('.html') || f === 'view.js')) continue; // estensioni senza UI
    assert.ok(Object.keys(checkSet(set).source).length, `${set.scope}: i18n/it.json mancante o vuoto`);
  }
});

test('nessun testo dell\'interfaccia scritto nel codice (public/ e viste delle estensioni)', () => {
  assert.deepEqual(hardcodedTexts(), [], 'spostare i testi nei cataloghi o aggiungerli a tests/i18n-allowlist.txt');
});
