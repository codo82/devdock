# DevDock — notes for Claude Code

Local developer dashboard (Express backend + vanilla JS frontend, no build step). Every feature is an extension.

Read before changing code:
- [README.md](README.md) — what DevDock does, how to run it, configuration
- [docs/EXTENSIONS.md](docs/EXTENSIONS.md) — extension contract (manifest, backend `ctx`, frontend `ctx`, config sections, export/import checkboxes)
- [ROADMAP.md](ROADMAP.md) — milestones and task status

## Working rules

- One branch per milestone (`feature/m<N>-…`); at the end of every roadmap task: mark it `[x]` in ROADMAP.md, commit, push.
- Commit messages and UI text in Italian; ROADMAP.md, README.md, CHANGELOG.md and docs in English.
- A milestone is closed with a minor version: CHANGELOG `[Unreleased]` → version, `npm version <x.y.0> --no-git-tag-version`, annotated tag `v<x.y.0>`, merge into `main`.
- New features go in `extensions/<code>/`, not in the core (`lib/`, `routes/core.js`, `public/core/`). The core changes only for things every extension needs, and the contract change goes in docs/EXTENSIONS.md.
- Validate every value that reaches a command (`ctx.lib.validate`, `ConfigError`); in generated HTML escape text with `esc()` and inline-handler arguments with `js()`.

## Running and testing

- `npm test` — integration tests (`node:test`); each test file starts DevDock as a separate process with a temporary config (`tests/helpers.js`).
- Manual checks: start an instance with `DEVDOCK_PORT=<port> DEVDOCK_CONFIG=<tmp file>` and temporary git repos/projects. Never modify the user's `config.json`, and never start tunnels towards the user's real servers (use aliases on `.invalid` domains).
- `npm run dev` restarts on backend changes; a new extension folder needs a restart.
