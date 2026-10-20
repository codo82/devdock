# DevDock extensions

Every feature of DevDock (SSH tunnels, npm, PM2, Git, Swagger, DB client, …) is an **extension**: a folder under `extensions/` that describes itself in `setting.json` and brings its own backend routes, HTML, JavaScript and CSS. The core only provides security, configuration storage, shared services and the UI shell.

## Folder layout

```
extensions/
  git/
    setting.json     manifest (required)
    server.js        backend: route handlers, services for other extensions
    view.html        markup of the panel
    sidebar.html     markup of the sidebar (optional)
    view.js          frontend logic (ES module)
    style.css        styles (optional)
    package.json     own npm dependencies (optional, npm workspace)
```

Only `setting.json` is mandatory: an extension can be frontend-only (Swagger) or backend-only (a service used by other extensions).

## `setting.json`

```json
{
  "name": "Git",
  "code": "git",
  "version": "1.0.0",
  "description": "Status, commit, graph and remote operations for the project repositories",
  "color": "#3fb950",
  "icon": "🌿",
  "position": "tab",
  "order": 30,
  "dependencies": [
    { "code": "npm", "required": true }
  ],
  "config": ["git"],
  "backend": {
    "module": "server.js",
    "routes": [
      { "method": "GET",  "path": "/repos",                    "handler": "listRepos" },
      { "method": "GET",  "path": "/repos/:id/status",         "handler": "status" },
      { "method": "POST", "path": "/repos/:id/action",         "handler": "runAction", "stream": true }
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
| `code` | yes | Unique id, `[a-z0-9-]`; used in URLs (`/api/ext/<code>`, `/ext/<code>`) and in `dependencies` |
| `version` | no | Extension version (SemVer) |
| `description` | no | One line, shown in the extensions list |
| `color` | yes | Accent colour (`#rrggbb`) for tab, badges and pills |
| `icon` | no | Emoji or short text for the tab / header button |
| `position` | yes | `"tab"`: entry in the section bar with its own panel · `"header"`: button in the header bar that opens its panel |
| `order` | no | Sort order of tabs (shared with the core sections) and header buttons (default 100). The first tab opens at startup |
| `dependencies` | no | `required: true` → the extension is not loaded if the dependency is missing or failed · `required: false` → it loads, but shows a warning icon and must cope with the dependency being absent |
| `config` | no | Top-level keys of `config.json` owned by the extension (see *Configuration*) |
| `backend.module` | no | Backend file, relative to the extension folder |
| `backend.routes` | no | Routes mounted under `/api/ext/<code>`; each one names a handler exported by the module |
| `transfer` | no | Extra export/import formats offered in the header dialogs (see *Export and import formats*) |
| `frontend.html` / `sidebar` / `js` / `css` | no | Files served under `/ext/<code>/…`; only the files listed here are served. Without `sidebar` the panel takes the full width |
| `frontend.preload` | no | `true`: the module is mounted at startup (hidden) instead of on first open — for extensions that keep header pills, badges or notifications up to date in the background |

### Routes

Routes are declared in the manifest, not registered by code, so the whole API surface of an extension is readable in one place and the loader can check it:

- `method`: `GET`, `POST`, `PUT`, `DELETE`
- `path`: Express path relative to `/api/ext/<code>`, e.g. `/repos/:id/action`
- `handler`: name of a function returned by the backend module (see below); the loader refuses to start an extension whose manifest names a handler that does not exist, and warns about handlers that no route uses
- `stream: true`: the handler answers with Server-Sent Events (documentation only; the handler still opens the stream through `ctx.sse(res)`)

Every route goes through the core security middleware (Host/Origin checks, JSON content type) and the core error handler.

## Backend module

```js
// extensions/git/server.js
module.exports = function createGit(ctx) {
  const npm = ctx.require('npm');            // services of a dependency

  return {
    handlers: {
      listRepos(req, res) { res.json(repos()); },
      async status(req, res) { /* … */ },
      async runAction(req, res) {
        const send = ctx.sse(res);           // opens the SSE stream
        send('stdout', '$ git fetch\n');
      },
    },
    services: { repos },                     // available to extensions that depend on this one
    config: {                                // rules for the config keys declared in setting.json
      git: { empty: {}, validate(value, cfg) { /* throw to reject */ } },
    },
    shutdown() { /* stop timers, child processes */ },
  };

  function repos() { /* uses npm.getProjects() */ }
};
```

`ctx` contains:

| Member | Purpose |
|---|---|
| `ctx.code`, `ctx.dir` | Extension code and folder |
| `ctx.config.get(key)` / `ctx.config.set(key, value)` | Read/write one of the `config` keys declared in the manifest (validated and saved atomically by the core) |
| `ctx.require(code)` | `services` of a dependency (`null` for a missing optional dependency) |
| `ctx.sse(res)` | Opens an SSE response and returns `send(type, data)` |
| `ctx.lib` | Shared core services: validators, git runner, tracked processes, system tools |
| `ctx.log(...)` | Console log prefixed with the extension code |

Backends are created in dependency order (topological sort; cycles are an error) and shut down in reverse order when the server stops.

## Configuration

`config.json` keeps its top-level keys (`groups`, `servers`, `projects`, …). Each key is a **section** with exactly one owner: the core or the extension that lists it in `setting.json → config`. Two extensions cannot claim the same key; an extension can take over a core section (it then inherits the core rules unless it provides its own).

The backend describes each of its sections in `instance.config[key]`:

