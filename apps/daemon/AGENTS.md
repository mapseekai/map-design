# Daemon

The daemon owns the local API, SQLite state, map projects, validation, revisions, runs, MCP, and the `md` CLI. It is the trusted boundary for local files, credentials, and agent subprocesses.

Keep HTTP routes in their domain module, shared request and response shapes in `packages/contracts`, runtime definitions in `src/runtimes/defs/`, and tests in `tests/`. Do not expose daemon internals to web code. Derive daemon-owned state from `MAP_DESIGN_DATA_DIR`.

```bash
pnpm --filter @mapseekai/daemon typecheck
pnpm --filter @mapseekai/daemon test
```