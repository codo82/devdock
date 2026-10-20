# DevDock extensions

Every feature that can be added or removed is an **extension**: a folder under `extensions/` that describes itself in `setting.json` and brings its own backend routes, HTML, JavaScript and CSS. The core only provides security, configuration storage by section, the extension loader, a few shared services and the UI shell (navigation, header, dialogs).

## Existing extensions

| Code | Position | Order | Owns in `config.json` | Export/import checkboxes | Dependencies | Preload |
|---|---|---|---|---|---|---|
| `tunnels` | tab | 10 | `groups`, `servers` | Tunnel SSH | — | yes |
| `pm2` | header | 10 | — | — | `npm` (optional) | no |
| `npm` | tab | 20 | `projects` | Progetti NPM | — | yes |
| `db-client` | tab | 25 | `dbConnections`, `vault` | Connessioni database | `tunnels`, `npm`, `git` (optional) | no |
| `git` | tab | 30 | — | — | `npm` (required) | no |
| `swagger` | tab | 40 | — | — | — | no |

Services offered to other extensions (`ctx.require(code)`): `npm` → `getProjects()`, `getProject(id)`, `readPackage(project)`; `tunnels` → `getServer(key)`, `ensureTunnel(key)`; `git` → `repos()`; `db-client` → `decryptPassword(connection)`.

## Folder layout

```
extensions/
  git/
    setting.json     manifest (required)
    server.js        backend: route handlers, services for other extensions, config rules
    view.html        markup of the panel
    sidebar.html     markup of the sidebar (optional: without it the panel is full width)
    view.js          frontend logic (ES module)
    style.css        styles (optional)
    i18n/it.json     translations, one file per language (optional; see *Translations*)
    package.json     own npm dependencies (optional, npm workspace)
```

Only `setting.json` is mandatory: an extension can be frontend-only (`swagger`) or backend-only (a service used by other extensions).

## `setting.json`

```json
{
  "name": "Git",
  "code": "git",
  "version": "1.0.0",
  "description": "Status, commit, grafo dei commit e operazioni remote per i repository dei progetti npm",
  "color": "#3fb950",
  "icon": "🌿",
  "position": "tab",
  "order": 30,
  "dependencies": [
    { "code": "npm", "required": true }
  ],
  "backend": {
    "module": "server.js",
    "routes": [
      { "method": "GET",  "path": "/repos",            "handler": "listRepos" },
      { "method": "GET",  "path": "/repos/:id/status", "handler": "status" },
      { "method": "POST", "path": "/repos/:id/action", "handler": "action", "stream": true }
    ]
  },
  "frontend": {
    "html": "view.html",
    "sidebar": "sidebar.html",
    "js": "view.js",
    "css": "style.css"
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Label shown in the UI: a string or a map by language tag (`{ "it": "Database", "en": "Database" }`) |
| `code` | yes | Unique id, `[a-z0-9-]`, equal to the folder name (`core` is reserved); used in URLs (`/api/ext/<code>`, `/ext/<code>`), in `dependencies` and as `window.Ext.<code>` |
| `version` | no | Extension version (SemVer) |
| `description` | no | One line; a string or a map by language tag |
| `color` | yes | Accent colour (`#rrggbb`) for tab, badges, pills and `--ext-color` |
| `icon` | no | Emoji or short text for the tab / header button |
| `position` | yes | `"tab"`: entry in the section bar with its own panel · `"header"`: button in the header bar that opens its panel |
| `order` | no | Sort order among tabs and among header buttons (default 100). The first tab opens at startup |
| `dependencies` | no | `required: true` → the extension is not loaded if the dependency is missing or disabled · `required: false` → it loads with a warning icon and must cope with the dependency being absent |
| `config` | no | Top-level keys of `config.json` owned by the extension (see *Configuration*) |
| `export` | no | Checkboxes the extension adds to the Export and Import dialogs, each with the sections it covers (see *Export and import*) |
| `backend.module` | no | Backend file, relative to the extension folder |
| `backend.routes` | no | Routes mounted under `/api/ext/<code>`; each one names a handler of the backend |
| `frontend.html` / `sidebar` / `js` / `css` | no | Files served under `/ext/<code>/…`; only the files listed here are served (never `server.js` or `setting.json`) |
| `mcp.tools` | no | Tools the extension exposes to AI agents through the MCP server (see *MCP tools*); requires a backend |
| `frontend.preload` | no | `true`: the module is mounted at startup (hidden) instead of on first open — for extensions that keep header pills, badges or notifications up to date in the background |

