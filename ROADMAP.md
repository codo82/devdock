# DevDock — Roadmap

Milestones are ordered by dependency (M5 is done before M4 by choice): first secure and stabilise the existing code, then refactor, and only then build new features on the new structure (so they don't have to be rewritten twice).

Status legend: `[ ]` to do · `[~]` in progress · `[x]` done

**Rule for every milestone:** a milestone is closed only when `CHANGELOG.md` (`[Unreleased]` section → version) and, if anything changes for the user, `README.md` are updated. Versioning is SemVer: every closed milestone is a new minor version (M0 → 1.1.0, M1 → 1.2.0, …).

---

## Documentation (cross-cutting)

- [x] **D.1** Initial `README.md` (in M0): what DevDock is, requirements (Node ≥ 18, `ssh`; optional `autossh`, `pm2`), install and start (`npm install`, `npm start`, `npm run dev`), overview of the sections, `config.json` format, security note (local use only)
- [x] **D.2** Initial `CHANGELOG.md` in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format: `1.0.0` entry for the existing state + `[Unreleased]` section
- [x] **D.3** Align `package.json` (name `devdock` instead of `port-forward-manager`, version, description) and the server startup log
- [ ] **D.4** At the end of every milestone: update the CHANGELOG (Added/Changed/Fixed/Security/Removed) and the README where needed
- [x] **D.5** In M3: README sections "Project structure" and "Writing an extension"; in M5: section "DB client"
- [x] **D.6** Roadmap, README and CHANGELOG in English

---

## M0 — Cleanup and macOS portability ✅ (1.1.0)

Goal: the project starts cleanly on macOS (and stays compatible with Linux/WSL).

- [x] **M0.1** Remove `public/index.html:Zone.Identifier` (Windows artefact) from the repo
- [x] **M0.2** Remove the root `index.html` (identical copy of `public/index.html`, never served)
- [x] **M0.3** Cross-platform port detection: `getPortsForPgid` used `ss` (missing on macOS) → `lsof -nP -iTCP -sTCP:LISTEN -a -p <pids>` with `ss` fallback on Linux
- [x] **M0.4** `EMPTY_CONFIG` must include `projects: []`
- [x] **M0.5** Handle `SIGTERM` (and `SIGHUP`) as well as `SIGINT` to stop tunnels and child processes
- [x] **M0.6** NPM/PM2 sections degrade with a clear message when `pm2`/`autossh` are not installed (previously a silent empty list)

## M1 — Security ✅ (1.2.0)

Context: the app only listens on `127.0.0.1`, but the browser is an attack vector: any open web page can send requests to `localhost:3500`, and the API runs `ssh`, `npm`, `git`, `pm2`.

**API protection**
- [x] **M1.1** Anti-CSRF middleware: reject requests whose `Origin`/`Referer` is not `http://127.0.0.1:3500` / `http://localhost:3500`
- [x] **M1.2** `Host` header check (DNS rebinding defence): accept only `127.0.0.1:PORT` and `localhost:PORT`
- [x] **M1.3** Require `Content-Type: application/json` on state-changing requests (blocks "simple" cross-site forms)
- [x] **M1.4** Remove `/api/git/repos/:id/debug-push` (exposed env and `git config`, possibly tokens)
- [x] **M1.5** Basic security headers: CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`

**Input validation (argument injection)**
- [x] **M1.6** Git: validate `branch`/`remote` (no leading `-`, `git check-ref-format`), add `--` before paths; validate `:hash` as hexadecimal
- [x] **M1.7** Git commit: the files passed must be among those returned by `git status`
- [x] **M1.8** NPM: `script` allowed only if defined in `package.json` (or `install`); new explicit `update <pkg>` action with a validated package name
- [x] **M1.9** PM2: `action` whitelist (`start|stop|restart|delete`), validated `target`
- [x] **M1.10** Config: schema validation on `PUT /api/config`, import and CRUD (alphanumeric keys, integer ports 1–65535, `remote` as `host:port`, `alias` without spaces/leading `-`, hex `color`)

**Frontend (XSS)**
- [x] **M1.11** Escape every value interpolated into HTML/attributes (`color` in `style`, keys in `onclick`, `e.message` in Swagger)
- [x] **M1.12** Swagger UI and js-yaml from CDN with `integrity` (SRI) + `crossorigin`

## M2 — Known bugs ✅ (1.3.0)

- [x] **M2.1** `npmUpdate` sent `script: "update <pkg>"` → the server ran `npm run "update <pkg>"`. Fixed with a dedicated endpoint (depends on M1.8)
- [x] **M2.2** Import `merge`: include `projects` too (previously ignored)
- [x] **M2.3** Comments out of sync with the code (SSE polling "300ms" vs the real 100ms) and other small inconsistencies
- [x] **M2.4** *(Backlog #1)* **Git push with two pushurls and several commits** — `cannot lock ref: is at X but expected Y`
  - [x] Reproduced with a test repo whose `origin` has two pushurls (two local bare repos): a single push of 3 commits works; two concurrent pushes give exactly the backlog error (5 runs out of 5)
  - [x] Cause: `gitAction()` in the frontend ran the action twice (a `fetch` POST with ignored output, then `gitRunSse()`), so two `git push` processes raced to update `refs/heads/<branch>` on the remotes. The two pushurls were not involved
  - [x] Fix: single request from the UI and a per-repo lock on the server (a second concurrent action gets 409)
- [x] **M2.5** *(Backlog #2)* **Graph lanes with generic `branch-N` names**
  - [x] Name inheritance: a lane takes its name from the first commit with a ref that creates it and carries it down to the parents, instead of looking up the pending hash of `finalLanes` in `allRefs`
  - [x] Fallback: name taken from the merge subject (`Merge branch 'x'`, `Merge pull request #n from user/x`) for branches already deleted
  - [x] `branch-N` only as a last resort

## M3 — Extension architecture *(Backlog #5, #6, #6 bis)* ✅ (1.4.0)

Every feature becomes an extension with its own manifest, backend routes, HTML, JS and CSS. Contract: [docs/EXTENSIONS.md](docs/EXTENSIONS.md). (Merges the former "backend refactor" and "extensions" milestones, so the code is moved only once.)

- [x] **M3.1** Split `server.js` into `lib/` (shared services) and `routes/` (one file per area) as an intermediate step
- [x] **M3.2** Integration tests (`node:test`) that start DevDock as a separate process with temporary config and git repos, used as a safety net for the migration
- [x] **M3.3** Extension contract: `setting.json` with routes declared in the manifest, backend module `(ctx) → { handlers, services, validateConfig, shutdown }`, frontend module `{ mount, show, hide, badge }`, core API under `/api/core`, extension API under `/api/ext/<code>`
- [x] **M3.4** Backend loader: discover `extensions/*/setting.json`, validate manifests, resolve dependencies (`required: true` → not loaded; `false` → loaded with a warning), topological order, error on cycles, mount declared routes, check handlers, shutdown in reverse order
- [x] **M3.5** Config ownership: each `config.json` key belongs to one extension; per-extension validation, export and import
- [x] **M3.6** Frontend shell: header, section bar, sidebar, panels, modal, toast, SSE output panel, lazy loading of `view.html`/`view.js`/`style.css`, warning icon for missing optional dependencies, header-position extensions
- [x] **M3.7** Migrate the sections one at a time, keeping the tests green: Swagger ✓ → PM2 ✓ → Tunnels ✓ (with their settings) → npm ✓ → Git ✓
- [x] **M3.8** Unify the push logic (`push`, fetch-error fallback, `pull_push`) in the Git extension into a single pipeline of sequential SSE commands
- [x] **M3.9** npm workspaces: `"workspaces": ["extensions/*"]`, a single `node_modules`
- [x] **M3.10** *(Backlog #5)* `CLAUDE.md`: purpose, structure, extension pattern, conventions (Italian UI messages, vanilla JS, no build step), how to run and test, reference to this roadmap
- [x] **M3.11** Publish on GitHub
- [x] **M3.12** Export/import checkboxes declared by the extensions (`setting.json → export`, each covering some of the extension's config sections); the Export and Import dialogs show only those, Import lets you pick the checkboxes found in the file and the mode (merge/replace)

## M5 — Integrated DB client *(Backlog #4)* — first new extension ✅ (1.5.0)

Built as an extension on the M3 architecture.

- [x] **M5.1** `db-client` extension with the `mysql2` dependency in its own `package.json`
- [x] **M5.2** Connections configurable per project (host, port, db, user, password). "Use tunnel" option linking a connection to an already configured SSH server
- [x] **M5.2b** **Vault with master password** (works the same on macOS and Windows, `node:crypto` only, no native dependencies):
  - First access to the Database section: the UI asks to **create** the master password (with confirmation, at least 10 characters). The server generates a random `salt` and derives the key with **scrypt** (`crypto.scrypt`, 32-byte key)
  - Each DB password is encrypted with **AES-256-GCM** using a random IV per value, and stored as `{ iv, tag, data }` in base64
  - **Separate keys**: from the scrypt key (`masterKey`) **HKDF-SHA256** derives two independent subkeys: `encKey` (info `"devdock-vault-enc"`) for encryption and `verifyKey` (info `"devdock-vault-verify"`) for verification, so the stored value reveals nothing about `encKey`
  - **Hashed verifier** in `config.json`: `verifier = SHA-256(verifyKey)`, stored at creation. On unlock it is recomputed and compared with `crypto.timingSafeEqual`: if it doesn't match, the password is wrong
  - Structure in `config.json`:
    ```json
    "vault": {
      "version": 1,
      "kdf": { "alg": "scrypt", "salt": "<base64>", "N": 131072, "r": 8, "p": 1 },
      "verifier": "<base64 sha256(verifyKey)>"
    }
    ```
    and in each connection `"password": { "iv": "…", "tag": "…", "data": "…" }`
  - **Session**: the derived key lives **only in the server's memory**. It expires when the server restarts, with the "Lock" button or after a configurable inactivity timeout (default 30 min). On the first access of each session the UI asks to unlock
  - Plaintext passwords **never go back to the frontend**: the server decrypts them only when opening the connection. When editing, the password field stays empty ("leave empty to keep it")
  - Endpoints: `GET /api/ext/db-client/vault` (state: `uninitialized | locked | unlocked`), `POST …/vault/init`, `POST …/vault/unlock`, `POST …/vault/lock`, `POST …/vault/change` (re-encrypts every password with the new key, writing the file atomically)
  - Brute-force protection: increasing delay after each failed unlock attempt
  - "I forgot the password": vault reset, which deletes the stored passwords (connections stay, without password) after explicit confirmation
  - Export/import: passwords travel encrypted together with the `vault` block, so they can be moved to another machine with the same master password. When importing into a config that already has a vault with a different salt, ask for the imported config's master password and re-encrypt
  - Tests: init/unlock/wrong password/change/lock, check that `config.json` never contains plaintext passwords
- [x] **M5.2c** Import of connections encrypted with a different master password: ask for the imported file's master password and re-encrypt them with the current key
- [x] **M5.3** Backend: pool per connection, `POST /api/ext/db-client/query` with timeout, row limit, optional read-only flag
  - **Statements that change data or schema (INSERT, UPDATE, DELETE, REPLACE, CREATE, ALTER, DROP, TRUNCATE, RENAME, GRANT, …) are never executed automatically.** The server classifies every statement (comments and strings excluded); only recognised reads run directly (SELECT without INTO, SHOW, DESCRIBE, EXPLAIN); anything else, unknown statements included, gets a "confirmation required" answer with a token bound to the exact SQL text. The UI shows the statement in a confirmation dialog and resends it with that token; a different text needs a new confirmation. On read-only connections writes are refused. Applies to every path that runs SQL (editor, table designer)
- [x] **M5.4** UI: editor with minimal syntax highlighting (CodeMirror 6 from CDN with SRI, or a light custom highlighter), run with Ctrl/Cmd+Enter
- [x] **M5.5** Results in a table (sortable columns, highlighted NULLs, row count/time), messages for queries without a result set
- [x] **M5.6** Per-session query history (in memory / `sessionStorage`)
- [x] **M5.8** Schema browser in the sidebar: databases → tables (with row estimate) → columns, indexes and foreign keys; click on a table → `SELECT * … LIMIT` in the editor
- [x] **M5.9** Table creation: designer with name, columns (name, type with length/precision, NULL, default, auto increment, comment), primary key, indexes (unique too), foreign keys, engine and charset/collation. Shows the generated `CREATE TABLE` (identifiers quoted with backticks, nothing concatenated from unvalidated input) before running it; disabled on read-only connections
- [x] **M5.10** Table data browser (opened with "Apri dati" from the table context menu): pagination with total row count, search across columns, per-column filters (=, ≠, contains, starts with, <, >, is NULL, is not NULL), sorting by clicking the column header; all generated SQL uses quoted identifiers and bound parameters
- [x] **M5.11** Row insert and edit, both inline in the data browser (double click on a cell; empty row at the bottom to insert) and through a dialog with one field per column (type-aware: NULL toggle, numbers, dates, long text). Rows are identified by the primary key (editing disabled without one). Every save generates the `INSERT`/`UPDATE` and goes through the same confirmation dialog before running; row deletion too
- [x] **M5.11b** Multiple row deletion: checkbox per row and "select all" for the page; a single `DELETE … WHERE pk IN (…) LIMIT n` (max 1000 rows) shown in the confirmation dialog
- [x] **M5.12** Data export as CSV, SQL (`INSERT` statements, optional `CREATE TABLE`) and JSON: of a whole table, of the rows matching the current search/filters of the data browser, and of the result of a custom `SELECT` from the editor. Generated and streamed by the server (no full result in memory); only read statements can be exported

## M4 — Branch switch / create *(Backlog #3)* — inside the Git extension ✅ (1.6.0)

- [x] **M4.1** Backend: `GET /api/ext/git/repos/:id/branches` (local + remote, current branch)
- [x] **M4.2** Backend: `checkout` action (validated in M1.6) and new `checkout_new` (`git checkout -b <name>`, optional start point)
- [x] **M4.3** Pre-check: uncommitted changes → structured response the UI uses to offer "Stash and switch" / "Cancel"
- [x] **M4.4** Pre-check: branch already exists → clear error; remote branch not yet local → `checkout --track`
- [x] **M4.5** UI: dropdown on the branch badge with search, local/remote sections, "New branch…" entry; SSE output during the operation, status and log refresh at the end
- [x] **M4.6** Merge of branches: pick the branch to merge from the list (local and remote), preview of the incoming commits (`HEAD..branch`) and changed files, options `--no-ff` / `--squash`; on conflicts the UI lists the conflicted files and offers "Annulla merge" (`git merge --abort`) or, once resolved, "Concludi merge" (commit); SSE output, status and log refresh
- [x] **M4.7** Delete local branches (not the current one): merged ones directly, unmerged ones only after an explicit confirmation (`-D`)

---

# Future developments

Planned after the current milestones, independent of the work in progress. Order: M6 → M7 → M8.

## DB client — PostgreSQL

- [ ] **M5.7** PostgreSQL support in the `db-client` extension (it appears among the configured server types): driver, classification of statements, schema browser, data browser and export
- [ ] **M7.15** Migrations for PostgreSQL once M5.7 is done

## M6 — Internationalization (i18n) ✅ (1.7.0)

Goal: the whole UI (core and extensions) translatable into **any language**, with no list of languages hard-coded in the code: a language exists when its catalog exists. Adding one means adding JSON files, without touching JS. Italian is the **source language** (the complete reference and the last fallback); the first additional language is English. No build step and no external libraries: a small vanilla JS helper in the core, consistent with the rest of the project.

**Languages and selection**
- [x] **M6.1** Language identifiers are BCP 47 tags (`it`, `en`, `pt-BR`, `zh-Hant`…). The available languages are discovered from the core catalogs (`public/core/i18n/*.json`) and exposed by `GET /api/core/i18n/languages` (tag, native name, direction, completeness %)
- [x] **M6.2** Each catalog carries its own metadata in a `_meta` block: `{ "name": "English", "nativeName": "English", "dir": "ltr" }`, so the selector and the layout need no per-language code
- [x] **M6.3** Active language resolved in this order: user choice (stored in `localStorage`) → `navigator.languages` → source language. Matching with progressive truncation (`pt-BR` → `pt`), so a regional variant falls back to the base language. Selector in the header listing the available languages by native name; changing language re-renders the shell and the mounted extensions without a page reload. `<html lang>` and `<html dir>` updated accordingly
- [x] **M6.4** Right-to-left support: shell and extension CSS use logical properties (`margin-inline-start`, `inset-inline-end`, `text-align: start`) instead of left/right, so an RTL language (Arabic, Hebrew) works without dedicated stylesheets

**Core**
- [x] **M6.5** Catalogs as flat JSON files `public/core/i18n/<lang>.json` with dotted keys (`core.toast.saved`), served as static files and loaded lazily (only the chain needed: active language → its base language → source language)
- [x] **M6.6** Helper `t(key, params)` in `public/core/i18n.js` (also as `UI.t`): `{name}` interpolation, plurals via `Intl.PluralRules` with all CLDR categories (`zero`, `one`, `two`, `few`, `many`, `other`, only `other` mandatory), so languages with complex plurals (Polish, Arabic, Russian) work. Per-key fallback along the chain → the key itself, with a console warning for missing keys. A partially translated language is therefore usable
- [x] **M6.7** Static markup: `data-i18n`, `data-i18n-title`, `data-i18n-placeholder` attributes applied by the shell to `index.html` and to every loaded `view.html` / `sidebar.html`
- [x] **M6.8** Locale-aware formatting through `Intl` (`DateTimeFormat`, `NumberFormat`, `RelativeTimeFormat`, `ListFormat`) using the active tag: dates in the Git log, uptime in PM2, byte sizes, row counts. No date/number formats written by hand
- [x] **M6.9** Migrate every hard-coded string in `public/core/*` (toasts, modals, confirms, `toolNotice`, empty states, tooltips)

**Extensions**
- [x] **M6.10** Contract extension (documented in `docs/EXTENSIONS.md`): optional `i18n/<lang>.json` folder per extension, keys automatically namespaced by the extension `code`; frontend modules receive `ctx.t` already bound to their namespace. An extension may support a different set of languages from the core: missing keys follow the same fallback chain. An extension may also ship a language the core lacks (its strings are used, the core falls back). Manifest `name` and `description` translatable as a map by tag (`"name": { "it": "…", "en": "…" }`) or a plain string as today
- [x] **M6.11** Migrate the existing extensions one at a time (Swagger, PM2, Tunnels, npm, Git); from then on every new extension (DB client) is born with at least the source-language catalog

**Backend**
- [x] **M6.12** API errors become structured: `{ error: "<source-language message>", code: "tunnels.not_found", params: { … } }` (flat, so existing clients keep reading `error` and extra fields such as `files` stay at the top level). The message is built by the server from the source-language catalog (`errors.<name>`), so handlers contain no text. The frontend translates `code` with `t()`, and falls back to `error` for unknown codes. The server stays language-agnostic (no `Accept-Language` handling). Applies to the core middlewares (`security.js`: host, origin, content-type), config validation and extension handlers
- [x] **M6.13** Output of external commands (`git`, `npm`, `pm2`, `ssh`) is **not** translated: it is shown as is in the SSE panel

**Quality**
- [x] **M6.14** Tests on the catalogs, for the core and for each extension: the source language is complete; no other catalog has keys that don't exist in the source (stale keys); `{param}` placeholders match the source; every plural key has `other`; `_meta` is valid. Missing translations are **not** a failure: they are reported as completeness %
- [x] **M6.15** Script `npm run i18n:report`: completeness per language and per extension, with the list of missing keys, as a starting point for whoever adds a translation
- [x] **M6.16** Check that no hard-coded UI literal is left in `public/` and `extensions/*/view.js` (simple grep-based test with an allowlist)
- [x] **M6.17** Docs: README section "Languages" (how to switch, how to add a new language step by step: copy the source catalog, translate, fill `_meta`, run the report), update the M3.10 convention "Italian UI messages" → "UI messages through `t()`, Italian as source language"


## M7 — DB client: repository-linked migrations — inside the `db-client` extension ✅ (1.8.0)

Goal: link a DB connection to a project repository so that **every structural change to the tables (create and alter) ends up in a migration file** in the repository, instead of being written by hand. The main path is capturing the changes made through DevDock itself (table designer and SQL editor); a schema diff covers the changes made outside DevDock. Data changes (`INSERT`/`UPDATE`/`DELETE` on rows) never produce migrations. Depends on M5 (connections per project); the Git extension is an optional dependency.

Migration format (decided): **one SQL file per migration, `NNN_<table>_<operation>.sql`**, where `NNN` is an incremental number (zero-padded to 3 digits, wider when it grows past 999). The next number is always computed from the files that actually exist **before** proposing and again right before writing.

**Linking**
- [x] **M7.1** Linking a connection: the user **selects the repository** (the Git extension's repositories; the npm projects when Git is not active) **and the folder** inside it, through a folder browser that lists the repository's subfolders (hidden folders and `node_modules` excluded) and can create a new one. Stored as a per-connection `migrations` block: `{ "repo": "<repo id>", "dir": "database/migrations" }`; `dir` is relative to the repository root and validated (no `..`, no absolute paths, no symlinks leaving the repository)
- [x] **M7.2** Numbering: the current number is the highest `NNN` among the files matching `^\d+_.*\.sql$` in the folder (the remote branch is not checked: removed in 1.8.1). The linking dialog shows the files found and the next number; an empty folder starts at `001`. Files whose names don't follow the format are listed and ignored

**Table designer**
- [x] **M7.3** UI to **create a table** (the M5.9 designer, extended): name, columns (name, type with length/precision, nullable, default, auto-increment, unsigned, comment), primary key, indexes (unique, composite), foreign keys (referenced table/column, on delete/update), engine, charset/collation
- [x] **M7.4** UI to **alter a table**, starting from its current structure: add/modify/rename/drop columns and reorder them, add/drop indexes and foreign keys, rename the table. Changes are collected as a list of pending operations, not applied one by one
- [x] **M7.5** Before applying: preview of the SQL that will run on the DB **and** of the migration file that will be written, side by side; destructive operations (drop column, type narrowing) highlighted with a warning and an explicit confirmation

**Capture into migrations**
- [x] **M7.6** Single pipeline for a linked connection: designer operations → **migration file written into the repository** (`NNN_<table>_<operation>.sql`, the SQL statements with a header comment: connection, database, date) → DDL executed on the DB. If the DDL fails, the file is removed, so the repository and the DB stay consistent. For a connection without a linked repository the designer works as a plain DDL tool, with a reminder that no migration is produced
- [x] **M7.7** SQL editor: `CREATE TABLE` / `ALTER TABLE` / `RENAME TABLE` / `CREATE|DROP INDEX` statements typed by hand are recognised and, on a linked connection, the UI offers "Run and save as migration" (default) or "Run only". The statement is saved verbatim in the migration file (it is exactly what runs on the DB); a light recogniser derives table and operation for the file name (`ADD COLUMN x` → `add_x`, `CREATE INDEX` → `add_index_<name>`, several clauses → `alter`), and the user can change them. The same preview as the designer (SQL and file side by side, destructive warnings) is shown before applying
- [x] **M7.8** File name proposed from the operations: `<table>` is the table name, `<operation>` one of `create`, `alter`, `drop`, `rename` or a more precise slug when there is a single change (`add_status`, `drop_status`, `add_index_email`); editable, slug-validated (`[a-z0-9_]`). Several operations on the same table in one session can be grouped into a single migration

**Schema introspection**
- [x] **M7.9** Introspection of the live schema through read-only `INFORMATION_SCHEMA` queries into the same normalised model (tables, columns, primary keys, indexes, foreign keys, engine), used by the designer to edit existing tables
- ~~**M7.10** Reference state: a **schema snapshot** committed in the repository (`<dir>/.devdock-schema.json`), rewritten by every migration DevDock generates. A "Baseline" action takes the current schema as the starting point for projects with an existing DB (optionally generating an initial migration with the full schema)~~ — removed in 1.8.1 (not needed: migrations are only the ones DevDock writes)
- ~~**M7.11** Diff engine (pure function `diff(snapshot, live) → operations`) with deterministic ordering (FKs dropped before and created after the tables they depend on). Ambiguous cases are resolved by the user, never guessed: a dropped column + an added one of a compatible type → "rename or drop + add?". The "Migrations" tab shows the status ("in sync" / "N changes not in a migration" / "snapshot newer than the DB", i.e. teammates' migrations pulled and not applied) and generates the missing migration on request~~ — removed in 1.8.1 (not needed: migrations are only the ones DevDock writes)

**Generators**
- [x] **M7.12** SQL generator `(operations) → statements`, shared by the DDL executed on the DB and the migration file, so the two are always identical

**Safety and tests**
- [x] **M7.13** Never overwrite an existing migration file: the number is recomputed right before writing and the file is created with an exclusive open (a concurrent file with the same number makes the write fail, nothing is lost); file names validated; writes are atomic (temp file + rename); no automatic commit (at the end, link to the Git extension, if present, to review and commit)
- [x] **M7.14** Tests: operation model and statement recogniser on fixtures; diff engine on JSON fixtures (no DB needed); numbering (gaps, wider numbers, names out of format, upstream ahead); the generator on fixed operation lists with expected SQL; exclusive writes; rollback of the file when the DDL fails; an integration test against a disposable MySQL (skipped when `mysqld` is not installed): pipeline, introspection round trip, outside changes, baseline
- [x] **M7.16** Docs: README section "DB migrations" (linking, file format, numbering)

## M8 — MCP server ✅ (1.9.0, first version)

Goal: expose DevDock to AI agents (Claude Code, Claude Desktop, any MCP client) through a **Model Context Protocol server**, so an agent can query the extensions: tunnel and PM2 status, Git state, npm scripts, API specs, DB schema. As with the UI, every capability comes from an extension: the core only hosts the server and aggregates what the extensions declare. Done **after M6 and M7**: it reuses the M6 structured error codes and the M7 migration pipeline.

First version (agreed scope): **read-only** tools for every extension, plus running npm scripts; nothing else changes state. DB tools work only while the vault is unlocked from the DevDock UI — the master password never goes through the agent.

- [x] **M8.1** MCP endpoint served by DevDock itself over **Streamable HTTP** at `/mcp` (same process, same port, same services as the UI), built on the official `@modelcontextprotocol/sdk`, stateless
- [x] **M8.2** Authentication: random bearer token generated on first start and stored outside `config.json` (not exported), regenerable from the UI; requests with an `Origin` header (browsers) rejected
- [x] **M8.3** Server `instructions` describing DevDock and the loaded extensions
- [x] **M8.4** Optional `mcp.tools` block in `setting.json` (`name`, `description`, JSON Schema `inputSchema`, `handler`, `readOnly`); handlers live in the extension backend (`instance.mcp`), with the same `ctx` and services as the HTTP routes. Documented in `docs/EXTENSIONS.md`
- [x] **M8.5** Tools namespaced by extension code (`git_repo_status`, `db_client_query`); disabled extensions expose nothing
- [x] **M8.6** Results as structured JSON plus text, long outputs limited by parameters and truncated with a flag; errors as MCP tool errors with the M6 error codes
- [x] **M8.7** Tools: Tunnels (servers and active tunnels); PM2 (processes, log tail); Git (repos with branch and ahead/behind, status, log); npm (projects and scripts, running processes, output of a process; **run a script** and **stop a process**); DB client (connections without credentials, tables, structure of a table, read-only query with row limit run in a `READ ONLY` transaction) — only with the vault unlocked, otherwise a clear error
- [x] **M8.8** "MCP" dialog in the core header (🤖): endpoint, token (show, copy, regenerate), ready-to-copy setup for Claude Code and Claude Desktop, list of the tools per extension
- [x] **M8.9** Tests with the SDK client: initialize, list and call tools, rejection without token or with a browser `Origin`, DB tools with the vault locked and unlocked, secrets never returned
- [x] **M8.10** Docs: README section "MCP server" and the `mcp` manifest block in `docs/EXTENSIONS.md`

**Later (not in the first version)**
- [ ] **M8.11** Other state-changing tools (start/stop tunnels, PM2 restart, git pull/push, DDL through the migration pipeline), each enabled one by one in the UI
- [ ] **M8.12** Activity log of the MCP calls in the UI
- [ ] **M8.13** stdio bridge (`npx devdock-mcp`) for clients that only support stdio; MCP resources and `list_changed` notifications
- [ ] **M8.14** Swagger tools (needs specs stored on the server, today they are only loaded in the browser)

## M9 — Ports in use — new extension `ports` ✅ (1.10.0)

Goal: answer "who is using port 3000?" and free it. Minimal version; nothing beyond this list.

- [x] **M9.1** Backend: listening TCP ports of the machine with PID, process name, command line and owner user (`lsof` on macOS/Linux, `ss` as fallback on Linux, `netstat -ano` + `tasklist` on Windows); the core `lib/ports.js` is extended rather than duplicated
- [x] **M9.2** Each port linked to what DevDock knows: npm process started by DevDock (project and script), PM2 process, SSH tunnel (only when those extensions are active)
- [x] **M9.3** UI: table of ports with search by port, process or project; refresh button
- [x] **M9.4** Stop the process that holds a port: only processes of the current user, after a confirmation that shows PID and command; `SIGTERM`, then optionally a forced stop. Processes started by DevDock are stopped through their extension (npm process group, PM2, tunnel) so its state stays consistent
- [x] **M9.5** MCP tool `ports_list` (read-only)
- [x] **M9.6** Tests (a test server listening on a free port is found and stopped), README, CHANGELOG

## M10 — Environment files — new extension `env` ✅ (1.11.0)

Goal: see at a glance which variables a project's `.env` is missing compared with `.env.example`, and fix them from DevDock.

- [x] **M10.1** Backend: for each npm project, the `.env*` files in the project folder (`.env`, `.env.local`, `.env.development`, `.env.example`, …), parsed with the dotenv syntax (comments, quotes, `export`)
- [x] **M10.2** Comparison with the template (`.env.example` or `.env.sample`): keys missing from each file, keys not in the template, empty values
- [x] **M10.3** UI: per project, the files side by side with the keys and the differences highlighted; values masked by default and shown one at a time on click. Values never go into the DevDock config or its exports
- [x] **M10.4** Editing: change a value, add a key (also "add the missing keys from the template", with the template's default values), rename or remove a key, create a `.env` from the template. The file is rewritten keeping comments, blank lines and the order of the other lines; atomic write; the editor works on the current file content (a file changed on disk in the meantime is detected and the save refused)
- [x] **M10.4b** MCP tool `env_check`: files and keys with the differences, **without values** (no write tools)
- [x] **M10.5** Tests (fixtures with missing and extra keys, parser edge cases), README, CHANGELOG

## M11 — HTTP client — new extension `http-client` ✅ (1.21.0)

Goal: send requests to the local APIs of a project and keep the useful ones, with the right token for each kind of user obtained automatically. Minimal version.

- [x] **M11.1** Sections of requests (method, URL, headers, query, JSON or text body) in their own config section, with an Export/Import checkbox; a section can optionally be linked to a project. One base URL per section (`{{baseUrl}}`, proposed from `PORT` in the project's `.env`) plus section variables used in URL, headers and body
- [x] **M11.2** Sending through the DevDock backend (no CORS limits), with timeout and response size limit; response shown with status, time, size, headers and body (JSON formatted)
- [x] **M11.3** Express route discovery for a linked section by static analysis: starting from `main` or the start script, it follows relative `require`/`import` (JS and TS) and composes the prefixes of `app.use`/`router.use` across files, constants included. Routes are listed and imported one at a time; prefixes that can't be resolved (env/config values, `readdirSync` auto-loaders) are shown as "to complete" and edited on import. NestJS, Fastify and Koa are not supported
- [x] **M11.4** User types per section (e.g. admin, customer); every request is tagged with one, or with none (request sent without authorization). Each user type has an authorization method: **none**; **basic auth** (user and password, encrypted with the DB client vault, optional dependency); **manual token** (pasted, any type, optional expiry); **token from a login request** (method, URL, body with secret credentials in the vault, path of the token in the JSON response); **OAuth / OpenID Connect token** (Keycloak or any other provider, see M11.5). Token header name and format configurable (default `Authorization: Bearer …`). On send, the token of the user type is used if present and not expired (JWT: `exp` claim; manual expiry otherwise), otherwise it is acquired again and the request continues afterwards. Tokens kept only in memory (lost when DevDock restarts)
- [x] **M11.5** OAuth / OpenID Connect: issuer URL (endpoints from `/.well-known/openid-configuration`, or entered by hand), client id, scope, flow (authorization code with PKCE by default, code with client secret encrypted in the vault, or implicit) and the redirect URI registered in the client (port and path). DevDock listens on that port only for the duration of the login, opens the authorization URL in Firefox in the Firefox container of the user type (`ext+container:` URL of the "Open external links in a container" add-on; default browser when no container is set), receives the redirect and exchanges the code for the token; a refresh token, when returned, is kept in memory and used to renew the token without the browser
- [x] **M11.7** Actions after the token, per user type: up to 5 HTTP requests run right after a token is obtained (login, OAuth, refresh, pasted), with the new token in the header; values extracted from their responses (JSON path or `header:<name>`) become variables of the user type (`{{name}}` in its requests), and a variable called `token` replaces the token (second token from an exchange). Declarative only (no scripts run by the backend); if an action fails the token is not kept
- [x] **M11.6** Tests (local test server: methods, headers, body, timeout, variables, route discovery on fixtures split over several files, each authorization method, token reuse and expiry, OAuth flow against a fake provider, secrets never in clear in `config.json`), README, CHANGELOG


## M14 — Mock server — new extension `mock-server` ✅ (1.22.0)

Goal: simulate an API that doesn't exist yet or isn't reachable: every call gets a predefined response, and every incoming call is logged with its payload. Minimal version.

- [x] **M14.1** Mock servers in their own config section, with an Export/Import checkbox: name and port (listening on `127.0.0.1` only; a port already in use is reported with its owner through `lib/ports.js`). Start/stop from the UI, status in the sidebar; running mocks are stopped when DevDock shuts down
- [x] **M14.2** Routes per mock: method (or any), path with parameters (`/users/:id`) and `*` wildcard; predefined response with status, headers, body (JSON or text) and optional delay. The first matching route in list order answers; a call without a match gets a `404` with a JSON body that says so. Routes are edited while the mock is running, without restarting it
- [x] **M14.3** CORS option per mock (on by default): `Access-Control-Allow-*` headers and automatic answer to preflight `OPTIONS`, so a frontend on another local port can call the mock
- [x] **M14.4** Log of incoming calls, live in the UI: time, method, path, query, headers, body (JSON formatted, text, or size only for binary content; size limit), matched route (or "no match") and response status. Kept in memory with a cap per mock (latest 500 calls), with a clear button
- [x] **M14.5** "Create route from this call" on a logged call without a match: opens the route editor prefilled with its method and path, ready for the response to be filled in
- [x] **M14.6** MCP tool `mock_requests` (read-only; published as `mock_server_requests`, with `mock_server_list` for the mock ids): calls logged by a mock, with filters by method, path and "no match only", and a limit; header values that look like credentials (`Authorization`, `Cookie`, `X-Api-Key`…) redacted
- [x] **M14.7** Tests (routes with parameters and wildcard, order of match, unmatched call, delay, CORS preflight, log with JSON and text bodies, port in use, route created from a logged call, MCP tool with redaction), README, CHANGELOG


## M12 — Tab order — core

Goal: let the user put the extension tabs in the order they prefer. It is part of the shell, so it lives in the core.

- [ ] **M12.1** Drag and drop of the tabs in the section bar (mouse and keyboard: with a tab focused, Alt+←/→ moves it); the order of the manifests (`order`) stays the default
- [ ] **M12.2** The chosen order is saved in a core section of `config.json` (`layout.tabs`: list of extension codes) through a core API; extensions not in the list (newly added) go after the others in manifest order, removed ones are ignored
- [ ] **M12.3** "Restore default order" (context menu on the section bar)
- [ ] **M12.4** Tests (API, validation of the list, unknown codes ignored), README, CHANGELOG


## M13 — MongoDB client — new extension `mongo-client`

Goal: browse and edit MongoDB databases like the MySQL client does, with the same safety rules. Minimal version.

- [ ] **M13.1** Connections (host and port, or a `mongodb://` / `mongodb+srv://` URI, user, authentication database, TLS) in their own config section, optionally through an SSH tunnel of the Tunnels extension; passwords encrypted with the master password vault of the DB client (dependency on `db-client`), never shown or exported in clear; read-only option; connection test. Driver: official `mongodb` package (npm workspace)
- [ ] **M13.2** Sidebar tree connection ▸ databases ▸ collections (with estimated document count); context menu on collections (open, count, indexes, export, drop through confirmation)
- [ ] **M13.3** Document browser: filter as a JSON query, sort, projection, pagination; documents shown as JSON (Extended JSON for ObjectId, dates, decimals)
- [ ] **M13.4** Insert, edit (full JSON document) and delete documents, single and multiple; like every change in the DB client, **never run automatically**: the server returns the exact operation and runs it only after the user confirms it (token bound to the operation); read-only connections refuse writes
- [ ] **M13.5** Indexes of a collection (read-only list); export of a collection or of a filtered result as JSON
- [ ] **M13.6** MCP tools (read-only, only with the vault unlocked): connections without credentials, databases, collections, `find` with filter and limit, count
- [ ] **M13.7** Tests against a disposable `mongod` (skipped when not installed), README, CHANGELOG

---

## Suggested order and size

| Milestone | Size | Notes |
|---|---|---|
| D Documentation | S | README and CHANGELOG created in M0, then updated at every milestone |
| M0 Cleanup/macOS | S | unblocks daily use on the Mac |
| M1 Security | M | done on the current `server.js`, moved into modules in M3 |
| M2 Bugs | M | M2.4 required reproducing the case before fixing it |
| M3 Extension architecture | L | the largest; sections migrated one at a time, covered by tests |
| M5 DB client | L | first new extension; includes the master password vault — done before M4 |
| M4 Branch switch | S | inside the Git extension |
| M6 i18n | M | language-agnostic: languages discovered from catalogs; core first, then extensions one at a time; structured API errors |
| M7 DB migrations | L | after M5; diff engine and plain-SQL generator first, framework formats one at a time |
| M8 MCP server | L | after M6 and M7; core server + contract first, then read-only tools per extension, write tools opt-in |
| M9 Ports in use | S | `lib/ports.js` extended; Windows through `netstat` |
| M10 Environment files | S | read and write, comments and order kept; values never stored in DevDock or sent to agents |
| M11 HTTP client | L | Express route discovery, authorization per user type (none, basic, manual token, login request, OAuth/OIDC with Firefox containers), actions after the token; secrets through the DB client vault (optional dependency) |
| M14 Mock server | M | one HTTP listener per mock on `127.0.0.1`; predefined responses, call log with payload, route from a logged call, read-only MCP tool |
| M12 Tab order | S | core; drag and drop, saved in `config.json` |
| M13 MongoDB client | L | same vault and confirmation rules as the MySQL client; read-only MCP tools |
