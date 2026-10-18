# Changelog

Tutte le modifiche rilevanti di DevDock sono documentate in questo file.

Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e il progetto usa il [Semantic Versioning](https://semver.org/lang/it/). Ogni milestone della [roadmap](ROADMAP.md) chiusa corrisponde a una versione minor.

## [Unreleased]

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