### Loading and states

At startup the loader reads every `extensions/*/setting.json` and gives each extension a state, shown by `GET /api/core/extensions`:

- `ok` — loaded
- `warning` — loaded, but an optional dependency is missing (`warnings` lists it)
- `disabled` — not loaded; `error` says why: invalid manifest, missing required dependency, dependency cycle, config key already owned by another extension, backend that throws or lacks a handler named in the manifest

Backends are created in dependency order (topological sort) and shut down in reverse order when the server stops. A disabled extension never takes the others down; those that require it are disabled too.

### Routes

Routes are declared in the manifest, not registered by code, so the whole API surface of an extension is readable in one place and the loader can check it:

- `method`: `GET`, `POST`, `PUT`, `DELETE`
- `path`: Express path relative to `/api/ext/<code>`, e.g. `/repos/:id/action`
- `handler`: name of a function in the backend's `handlers`; the loader refuses an extension whose manifest names a handler that does not exist, and warns about handlers that no route uses
- `stream: true`: the handler answers with Server-Sent Events (documentation only; the handler opens the stream with `ctx.sse(res)`)

Every route goes through the core security middleware (Host and Origin checks, JSON content type) and the core error handler: errors thrown by handlers, also asynchronous ones, become a JSON response: 400 for a `ConfigError`, the error's `status` when it has one (e.g. `Object.assign(new Error('…'), { status: 409 })`), 500 otherwise.

## Backend module

`server.js` exports a function that receives `ctx` and returns the extension instance:

```js
// extensions/git/server.js
module.exports = function createGit(ctx) {
  const npm = ctx.require('npm');                 // services of a dependency

  return {
    handlers: {                                    // named in setting.json → backend.routes
      listRepos(req, res) { res.json(repos()); },
      async action(req, res) {
        const send = ctx.sse(res);                 // opens the SSE stream
        send('stdout', '$ git fetch\n');
        send('exit', 0);
        send.end();
      },
    },
    services: { repos },                           // for extensions that depend on this one
    config: {},                                    // rules for the keys in setting.json → config
    mcp: {},                                       // MCP tool handlers, named in setting.json → mcp.tools
    shutdown() { /* stop timers and child processes */ },
  };

  function repos() { /* uses npm.getProjects() */ }
};
```

Only `handlers` is needed when the manifest declares routes (and `mcp` when it declares MCP tools); everything else is optional.

`ctx` contains:

| Member | Purpose |
|---|---|
| `ctx.code`, `ctx.dir` | Extension code and folder |
| `ctx.config.get(key)` / `ctx.config.set(key, value)` | Read/write a key declared in `setting.json → config`; every write is validated and saved atomically. Other keys throw |
| `ctx.config.update({ key: value, … })` | Writes several of the extension's keys in a single atomic save (e.g. data that must change together) |
| `ctx.require(code)` | `services` of a dependency declared in the manifest (`null` if an optional dependency is missing) |
| `ctx.sse(res)` | Opens an SSE response; returns `send(type, data)`, with `send.end()` to close it |
| `ctx.error(status, name, params, extra)` | Error with a translatable code (see *Errors*): `throw ctx.error(404, 'repo_not_found')`. `ctx.error.config(name, params)` for config validation (400), `ctx.error.send(res, status, name, params)` where throwing is not possible (callbacks), `ctx.error.message(name, params)` for the source-language text |
| `ctx.lib.validate` | `KEY_RE`, `COLOR_RE`, `REMOTE_RE`, `ALIAS_RE`, `NPM_NAME_RE`, `PM2_TARGET_RE`, `isPort`, `isText`, `isValidBranchName`, `isValidCommitHash` |
| `ctx.lib.config` | `ConfigError` (400 without a code; prefer `ctx.error.config`) and `pick(obj, fields)` |
| `ctx.lib.errors` | `ApiError` (the class of `ctx.error`) and `errorBody(err)`, for handlers that build the response themselves |
| `ctx.lib.system` | `hasCommand(cmd)`, `getTools()` (installed external tools) |
| `ctx.lib.ports` | `getPortsForPgid(pid)`: TCP ports listened on by a process group |
| `ctx.log.info/warn/error(...)` | Console log prefixed with `[ext:<code>]` |

