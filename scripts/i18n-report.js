#!/usr/bin/env node
// Completezza delle traduzioni per lingua ed estensione, con le chiavi mancanti:
// il punto di partenza per chi aggiunge o completa una lingua.
//   npm run i18n:report            riepilogo e chiavi mancanti
//   npm run i18n:report -- <tag>   solo quella lingua (es. en, pt-BR)
const { report } = require('../lib/i18n-check');

const only = process.argv[2];
const { source, languages, sets } = report();
const pct = (done, total) => (total ? Math.floor((done / total) * 100) : 100);
const tags = languages.filter(t => t !== source && (!only || t === only));

console.log(`Lingua sorgente: ${source}`);
if (only && !languages.includes(only)) console.log(`\nNessun catalogo per "${only}": copia i file ${source}.json e traducili (vedi README → Languages).`);

let problems = 0;
for (const tag of tags) {
  let done = 0, total = 0;
  for (const s of sets) { const r = s.byLang[tag]; total += s.byLang[source]?.total || 0; done += r ? r.done : 0; }
  console.log(`\n${tag}: ${pct(done, total)}% (${done}/${total})`);
  for (const s of sets) {
    const r = s.byLang[tag];
    const t = s.byLang[source]?.total || 0;
    if (!t) continue;
    if (!r) { console.log(`  ${s.scope.padEnd(10)} manca il catalogo (${t} chiavi)`); continue; }
    console.log(`  ${s.scope.padEnd(10)} ${String(pct(r.done, r.total)).padStart(3)}%  ${r.done}/${r.total}`);
    for (const k of r.missing) console.log(`      - ${s.scope === 'core' ? k : `${s.scope}.${k}`}`);
  }
}
for (const s of sets) for (const p of s.problems) { console.log(`\n⚠ ${p}`); problems++; }
process.exitCode = problems ? 1 : 0;
