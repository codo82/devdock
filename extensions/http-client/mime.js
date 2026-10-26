// Tipi MIME ↔ estensioni dei file: nome del file scaricato da una risposta binaria e
// Content-Type dei file inviati (corpo "file" e campi file dei form multipart)
const path = require('path');

const TYPES = {
  json: 'application/json', pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed', xml: 'application/xml', csv: 'text/csv', txt: 'text/plain', html: 'text/html',
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', tif: 'image/tiff',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet', rtf: 'application/rtf', epub: 'application/epub+zip',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', wasm: 'application/wasm', bin: 'application/octet-stream',
};
const ALIASES = { jpeg: 'jpg', htm: 'html', tiff: 'tif', yml: 'yaml' };
const EXT_OF = Object.fromEntries(Object.entries(TYPES).map(([ext, type]) => [type, ext]));
Object.assign(EXT_OF, { 'image/jpg': 'jpg', 'application/x-zip-compressed': 'zip', 'application/x-gzip': 'gz', 'text/xml': 'xml', 'application/x-pdf': 'pdf' });

// Content-Type di un file dal nome (application/octet-stream se sconosciuto)
function typeOfFile(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return TYPES[ALIASES[ext] || ext] || 'application/octet-stream';
}

// Nome sicuro per il download: niente cartelle, caratteri di controllo o riservati
const safeName = name => String(name).split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/^\.+/, '').slice(0, 200);

// Nome del file di una risposta: Content-Disposition (filename* o filename), altrimenti
// "response.<estensione del Content-Type>" (response.bin se il tipo è sconosciuto)
function fileNameOf(headers, fallback = 'response') {
  const get = n => headers.find(([k]) => k.toLowerCase() === n)?.[1] || '';
  const disposition = get('content-disposition');
  let name = null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?'[^']*'([^;]+)/.exec(disposition);
  if (star) { try { name = decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* codifica non valida */ } }
  if (!name) name = /filename\s*=\s*"([^"]*)"/.exec(disposition)?.[1] || /filename\s*=\s*([^;]+)/.exec(disposition)?.[1]?.trim() || null;
  name = name ? safeName(name) : '';
  if (name) return name;
  const type = get('content-type').split(';')[0].trim().toLowerCase();
  const ext = EXT_OF[type] || (/^[a-z]+\/(?:x-)?([a-z0-9]{1,8})$/.exec(type)?.[1]) || 'bin';
  return `${fallback}.${ext}`;
}

module.exports = { typeOfFile, fileNameOf, safeName };