### MCP tools

An extension exposes tools to AI agents through the core MCP server (`/mcp`) by declaring them in `setting.json` and implementing them in `instance.mcp` of the backend:

```json
"mcp": {
  "tools": [
    { "name": "status", "handler": "status", "readOnly": true,
      "description": "Status of a repository: branch, ahead/behind, changed files…",
      "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" } }, "required": ["repo"] } }
  ]
}
```

```js
return {
  mcp: {
    async status({ repo }) {                       // arguments from the agent (validate them)
      const r = getGitRepos().find(x => x.id === repo);
      if (!r) throw ctx.error(404, 'repo_not_found'); // becomes an MCP tool error with the code
      return { repo: r.id, ...await statusOf(r) };   // an object: sent as structured JSON and text
    },
  },
};
```

| Field | Meaning |
|---|---|
| `name` | `[a-z][a-z0-9_]*`; the tool is published as `<code>_<name>` (`-` in the code becomes `_`: `db_client_query`) |
| `description` | What the tool does, in English, written for the agent |
| `inputSchema` | JSON Schema of the arguments (`type: "object"`) |
| `handler` | Function in `instance.mcp`; it receives the arguments, returns an object (or throws `ctx.error`) |
| `readOnly` | `true` (default) for tools that only read; `false` for tools that change state (published with `readOnlyHint: false`) |

Steps to enable MCP for an extension:

1. Add the `mcp.tools` block to `setting.json` (the extension needs a `backend`).
2. Implement each `handler` in `instance.mcp` of `server.js`, reusing the same services and validation as the HTTP routes; errors are thrown with `ctx.error`, so their messages go in `i18n/<lang>.json` under `errors.<name>`.
3. Restart DevDock: the tools appear in the 🤖 *MCP server* dialog of the header and in `GET /api/core/mcp`. There is no switch per extension: every active extension with `mcp.tools` is exposed.
4. Try them from a client: copy the setup from the panel (for Claude Code `claude mcp add --transport http devdock http://127.0.0.1:3500/mcp --header "Authorization: Bearer <token>"`), or in a test with the SDK client as in `tests/mcp.test.js`.

The extensions shipped with DevDock expose: `tunnels_list`; `pm2_list`, `pm2_logs`; `git_repos`, `git_status`, `git_log`; `npm_projects`, `npm_processes`, `npm_output`, `npm_run`, `npm_stop`; `db_client_connections`, `db_client_databases`, `db_client_tables`, `db_client_describe`, `db_client_query` (database tools only while the vault is unlocked from the UI).

Keep tools read-only unless the user asked otherwise, never return secrets (passwords, tokens, vault data), and limit long outputs with a parameter (`limit`, `lines`) and a `truncated` flag. A missing handler disables the extension like a missing route handler.

### Errors

Error responses have one shape for the core and every extension:

```json
{ "error": "Branch inesistente: feature/x", "code": "git.not_found", "params": { "branch": "feature/x" } }
```

- `code` is `<extension code>.<name>` (`core.<name>` for the core); extra fields can follow (e.g. `files` for `git.dirty`).
- `error` is the message in the source language, built by the server from the extension's `i18n/it.json`, key `errors.<name>` (with `{param}` placeholders and plurals on `params.count`). The server never picks a language and contains no message text: handlers only throw `ctx.error(status, name, params)`.
- The frontend translates `code` with the key `<code>.errors.<name>` of the active language and falls back to `error`; `ctx.api` errors carry `status`, `code`, `data` and the translated `message`. For bodies read by hand use `ctx.ui.errorText(data)`.
- Output of external commands (`git`, `npm`, `pm2`, `ssh`, MySQL errors) is not translated: it travels as a parameter (e.g. `git.command_failed` with `{ output }`) and is shown as is.
- SSE events that carry a DevDock message use the same `{ error, code, params }` object (e.g. the Git `notice` event).

