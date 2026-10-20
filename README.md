# DevDock

Local web dashboard for everyday development: SSH tunnels, npm scripts, PM2, Git and Swagger preview in a single interface.

It runs on your own machine and only answers on `http://127.0.0.1:3500`. The user interface is in Italian.

## Requirements

| Tool | Required | Used for |
|---|---|---|
| Node.js ≥ 18 | yes | server |
| `ssh` | for tunnels | `-L` port forwarding (uses the aliases in `~/.ssh/config`) |
| `git` | for the Git section | |
| `autossh` | no | used for tunnels when available; otherwise `ssh` with reconnection handled by DevDock |
| `pm2` | no | PM2 section |
| `lsof` (macOS/Linux) or `ss` (Linux) | no | shows the listening ports of npm processes |

The UI reports missing optional tools and shows how to install them.

## Getting started

```bash
npm install
npm start          # or: npm run dev  (restarts automatically on changes)
```

Then open <http://127.0.0.1:3500>.

Optional environment variables: `DEVDOCK_PORT` (port, default 3500) and `DEVDOCK_CONFIG` (configuration path, default `config.json` in the project folder).

When the server stops (Ctrl+C, `kill` or closing the terminal), the tunnels and npm processes started by DevDock are terminated.

## Sections

Each section is an extension (see [Writing an extension](#writing-an-extension)):

- **🔗 SSH tunnels** (`tunnels`) — servers grouped by colour; one click opens `ssh -N -L 127.0.0.1:<port>:<remote> <alias>`. Automatic reconnection with backoff (5s → 60s), per-tunnel logs, header pills with "Stop all", desktop notifications. Groups and servers are managed from the ≡ button in the sidebar.
- **📦 NPM** (`npm`) — local projects: run the `package.json` scripts with live logs, restart/stop (the whole process group), listening ports, dependencies with installed version, `npm outdated` and updates.
- **🌿 Git** (`git`) — repositories derived from the NPM projects (walking up to the `.git` folder). Status, file selection and commit, commit graph with branch legend, pull/push/merge/checkout/stash/fetch. Branch panel on the branch badge: search, local and remote branches, switch (with "stash and switch" when there are uncommitted changes, `--track` for remote branches), new branch from any start point, merge with a preview of incoming commits and files (fast-forward, `--no-ff`, `--squash`) and conflict handling (abort / conclude), deletion of local branches (unmerged ones only after confirmation). Only one git operation at a time runs on each repository.
- **🗄️ Database** (`db-client`) — MySQL/MariaDB client. Connections (direct or through an SSH tunnel of the Tunnels section) with passwords encrypted by a **master password** asked once per session; sidebar tree connection ▸ database ▸ tables ▸ columns with a context menu on tables; SQL editor with highlighting; data browser with pagination, search, filters and sorting; row insert/edit/delete inline or through a dialog, multiple deletion; table designer; export of tables and queries as CSV, JSON or SQL; session query history. **Every statement that changes data or schema is shown and must be confirmed before it runs**; read-only connections refuse them.
- **📄 Swagger** (`swagger`) — preview of an OpenAPI `.yaml`/`.json` file loaded from disk (Swagger UI from CDN).
- **⚙️ PM2** (`pm2`) — process list, start/stop/restart/delete, streaming logs. Opened from the ⚙️ button in the header.

The header also holds desktop notifications (🔔), **Export**/**Import** of the configuration and ↻ to refresh.

## Database client

- **Master password**: the first time you open the Database section you create it (at least 10 characters). It encrypts the stored database passwords (scrypt + AES-256-GCM) and is never saved: only a verifier is kept in `config.json`. The key stays in the server's memory until you lock it (🔒), restart DevDock or after the inactivity timeout (30 minutes by default). If you forget it, the stored passwords are deleted and must be entered again; the connections remain.
- **Connections** can point to a host and port, or to a server of the Tunnels section (only if that extension is active): the tunnel is started when needed.
- **Confirmations**: reads (`SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`) run immediately; anything else — `INSERT`, `UPDATE`, `DELETE`, DDL, unknown statements — is shown in a confirmation dialog with the exact SQL and runs only after you confirm it. The same applies to rows edited in the data browser and to tables created with the designer.
- **Moving connections**: export them with the "Connessioni database" checkbox (passwords travel encrypted together with the vault). On a machine with a different master password, import them from the Database section (⤒) entering the file's master password: they are re-encrypted with yours.

## Configuration

Everything is stored in `config.json` in the project folder. The file is created empty on first start and is excluded from git because it contains personal hosts and paths.

```json
{
  "groups": [
    { "key": "staging", "label": "Staging", "color": "#3b82f6", "servers": ["staging_db"] }
  ],
  "servers": [
    { "key": "staging_db", "label": "Staging DB", "port": 33060, "remote": "10.0.0.5:3306", "alias": "bastion-staging", "type": "MySQL" }
  ],
  "projects": [
    { "id": "my_app", "label": "My App", "path": "/Users/me/www/my-app" }
  ]
}
```

- `servers[].port` — local port on `127.0.0.1`
- `servers[].remote` — `host:port` reached from the SSH server
- `servers[].alias` — host or alias from `~/.ssh/config` (authentication is ssh's own: keys, agent)
- `projects[].path` — absolute path of the folder containing `package.json`

Each key belongs to an extension (`groups` and `servers` to tunnels, `projects` to npm, `dbConnections` and `vault` to db-client), which validates it on every save. **Export** offers the checkboxes declared by the extensions (Tunnel SSH, Progetti NPM, Connessioni database) and downloads one `.json` file; **Import** shows the checkboxes found in the file and lets you *merge* (add new items) or *replace* (overwrite those sections). Anything not selected is left untouched.

## Security

DevDock is meant **for local use only**: it listens on `127.0.0.1` and has no authentication. It can run `ssh`, `npm`, `git` and `pm2` on your machine, so it must not be exposed on a network.

Active protections:
- the API only accepts requests from its own UI (`Origin`/`Referer` and `Host` checks), so other pages open in the browser cannot use it;
- every parameter that ends up in a command (branch, remote, file, script, package, SSH alias) is validated;
- `config.json` is validated on every save and import;
- external libraries (Swagger UI) are loaded with Subresource Integrity.

Local command-line clients (curl, scripts) that send no `Origin` header are allowed, like any other local program.

## Project structure

```
server.js            entry point: security middleware, extension loader, core API, startup
lib/                 core services: config by section, extension loader, security,
                     validators, external tools, port detection, SSE
routes/core.js       core API (/api/core): extensions, system, config export/import
public/              UI shell: index.html, core/shell.js (navigation, header, dialogs),
                     core/ui.js (shared helpers), core/shell.css
extensions/<code>/   one folder per feature: setting.json, server.js, view.html,
                     sidebar.html, view.js, style.css
tests/               integration tests (node:test)
docs/EXTENSIONS.md   extension contract
```

## Writing an extension

1. Create `extensions/<code>/setting.json` with name, code, colour and position (tab or header button).
2. Declare the API in `backend.routes` and implement the handlers in `server.js`; they are served under `/api/ext/<code>`.
3. Declare the `config.json` keys the extension owns (`config`) and the checkboxes it adds to the Export/Import dialogs (`export`).
4. Add `view.html`, `sidebar.html`, `view.js` and `style.css` for the UI.
5. Restart DevDock: the startup log lists the loaded extensions, and `GET /api/core/extensions` explains why one was disabled.

The full contract — manifest fields, the `ctx` objects given to backend and frontend, configuration sections, dependencies between extensions, npm workspaces — is in [docs/EXTENSIONS.md](docs/EXTENSIONS.md).

## Development

```bash
npm test           # integration tests: each file starts DevDock with a temporary config
npm run dev        # restarts on backend changes
```

Roadmap and progress: [ROADMAP.md](ROADMAP.md) · Changes: [CHANGELOG.md](CHANGELOG.md)
