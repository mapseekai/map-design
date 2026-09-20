# MapDesign engineering guide

MapDesign is a local-first map workspace. Read the nearest directory `AGENTS.md` before changing an app, package, tool, or test.

## Architecture and boundaries

- `apps/web` and `apps/desktop` are clients of the local daemon; shared request and response shapes belong in `packages/contracts`.
- `apps/daemon` owns API routes, SQLite state, map projects, agent execution, MCP, and the `md` CLI.
- `packages/map-design-contracts` owns map-domain types. Keep `packages/contracts` pure TypeScript.
- `skills/map-design`, `skills/cartography-init`, `skills/cartography-md`, and `skills/data-profile` are bundled skills.
- Use `MAP_DESIGN_DATA_DIR` as the daemon data-root configuration. Daemon-owned state, logs, credentials, and agent state derive from it; never commit it.

## Commands

Node 24 and pnpm 10.33 are required. Before running project commands, verify `node --version` reports `v24.x`. With nvm, run `nvm use` from the repository root; in a non-interactive shell, load `$NVM_DIR/nvm.sh` (or `$HOME/.nvm/nvm.sh`) first. Do not run checks under another Node major or rebuild native dependencies for an unsupported runtime.

```bash
pnpm install
pnpm tools-dev start
pnpm tools-dev status
md status
pnpm guard
pnpm typecheck
```

`tools-dev` manages local daemon, web, and desktop processes. `tools-pack` builds and controls local installers for `mac`, `win`, and `linux`. Use focused package commands instead of root build or test aliases.

## Security and UI

Keep credentials server-side and local. Validate source paths and untrusted map content at the daemon boundary. Never expose local files, secrets, or daemon-only APIs to browser code.

Reuse web primitives, preserve accessibility, and update every locale for user-visible strings. Put app and tool tests in their `tests/` directories; Playwright coverage belongs in `e2e`.

## Code intelligence

Use CodeGraph when this checkout is indexed to inspect symbols and call paths before code changes. Do not rely on an unavailable index; use focused source reads instead.