Manifest and loader errors (`GET /api/core/extensions` → `error`, `warnings`) are developer diagnostics and stay in the source language.

## Configuration

`config.json` keeps its top-level keys (`groups`, `servers`, `projects`, …). Each key is a **section** owned by exactly one extension, the one that lists it in `setting.json → config`; two extensions cannot claim the same key. The backend describes each of its sections in `instance.config[key]`:

| Field | Purpose |
|---|---|
| `empty` | Default value, written when the key is missing |
| `validate(value, cfg)` | Called before every save and import; throwing rejects the write with a 400 (`cfg` is the whole config, for references between sections) |
| `normalize(value)` | Applied to imported data (e.g. keep only known fields) |
| `idField` | For lists: field that identifies an item in a *merge* import |
| `merge(current, incoming)` | Custom *merge* import (default: lists add the items with a new `idField`, objects add the new keys) |

Writes are atomic (temporary file + rename).

## Export and import

The header **Export** and **Import** dialogs are built from the checkboxes the extensions declare in `setting.json → export`. Each checkbox covers one or more of the extension's own `config` sections:

```json
"config": ["groups", "servers"],
"export": [
  { "id": "tunnels", "label": "Tunnel SSH", "description": "Gruppi e server", "sections": ["groups", "servers"] }
]
```

| Field | Meaning |
|---|---|
| `id` | Unique within the extension, `[a-z0-9-]` |
| `label` | Checkbox label; a string or a map by language tag |
| `description` | Optional hint under the label; a string or a map by language tag |
| `sections` | Sections included when the box is checked; they must be listed in the extension's `config` (otherwise the extension is disabled) |

Sections not covered by any checkbox are not exported. **Export** downloads a single `.json` file with the checked sections. **Import** reads the file in the browser, shows the checkboxes whose sections the file contains, and applies the checked ones in *merge* mode (new items added, existing ones unchanged, using `idField`/`merge`) or *replace* mode (the sections take the place of the current ones); everything else is left untouched.

## Frontend module

The shell loads an extension's panel the first time it is opened (or at startup with `preload`): it injects `view.html` into the panel and `sidebar.html` into the sidebar, adds `style.css`, then `import()`s `view.js` and calls `mount`. The panel keeps its DOM when the user switches to another section.

Static markup (titles, buttons, containers) lives in the HTML files; `view.js` only fills the dynamic parts, finding them by `data-role`, and wires static buttons through `data-action` attributes:

```html
<!-- extensions/git/sidebar.html -->
<div class="sidebar-head">
  <span class="sidebar-head-title">Repository</span>
  <button class="btn btn-ghost btn-sm" data-action="reload-repos">↻</button>
</div>
<div class="sidebar-body" data-role="repos"></div>
```

```js
// extensions/git/view.js
export default {
  async mount(ctx) {
    const list = ctx.sidebar.querySelector('[data-role="repos"]');
    const repos = await ctx.api.get('/repos');          // → GET /api/ext/git/repos
    list.innerHTML = repos.map(r =>
      `<button class="sb-item" onclick="Ext.git.select(${ctx.ui.js(r.id)})">${ctx.ui.esc(r.label)}</button>`).join('');
    ctx.expose({ select(id) { /* … */ } });             // window.Ext.git.select(...)
    ctx.setBadge(repos.length);
  },
  show(ctx) {},    // panel became visible
  hide(ctx) {},    // panel hidden (stop work that only matters while visible)
  refresh(ctx) {}, // the user pressed ↻ in the header
  languageChanged(ctx) {}, // the user picked another language (default: refresh)
};
```

`ctx` contains:

