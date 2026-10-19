# DevDock

Local web dashboard for everyday development: SSH tunnels, npm scripts, PM2, Git and Swagger preview in a single interface.

It runs on your own machine and only answers on `http://127.0.0.1:3500`. The user interface is in Italian.

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

- **🔗 SSH tunnels** — servers grouped by colour; one click opens `ssh -N -L 127.0.0.1:<port>:<remote> <alias>`. Automatic reconnection with backoff (5s → 60s), per-tunnel logs, desktop notifications, "Stop all".
- **📦 NPM** — local projects: run the `package.json` scripts with live logs, restart/stop (the whole process group), listening ports, dependencies with installed version and `npm outdated`.
- **⚙️ PM2** — process list, start/stop/restart/delete, streaming logs. Opened from the ⚙️ icon in the header.
- **🌿 Git** — repositories are derived from the NPM projects (walking up to the `.git` folder). Status, file selection and commit, commit graph, pull/push/merge/checkout/stash/fetch. Only one git operation at a time runs on each repository.
- **📄 Swagger** — preview of an OpenAPI `.yaml`/`.json` file loaded from disk (Swagger UI from CDN).
- **≡ Configuration** — management of tunnel groups and servers; configuration export/import from the header.

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
  "projects": [
    { "id": "my_app", "label": "My App", "path": "/Users/me/www/my-app" }
  ]
}
```

- `servers[].port` — local port on `127.0.0.1`
- `servers[].remote` — `host:port` reached from the SSH server
- `servers[].alias` — host or alias from `~/.ssh/config` (authentication is ssh's own: keys, agent)
- `projects[].path` — absolute path of the folder containing `package.json`

The export can include everything, only the tunnels or only the projects. The import applies only the sections present in the file: *replace* overwrites those sections, *merge* adds the new items; sections missing from the file are left untouched.

## Security

DevDock is meant **for local use only**: it listens on `127.0.0.1` and has no authentication. It can run `ssh`, `npm`, `git` and `pm2` on your machine, so it must not be exposed on a network.

Active protections:
- the API only accepts requests from its own UI (`Origin`/`Referer` and `Host` checks), so other pages open in the browser cannot use it;
- every parameter that ends up in a command (branch, remote, file, script, package, SSH alias) is validated;
- `config.json` is validated on every save and import;
- external libraries (Swagger UI) are loaded with Subresource Integrity.

Local command-line clients (curl, scripts) that send no `Origin` header are allowed, like any other local program.

## Development

- Backend: `server.js` (Express)
- Frontend: `public/index.html` (HTML, CSS and vanilla JavaScript in a single file, no build step)

Roadmap and progress: [ROADMAP.md](ROADMAP.md) · Changes: [CHANGELOG.md](CHANGELOG.md)
