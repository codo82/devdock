# DevDock — Roadmap

Open work, numbered again from M1 after DevDock 2.1.0. The milestones closed up to 2.1.0 (M0–M17, with their original numbers, the ones the CHANGELOG uses) are archived in [docs/ROADMAP-HISTORY.md](docs/ROADMAP-HISTORY.md).

Status legend: `[ ]` to do · `[~]` in progress · `[x]` done

**Rules for every milestone**
- A milestone is closed only when `CHANGELOG.md` (`[Unreleased]` → version) and, when something changes for the user, `README.md` and `docs/EXTENSIONS.md` are updated.
- Versioning is SemVer: a closed milestone that changes DevDock is a new minor version (M1 → 2.2.0, M2 → 2.3.0 and its follow-ups, …); a major version only when the extension contract changes (it would make every extension declaring `"devdock": "^2.0"` incompatible).
- Work on an extension of the [devdock-extensions](https://github.com/codo82/devdock-extensions) repository is released there with its own version and tag (`<code>@<version>`); DevDock gets a new version only if the core changes too.

---

## M1 — MCP: stdio bridge — core ✅ (2.2.0)

Goal: Claude Desktop and the other clients that start MCP servers as processes reach DevDock without a token in their configuration and without third-party packages. *(Formerly part of M8.13.)*

- [x] **M1.1** `bin/devdock-mcp.js` (also `devdock mcp` and the `devdock-mcp` bin): stdio ↔ Streamable HTTP with the MCP SDK already used by the server; port and token file of the instance from `DEVDOCK_PORT` / `DEVDOCK_CONFIG` like the server; the token is read again at every request (a 401 is retried once), so the bridge survives a regeneration; DevDock not running or a token of another instance → a JSON-RPC error with a clear message (core catalogs)
- [x] **M1.2** The server creates the token on the first access to `/mcp` even when the request has no `Authorization` header (first start of the bridge)
- [x] **M1.3** 🤖 dialog: the Claude Desktop entry uses the bridge (absolute paths of Node.js and of the bridge, `env` only when the instance is not the default one) instead of `npx mcp-remote` with the token in clear
- [x] **M1.4** Tests (SDK stdio client through the bridge: tools listed and called, token regenerated while connected, DevDock not running, token of another instance), README

## M2 — Secrets behind the master password, lost clicks — core and extensions ✅ (2.3.0 – 2.5.0)

Goal: no secret is typed or kept without the master password, and a click on a button always lands — or visibly works.

- [x] **M2.1** HTTP client: the 👤 Users dialog asks for the master password (or creates it) before opening; creating or editing a user type, pasting a token and logging in are refused by the server with the vault locked (`423`); the tokens kept in memory are forgotten when the vault is locked
- [x] **M2.2** MongoDB (`mongo-client@1.2.0`): the whole section needs the master password, like the Database section; locked, the sidebar shows *Unlock* and every route answers `423`
- [x] **M2.3** Core `ctx.ui.patch(el, html)`: containers redrawn on their own are updated only when their HTML changes, and after the click when the mouse is pressed inside them (a button replaced between mousedown and click lost the click); used by the header pills, SSH tunnels and NPM (polling every 5 s), Git (automatic refresh, which no longer shows "loading" over the log), Database (data grid, results, table designer) and MongoDB
- [x] **M2.4** Master password dialog closed by clicking outside it or replaced by another dialog: the waiting action gives up instead of staying suspended (before, every later action needing the vault did nothing until the page was reloaded)
- [x] **M2.5** *(2.3.1)* Feedback after a click: a request to the server started by a click puts the button on hold (spinner, no further clicks) and the cursor in "busy" until the answer, so slow actions (reading an extension's repository, the master password, connecting to a database) no longer look like lost clicks
- [x] **M2.6** *(2.4.0)* HTTP client OAuth: browser executable for the logins (WSL recognised: Windows Firefox or the Windows default browser), error and login link when the browser cannot start; client secret available with PKCE too (confidential Keycloak clients)
- [x] **M2.7** *(2.4.1)* HTTP client sidebar: requests grouped by user type (section ▸ user ▸ requests), new request per user, move under another user
- [x] **M2.8** *(2.5.0)* HTTP client files: body *File* and *Multipart form* read from disk when sending (path absolute or relative to the project); binary answers saved to Downloads with the name from `Content-Disposition` or the Content-Type

## M3 — Widgets and project dashboard — core and built-in extensions

Goal: every extension can share a **mini view** (widget) of what it knows about a project, and a new **Dashboard** section puts the widgets of one project together: the npm scripts used most, the Git state with pull/push, the project's database, its to-do list… Today extensions share data only through backend services (`ctx.require`) and frontend events (`ctx.bus`); a widget adds a shared piece of UI, with no extension needing to know the others.

- [ ] **M3.1** Widget contract (`docs/EXTENSIONS.md`, additive: extensions without widgets don't change): manifest block `widgets: [{ id, title, scope: "project", size: "s" | "m" | "l", js }]`; the widget module exports `mount(ctx, el, { project })`, optional `refresh`, `unmount`, with the extension's own frontend `ctx` (its API, translations, `ctx.ui`, `ctx.vault`) plus `ctx.widget`: `setBadge`, `setTitle`, `openFull(params)` (opens the extension's section on that project). Widgets are listed by `/api/core/extensions`; a widget that fails shows its error in its own box and never breaks the others
- [ ] **M3.2** Core widget host: `ctx.widgets.list(scope)` and `ctx.widgets.mount(id, el, params)` for any extension that wants to show widgets; modules loaded on demand with the extension's CSS and catalogs; the same click-feedback and redraw rules as the panels (M2)
- [ ] **M3.3** Built-in extension `dashboard` (tab): project selector (the core projects, also from a link in NPM/Git/the sidebar), grid of the widgets for that project; per project the user chooses which widgets to show, their order (drag) and size, saved in its config section; *Add widget* lists the widgets of the loaded extensions; refresh on ↻ and when the tab is shown
- [ ] **M3.4** Widgets of the built-in extensions:
  - **NPM** — scripts used most in the project (run counter kept by the extension in the DevDock home, not in `config.json`), running processes with ports, run/stop/restart, a link to the logs
  - **Git** — branch, ahead/behind, changed files, last commits; fetch, pull and push (push after a confirmation showing the commits that will be sent)
  - **Database** — connections linked to the project (`projectId`, already there): status, pending migrations of the linked repository, a link that opens the connection
  - **Env** — `.env` files of the project with missing or empty keys compared with the template (never the values)
  - **HTTP** — sections linked to the project: their requests, with send from the widget and the status of the last answer
  - **SSH tunnels** — the tunnels used by the project's database connections, with connect/disconnect
- [ ] **M3.5** Widgets of the installed extensions in devdock-extensions, each released with its own version: `mongo-client` (connections linked to a project — needs a `projectId` field like the DB client), `ports` (ports in use by the project's processes); `notes` gets its widget in M4.6
- [ ] **M3.6** Tests (contract and host with fixture extensions, a broken widget isolated, dashboard layout saved per project), README section "Dashboard", CHANGELOG

## M4 — Notes and to-do lists — new external extension `notes` (devdock-extensions)

Goal: notes and to-do lists kept next to the code, grouped in sections (folders) that can be linked to a project. Small and self-contained, so it is born as an installable extension in `devdock-extensions` (`notes@1.0.0`, `"devdock": "^2.4"` for the widget contract of M3); the core does not change, NPM and Git only get a link to it (M4.5). Nothing secret is meant to go here: notes are stored in clear like the rest of the configuration.

- [ ] **M4.1** Data: sections (one level, like the DB client folders) with name, colour and an optional linked project (`projectId` of the core projects); each section holds notes and to-do lists, in the order chosen by the user. Note: title, Markdown text, last change. To-do list: title and items (text, done, done date), at most a few hundred items per list. Stored in the extension's own config section (`notes`), validated on every save, with an Export/Import checkbox "Note e to-do"
- [ ] **M4.2** Sidebar: sections ▸ notes and lists, with the number of open items per list and per section; new section / note / list, rename, move between sections, delete (with confirmation), drag to reorder; filter by text; a project selector that shows only the sections linked to it (plus the unlinked ones)
- [ ] **M4.3** Note editor: Markdown text with a preview (headings, lists, checkboxes, links, code, tables; rendered without external libraries and escaped, links opened outside DevDock), saved automatically a moment after the last keystroke, "saved" indicator; a note changed elsewhere in the meantime is not overwritten
- [ ] **M4.4** To-do lists: add an item with Enter, edit in place, check/uncheck, reorder by dragging, delete; done items collapsed at the bottom with their date and a *Clear done* action; the badge on the tab counts the open items
- [ ] **M4.5** Link with the projects: the section's project shown in the sidebar and in the header of the note; a project removed from DevDock leaves the section unlinked, not deleted; from the NPM and Git sections, a link *Notes of this project* opens the extension filtered on that project (`ctx.open` and the event bus, only when `notes` is installed)
- [ ] **M4.6** Widget for the project dashboard (M3): open items of the to-do lists of the project's sections (check them from the widget, add one) and the last notes changed
- [ ] **M4.7** Search across titles, notes and items with the matches highlighted; tests (with the DevDock test kit), README, CHANGELOG, release `notes@1.0.0`

## M5 — DB client: PostgreSQL and SQL Server — extension `db-client`

Goal: the Database section works with PostgreSQL and Microsoft SQL Server as well as MySQL/MariaDB, with the same features and the same safety rules (every change shown and confirmed before it runs, read-only connections, passwords in the core vault). *(Formerly M16; replaces the even older M5.7 and M7.15.)*

- [ ] **M5.1** Engine layer in `db-client`: one module per engine (`engines/mysql.js`, `engines/postgres.js`, `engines/mssql.js`) with pool and connection, query with timeout and row limit, read-only transaction, identifier quoting and value escaping, pagination, list of databases/schemas/tables, introspection and error mapping. MySQL moves onto it first with no change in behaviour (the existing tests stay green). Connection field `type`: `mysql` (default), `postgres`, `mssql`, with default ports 3306 / 5432 / 1433. Drivers as npm workspace dependencies of `db-client`: `pg` and `mssql` (tedious), both pure JavaScript, so they work the same on macOS and Windows; SQL Server uses SQL authentication only (Windows integrated authentication would need a native driver)
- [ ] **M5.2** Per-dialect statement classification (only recognised reads run without confirmation): PostgreSQL dollar quoting, `E''` strings, `::` casts, `RETURNING`, `COPY`, `DO`, `LISTEN`/`NOTIFY`; SQL Server `[brackets]`, `N''` strings, `EXEC`, `MERGE`, `SELECT … INTO` (a write), `GO` batch separator refused. Parametric queries keep `?` and `:name` in the editor and are bound with the engine's syntax
- [ ] **M5.3** Connection options per engine: PostgreSQL `sslmode`, SQL Server `encrypt` / `trustServerCertificate` (needed for local Docker and Azure), default database, through an SSH tunnel as today; connection test
- [ ] **M5.4** Sidebar tree with schemas for PostgreSQL and SQL Server: connection ▸ database ▸ schema ▸ tables/views ▸ columns (MySQL unchanged), context menu on tables as today; SQL editor highlighting with each dialect's keywords
- [ ] **M5.5** Data browser for the new engines: pagination (`LIMIT/OFFSET`, `OFFSET … FETCH`), search, filters, sorting, inline and dialog edit, multiple deletion, multi-cell edit in one transaction; types shown and edited correctly (PostgreSQL arrays, `json`/`jsonb`, `uuid`, `bytea`; SQL Server `uniqueidentifier`, `datetime2`, `varbinary`, identity columns); export as CSV, JSON and SQL
- [ ] **M5.6** Table designer and schema changes per dialect: list of types, identity/serial columns, defaults, indexes, foreign keys; generated `ALTER` statements (PostgreSQL `ALTER COLUMN … TYPE/SET DEFAULT/SET NOT NULL`; SQL Server `sp_rename`, named default constraints); DDL in a transaction where the engine allows it, so a failure leaves nothing half applied
- [ ] **M5.7** Migrations for the new engines in the same `NNN_<table>_<operation>.sql` files, with the dialect's SQL
- [ ] **M5.8** The existing MCP tools of the DB client (`db_client_*`) keep working with the new engines (with schemas; reads in a read-only transaction: `BEGIN READ ONLY` on PostgreSQL, a transaction always rolled back on SQL Server plus the classification of the statement); no new MCP features
- [ ] **M5.9** Tests (in `extensions/db-client/tests/`, with the core test kit): per-dialect unit tests that need no server (classification, quoting, pagination, DDL generation, introspection mapping), integration tests against disposable PostgreSQL and SQL Server servers when they are available (skipped otherwise, like the MySQL ones); README, CHANGELOG

## M6 — Installation script and DevDock updates from the interface — core

Goal: DevDock is installed with one command and kept up to date from the header, like the installed extensions; it runs under PM2, so a restart after an update is handled for you.

- [ ] **M6.1** Installation script (`install.sh` for macOS/Linux/WSL, `install.ps1` for Windows): checks Node.js (minimum version) and PM2 (offers `npm i -g pm2` when missing), clones DevDock at the latest release tag into a chosen folder (default `~/devdock`), runs `npm install --ignore-scripts`, starts it with `pm2 start` (process name `devdock`, `DEVDOCK_PORT` if given) and `pm2 save`; run again on an existing installation, it updates it. Idempotent, with a clear message at every step; never touches an existing `config.json`
- [ ] **M6.2** Update check of DevDock itself: the latest `v<x.y.z>` tag of the repository compared with the running version (at start-up, once a day and on demand, like the extensions); a dot on the header (🧩 or a dedicated button) and *DevDock x.y.z available* in the Extensions panel, with the CHANGELOG of the versions in between
- [ ] **M6.3** *Update DevDock* from the interface, only for a git checkout with no local changes: `git fetch --tags`, checkout of the new tag (fast-forward only, refused with a clear message otherwise), `npm install --ignore-scripts`, progress shown live; the previous tag is kept for a *previous version*. Confirmation first: tunnels, npm processes and mock servers started by DevDock stop at the restart
- [ ] **M6.4** Restart: under PM2 (`pm_id` in the environment) DevDock asks PM2 to restart it (`pm2 restart devdock` run detached) and the page shows *restarting…*, polls `/api/core/system` until the new version answers and reloads itself (with a timeout and the manual command if it does not come back); without PM2 the update is applied and the page says to restart by hand
- [ ] **M6.5** Tests (update check against a local repository with tags, refused update with local changes, restart request mocked), README (installation and updates), CHANGELOG

---

## Parked

Not planned for now; to be taken back into the roadmap when needed (descriptions in [docs/ROADMAP-HISTORY.md](docs/ROADMAP-HISTORY.md), section M8):

- MCP server: activity log of the calls (ex M8.12), resources and `list_changed` notifications (rest of ex M8.13), state-changing tools enabled one by one (ex M8.11)
- Swagger: specs kept on the server and read-only MCP tools (ex M8.14), in the `swagger` extension of devdock-extensions

---

## Suggested order and size

| Milestone | Size | Where | Notes |
|---|---|---|---|
| M1 MCP stdio bridge | S | core | done in 2.2.0 |
| M2 Secrets and lost clicks | S | core, `http-client`, `mongo-client` | done in 2.3.0 |
| M3 Widgets and project dashboard | M | core contract and host, built-in `dashboard`, widgets in every extension | widget contract first, then the dashboard, then one widget per extension |
| M4 Notes and to-do lists | S | `notes` (devdock-extensions); link in NPM and Git | sections linked to projects, with a dashboard widget from the start |
| M5 PostgreSQL and SQL Server | L | `db-client` | engine layer first (MySQL moved onto it with no change), then one dialect at a time |
| M6 Install script and updates from the interface | M | core, `install.sh`/`install.ps1` | script first (PM2 is the base of the restart), then check, update and restart from the interface |