| Member | Purpose |
|---|---|
| `ctx.code`, `ctx.meta` | Extension code and its data from `/api/core/extensions` |
| `ctx.root` | Panel element (already contains `view.html`) |
| `ctx.sidebar` | Sidebar element, shown while the extension is active (already contains `sidebar.html`) |
| `ctx.api.get/post/put/del(path)` | JSON calls to `/api/ext/<code><path>`; errors become `Error` with the server message, plus `status` and `data` (the JSON body, e.g. `{ code }`) |
| `ctx.api.stream(path, body, onEvent)` | POST answered with SSE (e.g. git actions); resolves with the `exit` code; a non-2xx answer throws with `status` and `data` |
| `ctx.api.events(path, onEvent, onError)` | GET answered with SSE (`EventSource`); returns a function that closes it |
| `ctx.core` | Same client for `/api/core` (e.g. `ctx.core.get('/system')`) |
| `ctx.apiFor(code)` | Same client for another extension's API |
| `ctx.hasExtension(code)` | Whether another extension is loaded (for features that rely on it) |
| `ctx.t(key, params)` | Translation of a key of the extension's catalogs (keys are relative: `t('branches.title')` reads `git.branches.title`; keys starting with `core.` are the core's). See *Translations* |
| `ctx.i18n` | `lang` (active tag), `pick(value)` (text of a string-or-map manifest field), `apply(element)` (translates `data-i18n…` attributes in markup the extension creates) |
| `ctx.ui` | `t` (global keys), `fmt` (locale-aware formatting, see *Translations*), `toast`, `openModal`, `closeModal`, `esc`, `js`, `cssColor`, `ansiToHtml`, `formatUptime`, `toolNotice(message, installCmd, recheckHandler)`, `contextMenu(x, y, items)` (items: `{ label, icon, action, danger, disabled }` or `'separator'`), `notify(title, body, icon)` (desktop notification, if enabled with 🔔), `output` (the panel's output drawer: `open(title)`, `append(text, 'out'\|'err'\|'sys')`, `clear()`, `close()`) |
| `ctx.bus.on(name, fn)` / `ctx.bus.emit(name, detail)` | Events between extensions (e.g. `npm:projects-changed`) |
| `ctx.expose(obj)` | Publishes functions as `window.Ext.<code>` for inline handlers |
| `ctx.setBadge(value)` | Number or text on the tab or header button (`null` hides it) |
| `ctx.setPills(html)` | The extension's pills in the header bar (`''` removes them) |
| `ctx.open(code)`, `ctx.isActive()` | Open a section; whether this panel is visible |

Inline handlers call the functions published with `ctx.expose`, always escaping arguments with `ctx.ui.js(value)` and text with `ctx.ui.esc(value)` — values coming from repositories, `package.json` files or processes may contain quotes and markup.

Inside the panel, the sidebar and the pills the CSS variable `--ext-color` holds the extension colour; the `hidden` attribute always hides an element; elements with `data-uptime="<ISO date>"` show an elapsed time that updates every second. Shared classes (`btn`, `sidebar-head`, `sb-item`, `empty-state`, `data-table`, `form-row`, `pill`, `tool-notice`, …) are defined in `public/core/shell.css`.

The header (language, notifications, Export/Import dialogs built from the extensions' checkboxes, 🤖 MCP server, ↻) belongs to the core.

## Translations

The UI is translatable into any language; a language exists when its catalog exists, there is no list of languages in the code. **Italian is the source language**: its catalogs are complete and are the last fallback. English is the first additional language.

Catalogs are flat JSON files with dotted keys. The core's are in `public/core/i18n/<tag>.json` (`tag` is a BCP 47 tag: `it`, `en`, `pt-BR`, `zh-Hant`…) and carry a `_meta` block; an extension's are in `extensions/<code>/i18n/<tag>.json`, where `_meta` is optional and keys are automatically prefixed with the extension `code`:

```json
{
  "_meta": { "name": "Italian", "nativeName": "Italiano", "dir": "ltr" },
  "branches.title": "Branch",
  "branches.ahead": "{count} avanti",
  "commits": { "one": "{count} commit", "other": "{count} commit" }
}
```

- `{name}` is replaced with `params.name`. `{count}` is formatted for the active language (other numbers, such as ports or ids, are inserted as they are: format them with `fmt.number` when they are quantities).
- A value can be an object of plural forms by CLDR category (`zero`, `one`, `two`, `few`, `many`, `other`; only `other` is required), chosen with `Intl.PluralRules` on `params.count`.
- Lookup goes along the chain *active language → its base language (`pt-BR` → `pt`) → Italian → the key itself* (with a console warning), so a partially translated language works. An extension may support a different set of languages from the core, and may ship a language the core lacks (the core falls back to Italian for its own strings).
- Catalogs that fail validation are ignored and reported in the extension's warnings.

**Markup.** In `view.html` and `sidebar.html` use attributes instead of text; the shell translates them when the file is loaded and again when the language changes. Keys are relative to the extension:

```html
<span class="sidebar-head-title" data-i18n="sidebar.title"></span>
<button data-action="reload" data-i18n-title="sidebar.reload">↻</button>
<input data-i18n-placeholder="search.placeholder">
```

`data-i18n` (text), `data-i18n-title`, `data-i18n-placeholder` and `data-i18n-aria-label` are supported. For markup built in `view.js` call `ctx.t()` directly (or `ctx.i18n.apply(element)` on elements that use the attributes).

**Language change.** The user picks the language from the 🌐 button in the header (shown when there is more than one language); the choice is stored in the browser. Without a choice the language comes from `navigator.languages`. The change does not reload the page: the shell re-translates the static markup and calls `languageChanged(ctx)` (or `refresh(ctx)` when it is not defined) on every mounted module, which re-renders its dynamic parts.

**Formatting.** Dates, numbers and durations go through `ctx.ui.fmt`, never formatted by hand: `fmt.date(d, opts)`, `fmt.number(n, opts)`, `fmt.relative(d)` ("3 minutes ago"), `fmt.list(items)`, `fmt.bytes(n)`, `fmt.duration(seconds)`.

**Right-to-left languages.** A catalog with `"dir": "rtl"` sets `<html dir="rtl">`. Write CSS with logical properties (`margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `text-align: start`, `border-inline-start`) instead of left/right.

**Not translated:** the output of external commands (`git`, `npm`, `pm2`, `ssh`) is shown as is.

## Core API

| Route | Purpose |
|---|---|
| `GET /api/core/extensions` | Extensions with manifest data, state, warnings and error |
| `GET /api/core/mcp` · `POST /api/core/mcp/token` | MCP endpoint URL, token and tools of the extensions · regenerate the token |
| `/mcp` | MCP server (Streamable HTTP, bearer token, no browser requests) |
| `GET /api/core/i18n/languages` | Source language and available languages: `{ source, languages: [{ tag, name, nativeName, dir, core, completeness }] }` (`core: false` = only some extension ships it; `completeness` = % of the source keys translated, core and extensions together) |
| `GET /api/core/system` | Platform and external tools (`?refresh=1` checks again) |
| `GET /api/core/config/sections` | Config sections and their owner |
| `GET /api/core/config/export?sections=a,b&name=x` | Export (download), optionally limited to some sections |
| `POST /api/core/config/import` | Import `{ config, mode }`, per section (keys without an owner are ignored and reported) |

## Dependencies and npm workspaces

The root `package.json` declares `"workspaces": ["extensions/*"]`. An extension that needs npm packages adds its own `package.json`:

```json
{
  "name": "devdock-ext-db-client",
  "private": true,
  "dependencies": { "mysql2": "^3.11.0" }
}
```

A single `npm install` at the root installs everything into the shared `node_modules` (deduplicating common packages), and the backend uses the packages with a plain `require()`. Extensions without dependencies need no `package.json`.

## Creating an extension

1. Create `extensions/<code>/setting.json` with at least `name`, `code`, `color` and `position`.
2. Backend (if needed): declare the routes in `backend.routes` and write `server.js` returning `handlers` with the same names; use `ctx.lib.validate` and `ConfigError` for input coming from the UI.
3. Configuration (if needed): list the keys in `config`, describe them in `instance.config` and add the `export` checkboxes that should appear in the Export/Import dialogs.
4. Frontend (if needed): `view.html`, optionally `sidebar.html` and `style.css`, and `view.js` with `mount(ctx)`.
5. Texts: write the UI strings in `i18n/it.json` (the source language) and use them with `data-i18n…` attributes and `ctx.t()`; add `i18n/en.json` and any other language.
6. MCP (optional): declare `mcp.tools` and implement them in `instance.mcp` (see *MCP tools*).
7. Restart the server: the log line `Estensioni: …` lists the loaded extensions, and `GET /api/core/extensions` explains why one is disabled.
8. Add tests in `tests/` (see `tests/helpers.js`: `startServer()` runs DevDock on a free port with a temporary config).
