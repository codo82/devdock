// File: corpo binario e form multipart letti dal disco all'invio (percorso assoluto o relativo
// al progetto), risposte binarie restituite per il salvataggio con il nome giusto
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startServer, tmpDir, makeRepo } = require('../../../lib/testkit');

let srv, api, apiUrl, sectionId, projectDir, last;
const PDF = Buffer.from('%PDF-1.4\n\x00\x01\x02 binario\n%%EOF');

before(async () => {
  api = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      last = { headers: req.headers, body: Buffer.concat(chunks) };
      if (req.url === '/report') { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="rapporto ottobre.pdf"' }); return res.end(PDF); }
      if (req.url === '/image') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1])); }
      if (req.url === '/utf8name') { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''fattura%20n%C2%B01.zip" }); return res.end(Buffer.from([0, 1])); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${api.address().port}`;
  projectDir = makeRepo(path.join(tmpDir(), 'shop'));
  fs.mkdirSync(path.join(projectDir, 'fixtures'));
  fs.writeFileSync(path.join(projectDir, 'fixtures', 'doc.pdf'), PDF);
  srv = await startServer({ projects: [{ id: 'shop', label: 'Shop', path: projectDir }] });
  sectionId = (await call('POST', '/sections', { label: 'Shop', baseUrl: apiUrl, projectId: 'shop' })).json.id;
});
after(async () => { await srv?.stop(); api?.close(); });

const call = (m, p, body) => srv.request(m, `/api/ext/http-client${p}`, body !== undefined ? { body } : {});
const send = request => call('POST', '/send', { section: sectionId, request: { method: 'POST', url: '{{baseUrl}}/upload', query: [], headers: [], ...request } });

test('corpo file: percorso relativo al progetto, Content-Type dall\'estensione; errori chiari', async () => {
  let r = await send({ bodyType: 'file', file: 'fixtures/doc.pdf' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(last.body, PDF);
  assert.equal(last.headers['content-type'], 'application/pdf');
  r = await send({ bodyType: 'file', file: path.join(projectDir, 'fixtures', 'doc.pdf'), headers: [{ name: 'Content-Type', value: 'application/octet-stream' }] });
  assert.equal(last.headers['content-type'], 'application/octet-stream'); // header scritto a mano
  r = await send({ bodyType: 'file', file: 'fixtures/nope.pdf' });
  assert.equal(r.json.code, 'http-client.upload_missing');
  // salvata con la richiesta: il percorso resta, il contenuto no
  const saved = (await call('POST', `/sections/${sectionId}/requests`, { label: 'Upload', method: 'POST', url: '{{baseUrl}}/upload', bodyType: 'file', file: 'fixtures/doc.pdf' })).json;
  assert.equal(saved.file, 'fixtures/doc.pdf');
  assert.doesNotMatch(fs.readFileSync(srv.configPath, 'utf8'), /PDF-1\.4/);
});

test('form multipart: campi di testo e file', async () => {
  const r = await send({ bodyType: 'form', form: [
    { name: 'title', value: 'Ottobre' },
    { name: 'doc', value: 'fixtures/doc.pdf', type: 'file' },
    { name: 'skip', value: 'x', enabled: false },
  ] });
  assert.equal(r.status, 200, r.text);
  const boundary = /boundary=(.+)$/.exec(last.headers['content-type'])[1];
  assert.match(last.headers['content-type'], /^multipart\/form-data; boundary=/);
  const text = last.body.toString('latin1');
  assert.match(text, new RegExp(`--${boundary}\\r\\nContent-Disposition: form-data; name="title"\\r\\n\\r\\nOttobre\\r\\n`));
  assert.match(text, /Content-Disposition: form-data; name="doc"; filename="doc.pdf"\r\nContent-Type: application\/pdf\r\n\r\n%PDF-1\.4/);
  assert.doesNotMatch(text, /name="skip"/);
  assert.ok(text.endsWith(`--${boundary}--\r\n`));
});

test('risposte binarie: contenuto da salvare e nome dal Content-Disposition o dal Content-Type', async () => {
  let r = await send({ method: 'GET', url: '{{baseUrl}}/report', bodyType: 'none' });
  assert.equal(r.json.binary, true);
  assert.equal(r.json.fileName, 'rapporto ottobre.pdf');
  assert.deepEqual(Buffer.from(r.json.base64, 'base64'), PDF);
  r = await send({ method: 'GET', url: '{{baseUrl}}/image', bodyType: 'none' });
  assert.equal(r.json.fileName, 'response.png');
  r = await send({ method: 'GET', url: '{{baseUrl}}/utf8name', bodyType: 'none' });
  assert.equal(r.json.fileName, 'fattura n°1.zip');
  r = await send({ method: 'GET', url: '{{baseUrl}}/json', bodyType: 'none' });
  assert.equal(r.json.base64, undefined);
});