| Field | Purpose |
|---|---|
| `empty` | Default value, written when the key is missing |
| `validate(value, cfg)` | Called before every save and import; throwing rejects the write with a 400 |
| `normalize(value)` | Applied to imported data (e.g. keep only known fields) |
| `idField` | For lists: field that identifies an item in a *merge* import |
| `merge(current, incoming)` | Custom *merge* import (default: lists add the items with a new `idField`, objects add the new keys) |

Writes are atomic (temporary file + rename). Export and import work per section: `GET /api/core/config/export?sections=a,b`, `POST /api/core/config/import` with `{ config, mode: "replace" | "merge" }`; sections missing from the file are left untouched, unknown keys are ignored and reported.

## Export and import formats

Besides the `config.json` sections, an extension can offer its own formats in the header **Export** and **Import** dialogs:

```json
"transfer": [
  { "id": "ssh-commands", "label": "Comandi ssh", "description": "Script con un comando ssh -N -L per ogni server",
    "export": "exportSshCommands", "filename": "devdock-tunnels.sh" },
  { "id": "folders", "label": "Cartelle di progetto", "description": "Un percorso assoluto per riga", "import": "importFolders" }
]
```

`export` and `import` name functions in the backend's `instance.transfer` (the loader refuses an extension whose manifest names a missing one):

```js
transfer: {
  exportSshCommands() { return '#!/bin/sh\n…'; },          // string → text file; object → JSON file
  importFolders(content) { /* … */ return '2 progetti aggiunti'; }, // file content as text → message for the user
},
```

The core exposes them as `GET /api/core/transfers`, `GET /api/core/transfers/<code>/<id>/export` (download, named after `filename` or `devdock-<code>-<id>.txt|json`) and `POST /api/core/transfers/<code>/<id>/import` with `{ content }`. A `ConfigError` thrown by an import becomes a 400 with its message.

## Frontend module

The shell loads an extension's panel the first time it is opened: it injects `view.html` into the panel and `sidebar.html` into the sidebar, adds `style.css`, then `import()`s `view.js` and calls `mount`. The panel keeps its DOM when the user switches to another section.

Static markup (titles, buttons, containers) lives in the HTML files; `view.js` only fills the dynamic parts, finding them by `data-role`, and wires static buttons through `data-action` attributes:

```html
<!-- sidebar.html -->
<div class="sidebar-head">
  <span class="sidebar-head-title">Repository</span>
  <button class="btn btn-ghost btn-sm" data-action="refresh">↻</button>
</div>
<div class="sidebar-body" data-role="repos"></div>
```

```js
// extensions/git/view.js
export default {
  async mount(ctx) {
    const list = ctx.sidebar.querySelector('[data-role="repos"]');
    const repos = await ctx.api.get('/repos'); // → GET /api/ext/git/repos
    ctx.expose({ selectRepo });                // window.Ext.git.selectRepo(...) for inline handlers
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
| `ctx.code`, `ctx.meta` | Extension code and the data from `/api/core/extensions` |
| `ctx.root` | Panel element (already contains `view.html`) |
| `ctx.sidebar` | Sidebar element shown while the extension is active (already contains `sidebar.html`) |
| `ctx.api.get/post/put/del(path)` | JSON calls to `/api/ext/<code><path>`; errors become `Error` with the server message |
| `ctx.api.stream(path, body, onEvent)` | POST answered with SSE (e.g. git actions); resolves with the `exit` code |
| `ctx.api.events(path, onEvent)` | GET answered with SSE (`EventSource`); returns a function that closes it |
| `ctx.core` | Same client for `/api/core` |
| `ctx.ui` | `toast`, `openModal`, `closeModal`, `esc`, `js`, `cssColor`, `ansiToHtml`, `formatUptime`, `toolNotice(message, installCmd, recheckHandler)`, `notify(title, body, icon)` (desktop notification, if enabled with 🔔), `output` (the panel's output drawer: `open(title)`, `append(text, 'out'|'err'|'sys')`, `clear()`, `close()`) |
| `ctx.bus.on(name, fn)` / `ctx.bus.emit(name, detail)` | Events between extensions |
| `ctx.expose(obj)` | Publishes functions as `window.Ext.<code>` for inline handlers |
| `ctx.setBadge(value)` | Number or text on the tab (`null` hides it) |
| `ctx.setPills(html)` | The extension's pills in the header bar (`''` removes them); `--ext-color` is available there too |
| `ctx.open(code)`, `ctx.isActive()` | Navigate to another section; whether this panel is visible |

Inline handlers in generated HTML call the functions exposed with `ctx.expose`, always escaping arguments with `ctx.ui.js(value)`; text goes through `ctx.ui.esc(value)`:

```js
`<button onclick="Ext.git.selectRepo(${ctx.ui.js(repo.id)})">${ctx.ui.esc(repo.label)}</button>`
```

Inside the panel the CSS variable `--ext-color` holds the extension colour, and the `hidden` attribute always hides an element. Elements with `data-uptime="<ISO date>"` show an elapsed time that updates every second.

The header (notifications toggle, export/import of `config.json` by section, ↻) belongs to the core.

## Core API

| Route | Purpose |
|---|---|
| `GET /api/core/extensions` | Loaded extensions with manifest data, state (`ok`, `warning`, `disabled`) and missing dependencies |
| `GET /api/core/system` | Platform and external tools |
| `GET /api/core/config/sections` | Config sections and their owner |
| `GET /api/core/config/export?sections=a,b&name=x` | Export (download), optionally limited to some sections |
| `POST /api/core/config/import` | Import `{ config, mode }`, per section |
| `GET /api/core/transfers` | Export/import formats offered by the extensions |
| `GET /api/core/transfers/<code>/<id>/export`, `POST …/import` | Run one of them |

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
