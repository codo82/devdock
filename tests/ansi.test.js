// Conversione dei colori ANSI dell'output (public/core/ui.js), senza browser
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

global.window = { addEventListener() {} };
global.I18n = {};
global.document = { getElementById: () => ({ addEventListener() {} }), addEventListener() {}, querySelectorAll: () => [] };
global.setInterval = () => {};
require(path.join(__dirname, '../public/core/ui.js'));
const { ansiToHtml, ansiState } = global.window.UI;
const E = '\x1b';

test('i codici di chiusura parziali (39, 22, 49…) chiudono il colore', () => {
  assert.equal(ansiToHtml(`a ${E}[31mrosso${E}[39m normale`), 'a <span class="ansi-red">rosso</span> normale');
  assert.equal(ansiToHtml(`${E}[1;31mx${E}[22my${E}[m z`), '<span class="ansi-bold ansi-red">x</span><span class="ansi-red">y</span> z');
  assert.equal(ansiToHtml(`${E}[44mfondo${E}[49m no`), '<span class="ansi-bg-blue">fondo</span> no');
});

test('il colore continua tra un pezzo e l\'altro, anche con una sequenza spezzata', () => {
  const st = ansiState();
  assert.equal(ansiToHtml(`${E}[32mriga1\nriga2${E}[3`, st), '<span class="ansi-green">riga1\nriga2</span>');
  assert.equal(ansiToHtml(`3mgiallo${E}[0m ok`, st), '<span class="ansi-yellow">giallo</span> ok');
  assert.equal(ansiToHtml('dopo', st), 'dopo');
});

test('sequenze non di colore tolte senza perdere testo; colori estesi; HTML escapato', () => {
  assert.equal(ansiToHtml(`${E}[2K${E}[1Gprogress 50% complete`), 'progress 50% complete');
  assert.equal(ansiToHtml(`${E}]0;titolo\x07testo <b>`), 'testo &lt;b&gt;');
  assert.equal(ansiToHtml(`${E}[38;2;31;32;33mtrue${E}[0m`), '<span style="color:rgb(31,32,33)">true</span>');
  assert.equal(ansiToHtml(`${E}[38;5;9mx`), '<span class="ansi-bright-red">x</span>');
});
