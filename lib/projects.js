// Progetti npm
const fs = require('fs');
const path = require('path');

// package.json del progetto (null se assente o non valido)
function readProjectPackage(p) {
  try { return JSON.parse(fs.readFileSync(path.join(p.path, 'package.json'), 'utf8')); } catch { return null; }
}

module.exports = { readProjectPackage };
