# DevDock

Dashboard web locale per lo sviluppo quotidiano: tunnel SSH, script npm, PM2, Git e anteprima Swagger in un'unica interfaccia.

Gira sul proprio computer e risponde solo su `http://127.0.0.1:3500`.

## Requisiti

| Strumento | Necessario | Uso |
|---|---|---|
| Node.js ≥ 18 | sì | server |
| `ssh` | per i tunnel | port forward `-L` (usa gli alias di `~/.ssh/config`) |
| `git` | per la sezione Git | |
| `autossh` | no | se presente viene usato per i tunnel; altrimenti `ssh` con riconnessione gestita da DevDock |
| `pm2` | no | sezione PM2 |
| `lsof` (macOS/Linux) o `ss` (Linux) | no | mostra le porte in ascolto dei processi npm |

La UI segnala gli strumenti opzionali mancanti e indica come installarli.

## Avvio

```bash
npm install
npm start          # oppure: npm run dev  (riavvio automatico alle modifiche)
```

Poi apri <http://127.0.0.1:3500>.

Alla chiusura del server (Ctrl+C, `kill` o chiusura del terminale) i tunnel e i processi npm avviati da DevDock vengono terminati.

## Sezioni

- **🔗 Tunnel SSH** — server raggruppati per colore; un clic apre `ssh -N -L 127.0.0.1:<porta>:<remote> <alias>`. Riconnessione automatica con backoff (5s → 60s), log per tunnel, notifiche desktop, "Stop all".
- **📦 NPM** — progetti locali: esecuzione degli script di `package.json` con log in tempo reale, riavvio/stop (dell'intero process group), porte in ascolto, dipendenze con versione installata e `npm outdated`.
- **⚙️ PM2** — lista dei processi, start/stop/restart/delete, log in streaming. Si apre dall'icona ⚙️ nell'header.
- **🌿 Git** — i repository vengono ricavati dai progetti NPM (risalendo fino alla cartella `.git`). Status, selezione file e commit, grafo dei commit, pull/push/merge/checkout/stash/fetch.
- **📄 Swagger** — anteprima di un file OpenAPI `.yaml`/`.json` caricato dal disco (Swagger UI da CDN).
- **≡ Configurazione** — gestione di gruppi e server dei tunnel; dall'header export/import della configurazione.

## Configurazione

Tutto è salvato in `config.json` nella cartella del progetto. Il file viene creato vuoto al primo avvio ed è escluso da git perché contiene host e percorsi personali.

```json
{
  "groups": [
    { "key": "staging", "label": "Staging", "color": "#3b82f6", "servers": ["staging_db"] }
  ],
  "servers": [
    { "key": "staging_db", "label": "DB staging", "port": 33060, "remote": "10.0.0.5:3306", "alias": "bastion-staging", "type": "MySQL" }
  ],
  "projects": [
    { "id": "my_app", "label": "My App", "path": "/Users/me/www/my-app" }
  ]
}
```

- `servers[].port` — porta locale su `127.0.0.1`
- `servers[].remote` — `host:porta` raggiunto dal server SSH
- `servers[].alias` — host o alias di `~/.ssh/config` (l'autenticazione è quella di ssh: chiavi, agent)
- `projects[].path` — percorso assoluto della cartella con `package.json`

L'export può comprendere tutto, solo i tunnel o solo i progetti; l'import può sostituire la configurazione o unirla a quella attuale.

## Sicurezza

DevDock è pensato **solo per uso locale**: ascolta su `127.0.0.1` e non ha autenticazione. Può eseguire `ssh`, `npm`, `git` e `pm2` sul tuo computer, quindi non va esposto in rete. Le protezioni contro richieste da altre pagine web aperte nel browser sono pianificate nella milestone M1 della [roadmap](ROADMAP.md).

## Sviluppo

- Backend: `server.js` (Express)
- Frontend: `public/index.html` (HTML, CSS e JavaScript vanilla in un unico file, nessuna build)

Roadmap e stato dei lavori: [ROADMAP.md](ROADMAP.md) · Modifiche: [CHANGELOG.md](CHANGELOG.md)
