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
- [~] **D.5** In M3: README sections "Project structure" and "Writing an extension" ✓; in M5: section "DB client"
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

## M5 — Integrated DB client *(Backlog #4)* — first new extension

Built as an extension on the M3 architecture.

- [x] **M5.1** `db-client` extension with the `mysql2` dependency in its own `package.json`
- [ ] **M5.2** Connections configurable per project (host, port, db, user, password). "Use tunnel" option linking a connection to an already configured SSH server
- [ ] **M5.2b** **Vault with master password** (works the same on macOS and Windows, `node:crypto` only, no native dependencies):
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
- [ ] **M5.3** Backend: pool per connection, `POST /api/ext/db-client/query` with timeout, row limit, optional read-only flag
- [ ] **M5.4** UI: editor with minimal syntax highlighting (CodeMirror 6 from CDN with SRI, or a light custom highlighter), run with Ctrl/Cmd+Enter
- [ ] **M5.5** Results in a table (sortable columns, highlighted NULLs, row count/time), messages for queries without a result set
- [ ] **M5.6** Per-session query history (in memory / `sessionStorage`)
- [ ] **M5.8** Schema browser in the sidebar: databases → tables (with row estimate) → columns, indexes and foreign keys; click on a table → `SELECT * … LIMIT` in the editor
- [ ] **M5.9** Table creation: designer with name, columns (name, type with length/precision, NULL, default, auto increment, comment), primary key, indexes (unique too), foreign keys, engine and charset/collation. Shows the generated `CREATE TABLE` (identifiers quoted with backticks, nothing concatenated from unvalidated input) before running it; disabled on read-only connections
- [ ] **M5.7** Later: PostgreSQL, since it appears among the configured server types

## M4 — Branch switch / create *(Backlog #3)* — inside the Git extension

- [ ] **M4.1** Backend: `GET /api/ext/git/repos/:id/branches` (local + remote, current branch)
- [ ] **M4.2** Backend: `checkout` action (validated in M1.6) and new `checkout_new` (`git checkout -b <name>`, optional start point)
- [ ] **M4.3** Pre-check: uncommitted changes → structured response the UI uses to offer "Stash and switch" / "Cancel"
- [ ] **M4.4** Pre-check: branch already exists → clear error; remote branch not yet local → `checkout --track`
- [ ] **M4.5** UI: dropdown on the branch badge with search, local/remote sections, "New branch…" entry; SSE output during the operation, status and log refresh at the end

---

# Future developments

Planned after the current milestones, independent of the work in progress. Not ordered yet.

## M6 — Internationalization (i18n)

Goal: the whole UI (core and extensions) translatable into **any language**, with no list of languages hard-coded in the code: a language exists when its catalog exists. Adding one means adding JSON files, without touching JS. Italian is the **source language** (the complete reference and the last fallback); the first additional language is English. No build step and no external libraries: a small vanilla JS helper in the core, consistent with the rest of the project.

**Languages and selection**
- [ ] **M6.1** Language identifiers are BCP 47 tags (`it`, `en`, `pt-BR`, `zh-Hant`…). The available languages are discovered from the core catalogs (`public/core/i18n/*.json`) and exposed by `GET /api/core/i18n/languages` (tag, native name, direction, completeness %)
- [ ] **M6.2** Each catalog carries its own metadata in a `_meta` block: `{ "name": "English", "nativeName": "English", "dir": "ltr" }`, so the selector and the layout need no per-language code
- [ ] **M6.3** Active language resolved in this order: user choice (stored in `localStorage`) → `navigator.languages` → source language. Matching with progressive truncation (`pt-BR` → `pt`), so a regional variant falls back to the base language. Selector in the header listing the available languages by native name; changing language re-renders the shell and the mounted extensions without a page reload. `<html lang>` and `<html dir>` updated accordingly
- [ ] **M6.4** Right-to-left support: shell and extension CSS use logical properties (`margin-inline-start`, `inset-inline-end`, `text-align: start`) instead of left/right, so an RTL language (Arabic, Hebrew) works without dedicated stylesheets

**Core**
- [ ] **M6.5** Catalogs as flat JSON files `public/core/i18n/<lang>.json` with dotted keys (`core.toast.saved`), served as static files and loaded lazily (only the chain needed: active language → its base language → source language)
- [ ] **M6.6** Helper `t(key, params)` in `ui.js`: `{name}` interpolation, plurals via `Intl.PluralRules` with all CLDR categories (`zero`, `one`, `two`, `few`, `many`, `other`, only `other` mandatory), so languages with complex plurals (Polish, Arabic, Russian) work. Per-key fallback along the chain → the key itself, with a console warning for missing keys. A partially translated language is therefore usable
- [ ] **M6.7** Static markup: `data-i18n`, `data-i18n-title`, `data-i18n-placeholder` attributes applied by the shell to `index.html` and to every loaded `view.html` / `sidebar.html`
- [ ] **M6.8** Locale-aware formatting through `Intl` (`DateTimeFormat`, `NumberFormat`, `RelativeTimeFormat`, `ListFormat`) using the active tag: dates in the Git log, uptime in PM2, byte sizes, row counts. No date/number formats written by hand
- [ ] **M6.9** Migrate every hard-coded string in `public/core/*` (toasts, modals, confirms, `toolNotice`, empty states, tooltips)

**Extensions**
- [ ] **M6.10** Contract extension (documented in `docs/EXTENSIONS.md`): optional `i18n/<lang>.json` folder per extension, keys automatically namespaced by the extension `code`; frontend modules receive `ctx.t` already bound to their namespace. An extension may support a different set of languages from the core: missing keys follow the same fallback chain. An extension may also ship a language the core lacks (its strings are used, the core falls back). Manifest `name` and `description` translatable as a map by tag (`"name": { "it": "…", "en": "…" }`) or a plain string as today
- [ ] **M6.11** Migrate the existing extensions one at a time (Swagger, PM2, Tunnels, npm, Git); from then on every new extension (DB client) is born with at least the source-language catalog

**Backend**
- [ ] **M6.12** API errors become structured: `{ error: { code: "tunnels.not_found", params: { … }, message: "<source-language fallback>" } }`. The frontend translates `code` with `t()`, and falls back to `message` for unknown codes. The server stays language-agnostic (no `Accept-Language` handling). Applies to the core middlewares (`security.js`: host, origin, content-type), config validation and extension handlers
- [ ] **M6.13** Output of external commands (`git`, `npm`, `pm2`, `ssh`) is **not** translated: it is shown as is in the SSE panel

**Quality**
- [ ] **M6.14** Tests on the catalogs, for the core and for each extension: the source language is complete; no other catalog has keys that don't exist in the source (stale keys); `{param}` placeholders match the source; every plural key has `other`; `_meta` is valid. Missing translations are **not** a failure: they are reported as completeness %
- [ ] **M6.15** Script `npm run i18n:report`: completeness per language and per extension, with the list of missing keys, as a starting point for whoever adds a translation
- [ ] **M6.16** Check that no hard-coded UI literal is left in `public/` and `extensions/*/view.js` (simple grep-based test with an allowlist)
- [ ] **M6.17** Docs: README section "Languages" (how to switch, how to add a new language step by step: copy the source catalog, translate, fill `_meta`, run the report), update the M3.10 convention "Italian UI messages" → "UI messages through `t()`, Italian as source language"

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
