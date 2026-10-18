# Changelog

Tutte le modifiche rilevanti di DevDock sono documentate in questo file.

Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e il progetto usa il [Semantic Versioning](https://semver.org/lang/it/). Ogni milestone della [roadmap](ROADMAP.md) chiusa corrisponde a una versione minor.

## [Unreleased]

## [1.2.0] - 2026-10-19 — M1 Sicurezza

### Security
- Le richieste con `Origin` (o `Referer`) diverso dalla UI ricevono 403: una pagina web aperta nel browser non può più far eseguire comandi a DevDock (CSRF).
- Sono accettati solo gli header `Host` `127.0.0.1:<porta>` e `localhost:<porta>` (difesa da DNS rebinding).
- POST/PUT/PATCH su `/api` richiedono `Content-Type: application/json`.
- Header di sicurezza: Content-Security-Policy, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`.
- Git: azioni in whitelist; branch validati con `git check-ref-format`, remote tra quelli configurati, hash esadecimali; i valori che iniziano con `-` non possono più diventare opzioni di git.
- Git commit: si possono passare solo file presenti in `git status`, dopo `--`.
- npm: si eseguono solo `install` e gli script definiti in `package.json`; i nomi dei pacchetti sono validati (niente path traversal).
- PM2: azioni in whitelist e nomi dei processi validati; l'avvio da progetto non accetta più una cartella arbitraria.
- `config.json`: ogni scrittura (UI, import, API) è validata (chiavi, porte, `remote` host:porta, alias SSH, colori, percorsi assoluti, riferimenti tra gruppi e server) e le PUT accettano solo i campi noti.
- Frontend: escape corretto dei valori negli handler `onclick` (nomi file, script, processi con apici potevano iniettare JavaScript) e dei colori negli stili.
- Swagger UI e js-yaml vengono caricati con Subresource Integrity.

### Added
- Endpoint `POST /api/projects/:id/npm/update` per aggiornare una dipendenza.
- Variabili d'ambiente `DEVDOCK_PORT` e `DEVDOCK_CONFIG`.

### Changed
- Lo status git usa `--porcelain -z`: nomi file esatti anche con spazi o caratteri speciali.
- Gli errori di validazione delle azioni git compaiono nel pannello di output.

### Fixed
- "Aggiorna" su una dipendenza eseguiva `npm run "update <pkg>"` e falliva sempre.
- Senza `pm2` installato un'azione PM2 mandava in crash il server.
- "Avvia con PM2" lanciava `npm` senza argomenti invece di `npm run <script>`.
- Dopo un riavvio, la chiusura del processo npm precedente segnava come terminato quello nuovo.

### Removed
- Endpoint `/api/git/repos/:id/debug-push`: esponeva l'ambiente e `git config`, che può contenere token.

## [1.1.0] - 2026-10-18 — M0 Pulizia e portabilità macOS

### Added
- `README.md`, `CHANGELOG.md` e `ROADMAP.md`.
- Endpoint `GET /api/system` che indica quali strumenti esterni sono installati (`ssh`, `autossh`, `git`, `npm`, `pm2`, `lsof`, `ss`).
- Avvisi nella UI quando `pm2` o `autossh` mancano, con il comando per installarli e il pulsante "Ricontrolla".

### Changed
- Il pacchetto si chiama `devdock` (prima `port-forward-manager`); aggiunto `package-lock.json`.
- Il rilevamento delle porte dei processi npm usa `lsof` (macOS e Linux), con fallback a `ss` su Linux, e non passa più dalla shell.
- Il pulsante "PM2" negli script compare solo se `pm2` è installato.

### Fixed
- Le porte dei processi npm risultavano sempre vuote su macOS (`ss` non esiste).
- I tunnel e i processi npm restavano attivi chiudendo il server con `kill` (SIGTERM) o chiudendo il terminale (SIGHUP): ora vengono terminati come con Ctrl+C.
- Una configurazione nuova, o creata con una versione precedente, non aveva la chiave `projects`.

### Removed
- `index.html` nella root, duplicato non usato di `public/index.html`.
- File `Zone.Identifier` lasciato da Windows.

## [1.0.0] - 2026-10-18

Prima versione sotto controllo di versione.

### Added
- Tunnel SSH organizzati in gruppi, con riconnessione automatica, log e notifiche desktop.
- Progetti npm: esecuzione degli script con log in streaming, porte in ascolto, dipendenze e `npm outdated`.
- Gestione dei processi PM2.
- Client Git: status, commit, grafo dei commit, pull/push/merge/checkout/stash.
- Anteprima Swagger/OpenAPI.
- Configurazione in `config.json` con export e import.
