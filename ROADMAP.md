# DevDock — Roadmap

Milestone ordinate per dipendenza: prima si mette in sicurezza e si stabilizza il codice esistente, poi si rifattorizza, e solo dopo si costruiscono le feature nuove sulla struttura nuova (così non vanno riscritte due volte).

Legenda stato: `[ ]` da fare · `[~]` in corso · `[x]` fatto

**Regola per ogni milestone:** una milestone è chiusa solo quando `CHANGELOG.md` (sezione `[Unreleased]` → versione) e, se cambia qualcosa per l'utente, `README.md` sono aggiornati. Versionamento SemVer: ogni milestone chiusa = nuova versione minor (M0 → 1.1.0, M1 → 1.2.0, …).

---

## Documentazione (trasversale)

- [x] **D.1** `README.md` iniziale (in M0): cos'è DevDock, requisiti (Node ≥ 18, `ssh`; opzionali `autossh`, `pm2`), installazione e avvio (`npm install`, `npm start`, `npm run dev`), panoramica delle sezioni, formato di `config.json`, nota sulla sicurezza (solo uso locale)
- [x] **D.2** `CHANGELOG.md` iniziale in formato [Keep a Changelog](https://keepachangelog.com/it/1.1.0/): voce `1.0.0` per lo stato attuale + sezione `[Unreleased]`
- [x] **D.3** Allineare `package.json` (nome `devdock` al posto di `port-forward-manager`, versione, descrizione) e il log di avvio del server
- [ ] **D.4** A fine di ogni milestone: aggiornare CHANGELOG (Added/Changed/Fixed/Security/Removed) e README dove serve
- [ ] **D.5** In M3: sezione README "Struttura del progetto"; in M5: sezione "Scrivere un'estensione"; in M6: sezione "DB client"

---

## M0 — Pulizia e portabilità macOS ✅ (1.1.0)

Obiettivo: il progetto parte pulito su macOS (e resta compatibile con Linux/WSL).

- [x] **M0.1** Rimuovere `public/index.html:Zone.Identifier` (artefatto Windows) dal repo
- [x] **M0.2** Rimuovere `index.html` in root (duplicato identico di `public/index.html`, non servito)
- [x] **M0.3** Rilevamento porte cross-platform: `getPortsForPgid` usa `ss` (assente su macOS) → usare `lsof -nP -iTCP -sTCP:LISTEN -a -p <pids>` con fallback a `ss` su Linux
- [x] **M0.4** `EMPTY_CONFIG` deve includere `projects: []`
- [x] **M0.5** Gestire anche `SIGTERM` (oltre a `SIGINT`) per chiudere tunnel e processi figli
- [x] **M0.6** Sezioni NPM/PM2 degradano con messaggio chiaro se `pm2`/`autossh` non sono installati (oggi lista vuota silenziosa)
- [ ] **M0.7** Aggiornare i path dei progetti in `config.json` locale (oggi `/home/...`) — *azione manuale dell'utente da UI*

## M1 — Sicurezza ✅ (1.2.0)

Contesto: l'app gira solo su `127.0.0.1`, ma il browser è un vettore di attacco: qualunque pagina web aperta può inviare richieste a `localhost:3500` e l'API esegue `ssh`, `npm`, `git`, `pm2`.

**Protezione dell'API**
- [x] **M1.1** Middleware anti-CSRF: rifiutare richieste con `Origin`/`Referer` diverso da `http://127.0.0.1:3500` / `http://localhost:3500`
- [x] **M1.2** Controllo header `Host` (difesa da DNS rebinding): accettare solo `127.0.0.1:PORT` e `localhost:PORT`
- [x] **M1.3** Richiedere `Content-Type: application/json` sulle richieste che modificano stato (blocca i form cross-site "semplici")
- [x] **M1.4** Rimuovere `/api/git/repos/:id/debug-push` (espone env e `git config`, possibili token) oppure abilitarlo solo con `DEVDOCK_DEBUG=1`
- [x] **M1.5** Header di sicurezza base: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`

**Validazione input (argument injection)**
- [x] **M1.6** Git: validare `branch`/`remote` (no `-` iniziale, `git check-ref-format`), aggiungere `--` prima dei path; validare `:hash` con regex esadecimale
- [x] **M1.7** Git commit: i file passati devono essere tra quelli restituiti da `git status`
- [x] **M1.8** NPM: `script` ammesso solo se presente in `package.json` (o `install`); nuova azione esplicita `update <pkg>` con nome pacchetto validato
- [x] **M1.9** PM2: whitelist di `action` (`start|stop|restart|delete`), `target` validato
- [x] **M1.10** Config: validare schema in `PUT /api/config`, import e CRUD (key alfanumeriche, porte intere 1–65535, `remote` nel formato `host:port`, `alias` senza spazi/`-` iniziale, `color` esadecimale)

**Frontend (XSS)**
- [x] **M1.11** Escapare tutti i valori interpolati in HTML/attributi (`color` negli `style`, key negli `onclick`, `e.message` in Swagger e nei toast HTML) — preferire `data-*` + event delegation agli `onclick` inline con stringhe
- [x] **M1.12** Swagger UI e js-yaml da CDN con attributo `integrity` (SRI) + `crossorigin`

## M2 — Bug noti

- [x] **M2.1** `npmUpdate` invia `script: "update <pkg>"` → il server esegue `npm run "update <pkg>"`. Correggere con un endpoint/azione dedicata (dipende da M1.8)
- [ ] **M2.2** Import `merge`: includere anche i `projects` (oggi ignorati)
- [ ] **M2.3** Commenti incoerenti col codice (polling SSE "300ms" vs 100ms reali) e altre piccole incongruenze
- [x] **M2.4** *(Backlog #1)* **Git push con due pushurl e più commit** — `cannot lock ref: is at X but expected Y`
  - [x] Riprodotto con un repo di test con `origin` a due pushurl (due bare repo locali): un push singolo di 3 commit funziona; due push concorrenti danno esattamente l'errore del backlog (5 prove su 5)
  - [x] Causa: `gitAction()` nel frontend eseguiva l'azione due volte (una `fetch` POST con output ignorato e poi `gitRunSse()`), quindi due `git push` si contendevano l'aggiornamento di `refs/heads/<branch>` sui remote. I due pushurl non c'entrano
  - [x] Fix: richiesta unica dalla UI e lock per repo nel server (una seconda azione concorrente riceve 409)
- [ ] **M2.5** *(Backlog #2)* **Lane del grafo con nome generico `branch-N`**
  - [ ] Ereditarietà del nome: la lane prende il nome dal primo commit con ref che la genera e lo porta con sé scendendo sui parent, invece di cercare in `allRefs` l'hash pendente in `finalLanes`
  - [ ] Fallback: nome ricavato dal subject dei merge (`Merge branch 'x'`) per branch già eliminati
  - [ ] `branch-N` solo come ultima risorsa

## M3 — Refactor backend + repo per Claude Code

Prerequisito per le feature: struttura modulare su cui poggiare branch switch, DB client ed estensioni.

- [ ] **M3.1** *(Backlog #6 — split route)* Separare `server.js`:
  ```
  server.js            entry point: express, middleware sicurezza, mount route, listen
  lib/config.js        load/save/validate config
  lib/validate.js      validatori condivisi (branch, key, porte, ...)
  lib/process.js       spawn tracciati, kill process group, rilevamento porte
  lib/sse.js           helper SSE
  routes/config.js     config, gruppi, server, import/export
  routes/tunnels.js    port forward SSH  (nel backlog: ports.js)
  routes/projects.js   progetti NPM + processi  (nel backlog: repos.js)
  routes/pm2.js
  routes/git.js
  ```
- [ ] **M3.2** Unificare la logica duplicata di push (`push`, fallback fetch-error, `pull_push`) in un'unica pipeline di comandi SSE sequenziali
- [ ] **M3.3** Test minimi (`node:test`) sui validatori e sulle route critiche (git action, npm start), con repo git temporanei
- [ ] **M3.4** *(Backlog #5)* `CLAUDE.md`: scopo, struttura, avvio locale, convenzioni (italiano nei messaggi UI, vanilla JS, niente build step), riferimento a questa roadmap
- [ ] **M3.5** Pubblicazione su GitHub: verificare che nessun segreto sia nel repo (config è in `.gitignore`), README e CHANGELOG aggiornati, `config.example.json`

## M4 — Branch switch / create *(Backlog #3)*

- [ ] **M4.1** Backend: `GET /api/git/repos/:id/branches` (locali + remoti, branch corrente)
- [ ] **M4.2** Backend: azione `checkout` (esiste già, da validare con M1.6) e nuova `checkout_new` (`git checkout -b <nome>`, opzionale punto di partenza)
- [ ] **M4.3** Pre-check: se ci sono modifiche non committate → risposta strutturata che la UI usa per proporre "Stash e cambia" / "Annulla"
- [ ] **M4.4** Pre-check: branch già esistente → errore chiaro; branch remoto non ancora locale → `checkout --track`
- [ ] **M4.5** UI: dropdown sul badge del branch con ricerca, sezione locali/remoti, voce "Nuovo branch…"; output SSE durante l'operazione, refresh di status e log al termine

## M5 — Architettura a estensioni *(Backlog #6 bis)*

- [ ] **M5.1** Design: formato `setting.json` (name, code, color, position, dependencies) + entry point frontend (`index.js` che esporta `mount(container, api)`) e backend opzionale (`routes.js` montato su `/api/ext/<code>`)
- [ ] **M5.2** npm workspaces: `"workspaces": ["extensions/*"]` nel `package.json` radice, un solo `node_modules`
- [ ] **M5.3** Loader backend: scoperta di `extensions/*/setting.json` all'avvio, validazione, risoluzione dipendenze (`required: true` → non parte; `false` → parte con warning), ordine topologico, errore sui cicli
- [ ] **M5.4** Loader frontend: `GET /api/extensions` → tab o elementi header in base a `position`, icona di avviso per dipendenze opzionali mancanti, caricamento lazy (`import()` al primo accesso)
- [ ] **M5.5** Shell comune per le estensioni: API helper, toast, modal, pannello SSE (estratti da `index.html`)
- [ ] **M5.6** Migrare le sezioni esistenti a estensioni una alla volta: Swagger (la più isolata) → PM2 → Git → NPM → Tunnel
- [ ] **M5.7** Aggiornare `CLAUDE.md` con il sistema a estensioni

## M6 — DB client integrato *(Backlog #4)* — prima estensione nuova

Realizzato come estensione: fa da banco di prova per M5.

- [ ] **M6.1** Estensione `db-client` con dipendenza `mysql2` nel suo `package.json`
- [ ] **M6.2** Connessioni configurabili per progetto (host, porta, db, user, pass). Opzione "usa tunnel" che collega una connessione a un server SSH già configurato
- [ ] **M6.2b** **Vault con master password** (funziona uguale su macOS e Windows, solo `node:crypto`, nessuna dipendenza nativa):
  - Primo accesso alla sezione Database: la UI chiede di **creare** la master password (con conferma, minimo 10 caratteri). Il server genera un `salt` casuale e ricava la chiave con **scrypt** (`crypto.scrypt`, chiave da 32 byte)
  - Ogni password DB viene cifrata con **AES-256-GCM** usando un IV casuale per ogni valore, e salvata come `{ iv, tag, data }` in base64
  - **Chiavi separate**: dalla chiave scrypt (`masterKey`) si ricavano con **HKDF-SHA256** due sottochiavi indipendenti: `encKey` (info `"devdock-vault-enc"`) per cifrare e `verifyKey` (info `"devdock-vault-verify"`) per la verifica. Così il valore salvato non rivela niente su `encKey`
  - **Verificatore hashato** in `config.json`: `verifier = SHA-256(verifyKey)`, salvato alla creazione. Allo sblocco si ricalcola e si confronta con `crypto.timingSafeEqual`: se non coincide, la password è sbagliata
  - Struttura in `config.json`:
    ```json
    "vault": {
      "version": 1,
      "kdf": { "alg": "scrypt", "salt": "<base64>", "N": 131072, "r": 8, "p": 1 },
      "verifier": "<base64 sha256(verifyKey)>"
    }
    ```
    e in ogni connessione `"password": { "iv": "…", "tag": "…", "data": "…" }`
  - **Sessione**: la chiave ricavata resta **solo nella memoria del server**. Scade al riavvio del server, con il pulsante "Blocca" o dopo un timeout di inattività configurabile (default 30 min). Al primo accesso di ogni sessione la UI chiede di sbloccare
  - Le password in chiaro **non tornano mai al frontend**: il server le decifra solo al momento di aprire la connessione. In modifica il campo password resta vuoto ("lascia vuoto per non cambiare")
  - Endpoint: `GET /api/ext/db-client/vault` (stato: `uninitialized | locked | unlocked`), `POST …/vault/init`, `POST …/vault/unlock`, `POST …/vault/lock`, `POST …/vault/change` (ri-cifra tutte le password con la chiave nuova, scrivendo il file in modo atomico)
  - Protezione da brute force: ritardo crescente dopo ogni tentativo di sblocco fallito
  - "Ho dimenticato la password": reset del vault, che cancella le password salvate (le connessioni restano, ma senza password) dopo una conferma esplicita
  - Export/import: le password viaggiano cifrate insieme al blocco `vault`, quindi si possono portare su un'altra macchina con la stessa master password. Se si importa in una config che ha già un vault con un salt diverso, bisogna chiedere la master password della config importata e ri-cifrare
  - Test: init/unlock/password sbagliata/change/lock, verifica che `config.json` non contenga mai password in chiaro
- [ ] **M6.3** Backend: pool per connessione, `POST /api/ext/db-client/query` con timeout, limite righe, flag di sola lettura opzionale
- [ ] **M6.4** UI: editor con syntax highlight minimale (CodeMirror 6 da CDN con SRI, o highlight custom leggero), esecuzione con Ctrl/Cmd+Enter
- [ ] **M6.5** Risultati in tabella (colonne ordinabili, NULL evidenziati, conteggio righe/tempo), messaggi per query senza risultato
- [ ] **M6.6** Storico query per sessione (in memoria / `sessionStorage`)
- [ ] **M6.7** Dopo: PostgreSQL, visto che compare tra i tipi di server configurati

---

## Ordine consigliato e dimensioni

| Milestone | Dimensione | Note |
|---|---|---|
| D Documentazione | S | README e CHANGELOG creati in M0, poi aggiornati a ogni milestone |
| M0 Pulizia/macOS | S | sblocca l'uso quotidiano su Mac |
| M1 Sicurezza | M | fatta sul `server.js` attuale, poi spostata nei moduli in M3 |
| M2 Bug | M | M2.4 richiede di riprodurre il caso prima di correggerlo |
| M3 Refactor + CLAUDE.md | M | nessun cambiamento funzionale, coperto da test |
| M4 Branch switch | S | primo valore visibile sulla nuova struttura |
| M5 Estensioni | L | la più grossa; migrazione incrementale |
| M6 DB client | L | prima estensione nativa; include il vault con master password |
