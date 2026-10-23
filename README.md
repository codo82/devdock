# DevDock

Local web dashboard for everyday development: SSH tunnels, npm scripts, PM2, Git and Swagger preview in a single interface.

It runs on your own machine and only answers on `http://127.0.0.1:3500`. The user interface is available in Italian and English, and new languages can be added with JSON files (see *Languages*).

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
- **📦 NPM** (`npm`) — the projects' `package.json` scripts: run the `package.json` scripts with live logs, restart/stop (the whole process group), listening ports, dependencies with installed version, `npm outdated` and updates. Projects are shared by NPM, Git and Env and can be grouped in **folders** (one level; ✎ on a project to move it, 📁+ to create a folder, ⋯ on a folder to rename or delete it); projects without a folder stay at the root of the sidebar.
- **🌿 Git** (`git`) — repositories derived from the projects (walking up to the `.git` folder); projects can be added here too. Status, file selection and commit, commit graph with branch legend, pull/push/merge/checkout/stash/fetch. Branch panel on the branch badge: search, local and remote branches, switch (with "stash and switch" when there are uncommitted changes, `--track` for remote branches), new branch from any start point, merge with a preview of incoming commits and files (fast-forward, `--no-ff`, `--squash`) and conflict handling (abort / conclude), deletion of local branches (unmerged ones only after confirmation). Only one git operation at a time runs on each repository.
- **🗄️ Database** (`db-client`) — MySQL/MariaDB client. Connections (direct or through an SSH tunnel of the Tunnels section) with passwords encrypted by a **master password** asked once per session; sidebar tree connection ▸ database ▸ tables ▸ columns with a context menu on tables, with connections grouped in **folders** of their own (one level; 📁+ to create one, the Folder field of the connection to move it, ⋯ or right click on a folder to rename or delete it); SQL editor with highlighting and **parametric queries** (`?` and `:name` placeholders: a dialog asks for the values, with the names of the `?` guessed from the query where possible, e.g. `nome = ?`, `id IN (?, ?)`, `BETWEEN ? AND ?`, `LIMIT ?`, `INSERT … VALUES (?, ?)`; values are escaped into the statement and kept in DevDock's memory until it restarts (never on disk or in the browser): a query already run runs again at once with its values, shown above the results with **✎ Change** to edit them; a new query asks, prefilled with the last values of the same names); data browser with pagination, search, filters and sorting; row insert/edit/delete inline or through a dialog, multiple deletion; several cells, also of different rows, can be edited before saving (changed cells are highlighted, Tab moves to the next cell, Enter or **Save** writes them all with one confirmation and in a single transaction), in the table data view and in the editable results of a SELECT; table designer; export of tables and queries as CSV, JSON or SQL; session query history. **Every statement that changes data or schema is shown and must be confirmed before it runs**; read-only connections refuse them.
- **🔑 Env** (`env`) — the `.env*` files of each project compared with the template (`.env.example`, `.env.sample`…): keys missing, extra or empty. Values are hidden and shown one at a time; edit, add, rename or delete keys, add the missing keys from the template, create a `.env` from the template. Files are rewritten keeping comments, blank lines and order; a file changed outside DevDock in the meantime is not overwritten. Values never go into the DevDock configuration, its exports or the MCP tools.
- **🔌 Ports** (`ports`) — listening TCP ports of the machine with process, PID, user and command line, linked to what DevDock started (npm script, PM2 process, SSH tunnel); search, "only my processes" filter, and stop of the process that holds a port after a confirmation: **Stop** (SIGTERM) or **Force stop** (SIGKILL, `taskkill /F` on Windows); processes started by DevDock are stopped through their section, also when forced, and if the port is still in use after a normal stop DevDock offers to force it. Only processes of the current user can be stopped. macOS/Linux (`lsof` or `ss`) and Windows (`netstat`).
- **📄 Swagger** (`swagger`) — preview of an OpenAPI `.yaml`/`.json` file loaded from disk (Swagger UI from CDN).
- **⚙️ PM2** (`pm2`) — process list, start/stop/restart/delete, streaming logs. Opened from the ⚙️ button in the header.

The header also holds the language (🌐), desktop notifications (🔔), **Export**/**Import** of the configuration, the MCP server (🤖) and ↻ to refresh. The sidebar can be resized by dragging its edge (or with ←/→ when the edge is focused; double click restores the initial width); each section has its own width, remembered by the browser.

## Database client

- **Master password**: the first time you open the Database section you create it (at least 10 characters). It encrypts the stored database passwords (scrypt + AES-256-GCM) and is never saved: only a verifier is kept in `config.json`. The key stays in the server's memory until you lock it (🔒), restart DevDock or after the inactivity timeout (30 minutes by default). If you forget it, the stored passwords are deleted and must be entered again; the connections remain.
- **Connections** can point to a host and port, or to a server of the Tunnels section (only if that extension is active): the tunnel is started when needed.
- **Confirmations**: reads (`SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`) run immediately; anything else — `INSERT`, `UPDATE`, `DELETE`, DDL, unknown statements — is shown in a confirmation dialog with the exact SQL and runs only after you confirm it. The same applies to rows edited in the data browser and to tables created with the designer.
- **Table designer**: create a table (database context menu or ＋ Tabella) or change an existing one (table context menu → *Edit structure*): columns with type, length, default, NULL, auto increment, position (↑ ↓), renames, primary key, indexes, foreign keys, engine and comment. The changes are applied together after a preview of the SQL; changes that may lose data (dropped columns or tables, narrower types) need an explicit confirmation.
- **Moving connections**: export them with the "Connessioni database" checkbox (passwords travel encrypted together with the vault). On a machine with a different master password, import them from the Database section (⤒) entering the file's master password: they are re-encrypted with yours.

## DB migrations

A connection can be linked to a **migrations folder in a repository** (📁 Migrations in the connection header): choose the repository (the Git extension's repositories, or the projects when Git is not active) and browse to the folder, or create it. From then on every structural change made through DevDock is written as a migration in that folder before it is applied to the database. With **💾 Save migration only** in the confirmation dialog the file is written but nothing runs on the database, so the project's own migration tool can apply it.

- **File format**: one SQL file per migration, `NNN_<table>_<operation>.sql` — for example `003_orders_add_status.sql` or `004_orders_alter.sql`. `NNN` is an incremental number with at least 3 digits (more when the folder already uses more); an empty folder starts at `001`. The file contains a short header comment (file, connection, database, date) and the statements, exactly as they run on the database.
- **Numbering**: the next number follows the highest one among the files in the folder. It is computed again right before writing and a file is never overwritten.
- **Where changes come from**: the table designer (new tables and *Edit structure* on existing ones) and `CREATE` / `ALTER` / `RENAME` / `DROP` statements typed in the SQL editor (*Save as migration…* in the confirmation dialog). Before applying, a dialog shows the SQL and the migration file; table and operation in the file name are proposed and can be changed. If a statement fails, the file is removed (or reduced to the statements that did run). Data changes (`INSERT` / `UPDATE` / `DELETE`) never produce migrations.
- Nothing is committed automatically: review and commit the files from the Git section.

## MCP server

DevDock is also an **MCP server**, so AI agents (Claude Code, Claude Desktop, any MCP client) can look at your development environment: tunnels, PM2 processes, Git repositories, npm projects and databases. Click 🤖 in the header for the endpoint, the token and ready-to-copy setup:

```bash
claude mcp add --transport http devdock http://127.0.0.1:3500/mcp --header "Authorization: Bearer <token>"
```

- **What an agent can do**: read tunnels and their status, listening ports and their processes, which `.env` keys are missing (never the values), PM2 processes and logs, Git repositories (branch, ahead/behind, status, log), npm projects and scripts, the output of npm processes; **start and stop npm scripts**; on databases list connections (without credentials), databases, tables and table structures, and run read-only queries (row limit, run in a `READ ONLY` transaction). Nothing else changes state.
- **Databases need the vault unlocked from the DevDock UI**: the master password never goes through the agent. When the vault is locked the tools answer with a clear error asking you to unlock it.
- **Access**: only on `127.0.0.1`, with a bearer token generated on first start and stored in `.devdock-mcp-token` next to `config.json` (not exported, regenerable from the 🤖 dialog). Requests coming from a browser are rejected.
- Tool names are prefixed with the extension (`git_status`, `npm_run`, `db_client_query`); errors carry the same codes as the API.

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
  "projectFolders": [
    { "id": "f1a2b3c4", "label": "Customers" }
  ],
  "projects": [
    { "id": "my_app", "label": "My App", "path": "/Users/me/www/my-app", "folder": "f1a2b3c4" }
  ]
}
```

- `servers[].port` — local port on `127.0.0.1`
- `servers[].remote` — `host:port` reached from the SSH server
- `servers[].alias` — host or alias from `~/.ssh/config` (authentication is ssh's own: keys, agent)
- `projects[].path` — absolute path of the project folder
- `projects[].folder` — optional sidebar folder (`projectFolders[].id`); without it the project is at the root of the sidebars

Each key belongs to the core (`projects` and `projectFolders`, shared by NPM, Git and Env) or to an extension (`groups` and `servers` to tunnels, `dbConnections`, `dbFolders` and `vault` to db-client), which validates it on every save. **Export** offers the checkboxes of the core (Progetti e cartelle) and of the extensions (Tunnel SSH, Connessioni database) and downloads one `.json` file; **Import** shows the checkboxes found in the file and lets you *merge* (add new items) or *replace* (overwrite those sections). Anything not selected is left untouched.

## Languages

DevDock starts in the browser's language when it has a catalog for it (a regional variant such as `pt-BR` falls back to `pt`), otherwise in Italian. The 🌐 button in the header switches language without reloading the page; the choice is remembered by the browser. Dates, numbers, sizes and durations follow the selected language. Output of external commands (`git`, `npm`, `pm2`, `ssh`, MySQL) is shown as it is.

Languages are not listed anywhere in the code: a language exists when its catalog exists. Italian is the source language (always complete, and the fallback for any missing text). To add a language, for example German (`de`):

1. Copy `public/core/i18n/it.json` to `public/core/i18n/de.json` and translate the values (keep the keys and the `{placeholders}`); set `_meta`: `{ "name": "German", "nativeName": "Deutsch", "dir": "ltr" }` (`"rtl"` for right-to-left languages).
2. For each extension, copy `extensions/<code>/i18n/it.json` to `de.json` and translate it.
3. Plurals are objects with the forms the language needs (`zero`, `one`, `two`, `few`, `many`, `other`; `other` is required): `{ "one": "{count} Datei", "other": "{count} Dateien" }`.
4. Run `npm run i18n:report -- de` to see the completeness and the missing keys, and `npm test` to check the catalogs (stale keys, placeholders, plural forms). Missing keys are allowed: they fall back to Italian.
5. Restart DevDock: the language appears in the 🌐 menu with its completeness.

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
                     validators, external tools, port detection, SSE, MCP server
routes/core.js       core API (/api/core): extensions, system, config export/import
public/              UI shell: index.html, core/shell.js (navigation, header, dialogs),
                     core/ui.js (shared helpers), core/i18n.js (translations and
                     formatting), core/i18n/<lang>.json (core catalogs), core/shell.css
extensions/<code>/   one folder per feature: setting.json, server.js, view.html,
                     sidebar.html, view.js, style.css, i18n/<lang>.json
scripts/             i18n-report.js (translation completeness)
tests/               integration tests (node:test)
docs/EXTENSIONS.md   extension contract
```

## Writing an extension

1. Create `extensions/<code>/setting.json` with name, code, colour and position (tab or header button).
2. Declare the API in `backend.routes` and implement the handlers in `server.js`; they are served under `/api/ext/<code>`.
3. Declare the `config.json` keys the extension owns (`config`) and the checkboxes it adds to the Export/Import dialogs (`export`).
4. Add `view.html`, `sidebar.html`, `view.js` and `style.css` for the UI, with the texts in `i18n/it.json` (and `i18n/en.json`), used through `data-i18n` attributes and `ctx.t()`.
5. Restart DevDock: the startup log lists the loaded extensions, and `GET /api/core/extensions` explains why one was disabled.

The full contract — manifest fields, the `ctx` objects given to backend and frontend, configuration sections, dependencies between extensions, npm workspaces — is in [docs/EXTENSIONS.md](docs/EXTENSIONS.md).

## Development

```bash
npm test           # integration tests: each file starts DevDock with a temporary config
npm run dev        # restarts on backend changes
npm run i18n:report  # translation completeness per language and extension
```

Roadmap and progress: [ROADMAP.md](ROADMAP.md) · Changes: [CHANGELOG.md](CHANGELOG.md)
