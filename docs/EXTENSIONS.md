# DevDock extensions

Every feature of DevDock is an **extension**: a folder under `extensions/` that describes itself in `setting.json` and brings its own backend routes, HTML, JavaScript and CSS. The core only provides security, configuration storage by section, the extension loader, a few shared services and the UI shell (navigation, header, dialogs).

## Existing extensions

| Code | Position | Order | Owns in `config.json` | Export/import checkboxes | Dependencies | Preload |
|---|---|---|---|---|---|---|
| `tunnels` | tab | 10 | `groups`, `servers` | Tunnel SSH | — | yes |
| `pm2` | header | 10 | — | — | `npm` (optional) | no |
| `npm` | tab | 20 | `projects` | Progetti NPM | — | yes |
| `git` | tab | 30 | — | — | `npm` (required) | no |
| `swagger` | tab | 40 | — | — | — | no |

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
| `name` | yes | Label shown in the UI |
| `code` | yes | Unique id, `[a-z0-9-]`, equal to the folder name; used in URLs (`/api/ext/<code>`, `/ext/<code>`), in `dependencies` and as `window.Ext.<code>` |
| `version` | no | Extension version (SemVer) |
| `description` | no | One line |
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

Every route goes through the core security middleware (Host and Origin checks, JSON content type) and the core error handler: errors thrown by handlers, also asynchronous ones, become a JSON 500 (a 400 for a `ConfigError`).

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
    shutdown() { /* stop timers and child processes */ },
  };

  function repos() { /* uses npm.getProjects() */ }
};
```

Only `handlers` is needed when the manifest declares routes; everything else is optional.

`ctx` contains:

| Member | Purpose |
|---|---|
| `ctx.code`, `ctx.dir` | Extension code and folder |
| `ctx.config.get(key)` / `ctx.config.set(key, value)` | Read/write a key declared in `setting.json → config`; every write is validated and saved atomically. Other keys throw |
| `ctx.require(code)` | `services` of a dependency declared in the manifest (`null` if an optional dependency is missing) |
| `ctx.sse(res)` | Opens an SSE response; returns `send(type, data)`, with `send.end()` to close it |
| `ctx.lib.validate` | `KEY_RE`, `COLOR_RE`, `REMOTE_RE`, `ALIAS_RE`, `NPM_NAME_RE`, `PM2_TARGET_RE`, `isPort`, `isText`, `isValidBranchName`, `isValidCommitHash` |
| `ctx.lib.config` | `ConfigError` (throw it to reject input with a 400) and `pick(obj, fields)` |
| `ctx.lib.system` | `hasCommand(cmd)`, `getTools()` (installed external tools) |
| `ctx.lib.ports` | `getPortsForPgid(pid)`: TCP ports listened on by a process group |
| `ctx.log.info/warn/error(...)` | Console log prefixed with `[ext:<code>]` |

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
| `label` | Checkbox label |
| `description` | Optional hint under the label |
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
};
```

`ctx` contains:

| Member | Purpose |
|---|---|
| `ctx.code`, `ctx.meta` | Extension code and its data from `/api/core/extensions` |
| `ctx.root` | Panel element (already contains `view.html`) |
| `ctx.sidebar` | Sidebar element, shown while the extension is active (already contains `sidebar.html`) |
| `ctx.api.get/post/put/del(path)` | JSON calls to `/api/ext/<code><path>`; errors become `Error` with the server message |
| `ctx.api.stream(path, body, onEvent)` | POST answered with SSE (e.g. git actions); resolves with the `exit` code |
| `ctx.api.events(path, onEvent, onError)` | GET answered with SSE (`EventSource`); returns a function that closes it |
| `ctx.core` | Same client for `/api/core` (e.g. `ctx.core.get('/system')`) |
| `ctx.apiFor(code)` | Same client for another extension's API |
| `ctx.hasExtension(code)` | Whether another extension is loaded (for features that rely on it) |
| `ctx.ui` | `toast`, `openModal`, `closeModal`, `esc`, `js`, `cssColor`, `ansiToHtml`, `formatUptime`, `toolNotice(message, installCmd, recheckHandler)`, `notify(title, body, icon)` (desktop notification, if enabled with 🔔), `output` (the panel's output drawer: `open(title)`, `append(text, 'out'\|'err'\|'sys')`, `clear()`, `close()`) |
| `ctx.bus.on(name, fn)` / `ctx.bus.emit(name, detail)` | Events between extensions (e.g. `npm:projects-changed`) |
| `ctx.expose(obj)` | Publishes functions as `window.Ext.<code>` for inline handlers |
| `ctx.setBadge(value)` | Number or text on the tab or header button (`null` hides it) |
| `ctx.setPills(html)` | The extension's pills in the header bar (`''` removes them) |
| `ctx.open(code)`, `ctx.isActive()` | Open a section; whether this panel is visible |

Inline handlers call the functions published with `ctx.expose`, always escaping arguments with `ctx.ui.js(value)` and text with `ctx.ui.esc(value)` — values coming from repositories, `package.json` files or processes may contain quotes and markup.

Inside the panel, the sidebar and the pills the CSS variable `--ext-color` holds the extension colour; the `hidden` attribute always hides an element; elements with `data-uptime="<ISO date>"` show an elapsed time that updates every second. Shared classes (`btn`, `sidebar-head`, `sb-item`, `empty-state`, `data-table`, `form-row`, `pill`, `tool-notice`, …) are defined in `public/core/shell.css`.

The header (notifications, Export/Import dialogs built from the extensions' checkboxes, ↻) belongs to the core.

## Core API

| Route | Purpose |
|---|---|
| `GET /api/core/extensions` | Extensions with manifest data, state, warnings and error |
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
5. Restart the server: the log line `Estensioni: …` lists the loaded extensions, and `GET /api/core/extensions` explains why one is disabled.
6. Add tests in `tests/` (see `tests/helpers.js`: `startServer()` runs DevDock on a free port with a temporary config).
