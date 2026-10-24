# DevDock — Roadmap

Open work, numbered again from M1 after DevDock 2.1.0. The milestones closed up to 2.1.0 (M0–M17, with their original numbers, the ones the CHANGELOG uses) are archived in [docs/ROADMAP-HISTORY.md](docs/ROADMAP-HISTORY.md).

Status legend: `[ ]` to do · `[~]` in progress · `[x]` done

**Rules for every milestone**
- A milestone is closed only when `CHANGELOG.md` (`[Unreleased]` → version) and, when something changes for the user, `README.md` and `docs/EXTENSIONS.md` are updated.
- Versioning is SemVer: a closed milestone that changes DevDock is a new minor version (M1 → 2.2.0, …); a major version only when the extension contract changes (it would make every extension declaring `"devdock": "^2.0"` incompatible).
- Work on an extension of the [devdock-extensions](https://github.com/codo82/devdock-extensions) repository is released there with its own version and tag (`<code>@<version>`); DevDock gets a new version only if the core changes too.

---

## M1 — MCP: activity log and stdio bridge — core

Goal: see what agents do through the MCP server, and reach it from clients that only speak stdio. *(Formerly M8.12 and M8.13.)*

- [ ] **M1.1** Activity log of the MCP calls in the 🤖 dialog: time, tool, arguments (secrets redacted, long values cut), outcome or error code, duration; kept in memory (last 500 calls), cleared on restart, never written to `config.json`
- [ ] **M1.2** stdio bridge `npx devdock-mcp` (bin of the `devdock` package): forwards stdio to the running instance's `/mcp` endpoint with the token read from the DevDock home, clear message when DevDock is not running
- [ ] **M1.3** MCP resources (read-only views such as the project list and the extension list) and `list_changed` notifications when extensions are switched on, off, installed or removed
- [ ] **M1.4** Tests (bridge against a test instance, log contents and redaction), README section "MCP server" and `docs/EXTENSIONS.md` updated

## M2 — MCP: state-changing tools, enabled one by one — core and extensions

Goal: let agents act, not only read, but only where the user allows it. *(Formerly M8.11.)*

- [ ] **M2.1** Contract: `readOnly: false` tools are off by default; the 🤖 dialog lists them per extension with a switch each, saved in `config.json` (core section, exported); calls to a disabled tool return a clear error code
- [ ] **M2.2** Tools: SSH tunnels start/stop; git pull/push/fetch (the same validation and one-operation-per-repository lock as the UI); PM2 restart in the `pm2` extension
- [ ] **M2.3** DB client: DDL and data changes only through the migration pipeline (the agent writes the migration file, the user applies it from the UI); never direct writes
- [ ] **M2.4** Every state-changing call shown in the activity log of M1.1 and as a desktop notification (🔔) when enabled
- [ ] **M2.5** Tests, README, `docs/EXTENSIONS.md` (how an extension declares a state-changing tool)

## M3 — Swagger: specs kept on the server and MCP tools — extension `swagger` (devdock-extensions)

Goal: agents can read the API specs loaded in DevDock. *(Formerly M8.14; Swagger is an external extension since DevDock 2.1.)*

- [ ] **M3.1** Backend for the `swagger` extension: specs added from a file path or linked to a project (`openapi.yaml`, `swagger.json` found in the project), saved in its own config section and reloaded from disk when they change; the UI keeps working with files loaded only in the browser
- [ ] **M3.2** MCP tools (read-only): list of the specs, operations of a spec (method, path, summary, tags), detail of an operation (parameters, request body and responses schemas, with `$ref` resolved)
- [ ] **M3.3** Tests, README and CHANGELOG of the extension; release `swagger@1.1.0`

## M4 — DB client: PostgreSQL and SQL Server — extension `db-client`

Goal: the Database section works with PostgreSQL and Microsoft SQL Server as well as MySQL/MariaDB, with the same features and the same safety rules (every change shown and confirmed before it runs, read-only connections, passwords in the core vault). Not urgent. *(Formerly M16; replaces the even older M5.7 and M7.15.)*

- [ ] **M4.1** Engine layer in `db-client`: one module per engine (`engines/mysql.js`, `engines/postgres.js`, `engines/mssql.js`) with pool and connection, query with timeout and row limit, read-only transaction, identifier quoting and value escaping, pagination, list of databases/schemas/tables, introspection and error mapping. MySQL moves onto it first with no change in behaviour (the existing tests stay green). Connection field `type`: `mysql` (default), `postgres`, `mssql`, with default ports 3306 / 5432 / 1433. Drivers as npm workspace dependencies of `db-client`: `pg` and `mssql` (tedious), both pure JavaScript, so they work the same on macOS and Windows; SQL Server uses SQL authentication only (Windows integrated authentication would need a native driver)
- [ ] **M4.2** Per-dialect statement classification (only recognised reads run without confirmation): PostgreSQL dollar quoting, `E''` strings, `::` casts, `RETURNING`, `COPY`, `DO`, `LISTEN`/`NOTIFY`; SQL Server `[brackets]`, `N''` strings, `EXEC`, `MERGE`, `SELECT … INTO` (a write), `GO` batch separator refused. Parametric queries keep `?` and `:name` in the editor and are bound with the engine's syntax
- [ ] **M4.3** Connection options per engine: PostgreSQL `sslmode`, SQL Server `encrypt` / `trustServerCertificate` (needed for local Docker and Azure), default database, through an SSH tunnel as today; connection test
- [ ] **M4.4** Sidebar tree with schemas for PostgreSQL and SQL Server: connection ▸ database ▸ schema ▸ tables/views ▸ columns (MySQL unchanged), context menu on tables as today; SQL editor highlighting with each dialect's keywords
- [ ] **M4.5** Data browser for the new engines: pagination (`LIMIT/OFFSET`, `OFFSET … FETCH`), search, filters, sorting, inline and dialog edit, multiple deletion, multi-cell edit in one transaction; types shown and edited correctly (PostgreSQL arrays, `json`/`jsonb`, `uuid`, `bytea`; SQL Server `uniqueidentifier`, `datetime2`, `varbinary`, identity columns); export as CSV, JSON and SQL
- [ ] **M4.6** Table designer and schema changes per dialect: list of types, identity/serial columns, defaults, indexes, foreign keys; generated `ALTER` statements (PostgreSQL `ALTER COLUMN … TYPE/SET DEFAULT/SET NOT NULL`; SQL Server `sp_rename`, named default constraints); DDL in a transaction where the engine allows it, so a failure leaves nothing half applied
- [ ] **M4.7** Migrations for the new engines in the same `NNN_<table>_<operation>.sql` files, with the dialect's SQL
- [ ] **M4.8** MCP tools aware of the engine (`db_client_*` with schemas; reads in a read-only transaction: `BEGIN READ ONLY` on PostgreSQL, a transaction always rolled back on SQL Server plus the classification of the statement)
- [ ] **M4.9** Tests (in `extensions/db-client/tests/`, with the core test kit): per-dialect unit tests that need no server (classification, quoting, pagination, DDL generation, introspection mapping), integration tests against disposable PostgreSQL and SQL Server servers when they are available (skipped otherwise, like the MySQL ones); README, CHANGELOG

---

## Suggested order and size

| Milestone | Size | Where | Notes |
|---|---|---|---|
| M1 MCP activity log and stdio bridge | S | core | useful at once; M2 relies on the log |
| M2 MCP state-changing tools | M | core, `tunnels`, `git`, `db-client`, `pm2` | opt-in one tool at a time; DB changes only through migrations |
| M3 Swagger specs and MCP tools | S | `swagger` (devdock-extensions) | the extension gets a backend; no core change |
| M4 PostgreSQL and SQL Server | L | `db-client` | not urgent; engine layer first (MySQL moved onto it with no change), then one dialect at a time |
