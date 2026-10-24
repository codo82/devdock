# DevDock — notes for Claude Code


Local developer dashboard (Express backend + vanilla JS frontend, no build step). Every feature is an extension.

Read before changing code:
- [README.md](README.md) — what DevDock does, how to run it, configuration
- [docs/EXTENSIONS.md](docs/EXTENSIONS.md) — extension contract (manifest, backend `ctx`, frontend `ctx`, config sections, export/import checkboxes)
- [ROADMAP.md](ROADMAP.md) — open milestones and task status (numbered from M1 again after 2.1.0; the closed ones, with their original numbers, are in [docs/ROADMAP-HISTORY.md](docs/ROADMAP-HISTORY.md))

## Working rules

- One branch per milestone (`feature/m<N>-…`); at the end of every roadmap task: mark it `[x]` in ROADMAP.md, commit, push.
- Commit messages in Italian; ROADMAP.md, README.md, CHANGELOG.md and docs in English.
- UI text never written in the code: it goes in the catalogs (`public/core/i18n/<lang>.json`, `extensions/<code>/i18n/<lang>.json`) and is used through `t()` / `ctx.t()` and `data-i18n` attributes. Italian (`it.json`) is the source language and must always be complete; keep `en.json` in step. API errors are `throw ctx.error(status, name, params)` with the message in `errors.<name>`. Dates and numbers go through `fmt` (Intl). `npm test` checks the catalogs and flags hard-coded Italian text.
- A milestone is closed with a minor version: CHANGELOG `[Unreleased]` → version, `npm version <x.y.0> --no-git-tag-version`, annotated tag `v<x.y.0>`, merge into `main`.
- An extension is a feature that can be added or removed (`extensions/<code>/`); what is always there belongs to the core (`lib/`, `routes/core.js`, `public/core/`): shell, header, configuration, security, languages, MCP server. The core changes only for those and for things every extension needs, and contract changes go in docs/EXTENSIONS.md.
- Validate every value that reaches a command (`ctx.lib.validate`, `ConfigError`); in generated HTML escape text with `esc()` and inline-handler arguments with `js()`.

## Running and testing

- `npm test` — integration tests (`node:test`); each test file starts DevDock as a separate process with a temporary config (`tests/helpers.js`).
- Manual checks: start an instance with `DEVDOCK_PORT=<port> DEVDOCK_CONFIG=<tmp file>` and temporary git repos/projects. Never modify the user's `config.json`, and never start tunnels towards the user's real servers (use aliases on `.invalid` domains).
- `npm run dev` restarts on backend changes; a new extension folder needs a restart.
