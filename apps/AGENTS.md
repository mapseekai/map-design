# Applications

- `web` is the browser client for the local daemon.
- `daemon` owns APIs, SQLite state, agent runs, MCP, and `md`.
- `desktop` hosts the Electron window.
- `packaged` starts packaged local processes and the desktop host.

Keep browser code behind daemon APIs and `packages/contracts`; do not import daemon internals into web code. Use `MAP_DESIGN_DATA_DIR` for daemon-owned local state. Put application tests in each app's `tests/` directory and browser automation in `e2e`.

```bash
pnpm --filter @mapseekai/web typecheck
pnpm --filter @mapseekai/daemon test
```
## Interface design

Use the repository-root `DESIGN.md` as the UI visual reference. Shared colors and font aliases belong in `web/src/styles/tokens.css`; preserve the MapDesign identity and adapt editorial spacing to compact studio controls. Keep the conversation header and chat pane in their existing grid rows: project metadata belongs inside the header, not as an additional grid child.

The UI uses Tailwind CSS v4 and shadcn/ui (Base UI Nova) from `@mapseekai/components`. Compose those primitives with semantic Tailwind utilities; do not add page CSS Modules or global raw-control styling. Read `docs/ui.md` for component ownership, source scanning, and the React 18 ref compatibility requirement.
