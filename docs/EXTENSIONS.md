# DevDock extensions

Every feature of DevDock (SSH tunnels, npm, PM2, Git, Swagger, DB client, …) is an **extension**: a folder under `extensions/` that describes itself in `setting.json` and brings its own backend routes, HTML, JavaScript and CSS. The core only provides security, configuration storage, shared services and the UI shell.

## Folder layout

```
extensions/
  git/
    setting.json     manifest (required)
    server.js        backend: route handlers, services for other extensions
    view.html        markup of the panel
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
| `order` | no | Sort order among extensions with the same position (default 100) |
| `dependencies` | no | `required: true` → the extension is not loaded if the dependency is missing or failed · `required: false` → it loads, but shows a warning icon and must cope with the dependency being absent |
| `config` | no | Top-level keys of `config.json` owned by the extension (see *Configuration*) |
| `backend.module` | no | Backend file, relative to the extension folder |
| `backend.routes` | no | Routes mounted under `/api/ext/<code>`; each one names a handler exported by the module |
| `frontend.html` / `js` / `css` | no | Files served under `/ext/<code>/…`; only the files listed here are served |

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

`config.json` keeps its top-level keys (`groups`, `servers`, `projects`, …). Each key belongs to exactly one extension, declared in `setting.json → config`. An extension can export `validateConfig(values)` from its backend: the core calls it before every save and on import, and rejects the write with a 400 when it throws. Export and import work per extension section.

## Frontend module

The shell loads an extension's panel the first time it is opened: it injects `view.html` into the panel, adds `style.css`, then `import()`s `view.js` and calls `mount`.

```js
// extensions/git/view.js
export default {
  mount(ctx) {
    // ctx.root: panel element (already contains view.html)
    // ctx.sidebar: sidebar element for this extension
    // ctx.api.get/post/put/del('/repos') → /api/ext/git/repos
    // ctx.ui: toast, modal, confirm, output (SSE panel), esc, js
    // ctx.bus: emit/on for events between extensions
    ctx.expose({ selectRepo });   // window.Ext.git.selectRepo(...) for inline handlers
  },
  show(ctx) {},                   // panel became visible (start polling)
  hide(ctx) {},                   // panel hidden (stop polling)
  badge(ctx) { return 3; },       // optional: number/text on the tab
};
```

Inline handlers in generated HTML call the functions exposed with `ctx.expose`, always escaping arguments with `ctx.ui.js(value)`:

```js
`<button onclick="Ext.git.selectRepo(${ctx.ui.js(repo.id)})">…</button>`
```

## Core API

| Route | Purpose |
|---|---|
| `GET /api/core/extensions` | Loaded extensions with manifest data, state (`ok`, `warning`, `disabled`) and missing dependencies |
| `GET /api/core/system` | Platform and external tools |
| `GET /api/core/config/export`, `POST /api/core/config/import` | Export/import, per extension section |

## Dependencies and npm workspaces

The root `package.json` declares `"workspaces": ["extensions/*"]`. An extension with its own `package.json` lists its dependencies there; a single `npm install` at the root installs everything into the shared `node_modules`.
