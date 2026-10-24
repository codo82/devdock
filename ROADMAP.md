# DevDock — Roadmap

Open work, numbered again from M1 after DevDock 2.1.0. The milestones closed up to 2.1.0 (M0–M17, with their original numbers, the ones the CHANGELOG uses) are archived in [docs/ROADMAP-HISTORY.md](docs/ROADMAP-HISTORY.md).

Status legend: `[ ]` to do · `[~]` in progress · `[x]` done

**Rules for every milestone**
- A milestone is closed only when `CHANGELOG.md` (`[Unreleased]` → version) and, when something changes for the user, `README.md` and `docs/EXTENSIONS.md` are updated.
- Versioning is SemVer: a closed milestone that changes DevDock is a new minor version (M1 → 2.2.0, M2 → 2.3.0, M3 → 2.4.0, …); a major version only when the extension contract changes (it would make every extension declaring `"devdock": "^2.0"` incompatible).
- Work on an extension of the [devdock-extensions](https://github.com/codo82/devdock-extensions) repository is released there with its own version and tag (`<code>@<version>`); DevDock gets a new version only if the core changes too.

---

## M1 — MCP: stdio bridge — core ✅ (2.2.0)

Goal: Claude Desktop and the other clients that start MCP servers as processes reach DevDock without a token in their configuration and without third-party packages. *(Formerly part of M8.13.)*

- [x] **M1.1** `bin/devdock-mcp.js` (also `devdock mcp` and the `devdock-mcp` bin): stdio ↔ Streamable HTTP with the MCP SDK already used by the server; port and token file of the instance from `DEVDOCK_PORT` / `DEVDOCK_CONFIG` like the server; the token is read again at every request (a 401 is retried once), so the bridge survives a regeneration; DevDock not running or a token of another instance → a JSON-RPC error with a clear message (core catalogs)
- [x] **M1.2** The server creates the token on the first access to `/mcp` even when the request has no `Authorization` header (first start of the bridge)
- [x] **M1.3** 🤖 dialog: the Claude Desktop entry uses the bridge (absolute paths of Node.js and of the bridge, `env` only when the instance is not the default one) instead of `npx mcp-remote` with the token in clear
- [x] **M1.4** Tests (SDK stdio client through the bridge: tools listed and called, token regenerated while connected, DevDock not running, token of another instance), README

## M3 — DB client: PostgreSQL and SQL Server — extension `db-client`

Goal: the Database section works with PostgreSQL and Microsoft SQL Server as well as MySQL/MariaDB, with the same features and the same safety rules (every change shown and confirmed before it runs, read-only connections, passwords in the core vault). *(Formerly M16; replaces the even older M5.7 and M7.15.)*

- [ ] **M3.1** Engine layer in `db-client`: one module per engine (`engines/mysql.js`, `engines/postgres.js`, `engines/mssql.js`) with pool and connection, query with timeout and row limit, read-only transaction, identifier quoting and value escaping, pagination, list of databases/schemas/tables, introspection and error mapping. MySQL moves onto it first with no change in behaviour (the existing tests stay green). Connection field `type`: `mysql` (default), `postgres`, `mssql`, with default ports 3306 / 5432 / 1433. Drivers as npm workspace dependencies of `db-client`: `pg` and `mssql` (tedious), both pure JavaScript, so they work the same on macOS and Windows; SQL Server uses SQL authentication only (Windows integrated authentication would need a native driver)
- [ ] **M3.2** Per-dialect statement classification (only recognised reads run without confirmation): PostgreSQL dollar quoting, `E''` strings, `::` casts, `RETURNING`, `COPY`, `DO`, `LISTEN`/`NOTIFY`; SQL Server `[brackets]`, `N''` strings, `EXEC`, `MERGE`, `SELECT … INTO` (a write), `GO` batch separator refused. Parametric queries keep `?` and `:name` in the editor and are bound with the engine's syntax
- [ ] **M3.3** Connection options per engine: PostgreSQL `sslmode`, SQL Server `encrypt` / `trustServerCertificate` (needed for local Docker and Azure), default database, through an SSH tunnel as today; connection test
- [ ] **M3.4** Sidebar tree with schemas for PostgreSQL and SQL Server: connection ▸ database ▸ schema ▸ tables/views ▸ columns (MySQL unchanged), context menu on tables as today; SQL editor highlighting with each dialect's keywords
- [ ] **M3.5** Data browser for the new engines: pagination (`LIMIT/OFFSET`, `OFFSET … FETCH`), search, filters, sorting, inline and dialog edit, multiple deletion, multi-cell edit in one transaction; types shown and edited correctly (PostgreSQL arrays, `json`/`jsonb`, `uuid`, `bytea`; SQL Server `uniqueidentifier`, `datetime2`, `varbinary`, identity columns); export as CSV, JSON and SQL
- [ ] **M3.6** Table designer and schema changes per dialect: list of types, identity/serial columns, defaults, indexes, foreign keys; generated `ALTER` statements (PostgreSQL `ALTER COLUMN … TYPE/SET DEFAULT/SET NOT NULL`; SQL Server `sp_rename`, named default constraints); DDL in a transaction where the engine allows it, so a failure leaves nothing half applied
- [ ] **M3.7** Migrations for the new engines in the same `NNN_<table>_<operation>.sql` files, with the dialect's SQL
- [ ] **M3.8** The existing MCP tools of the DB client (`db_client_*`) keep working with the new engines (with schemas; reads in a read-only transaction: `BEGIN READ ONLY` on PostgreSQL, a transaction always rolled back on SQL Server plus the classification of the statement); no new MCP features
- [ ] **M3.9** Tests (in `extensions/db-client/tests/`, with the core test kit): per-dialect unit tests that need no server (classification, quoting, pagination, DDL generation, introspection mapping), integration tests against disposable PostgreSQL and SQL Server servers when they are available (skipped otherwise, like the MySQL ones); README, CHANGELOG

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
| M3 PostgreSQL and SQL Server | L | `db-client` | engine layer first (MySQL moved onto it with no change), then one dialect at a time |
