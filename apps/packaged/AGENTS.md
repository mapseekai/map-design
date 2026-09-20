# Packaged runtime

`apps/packaged` assembles the packaged MapDesign runtime. It reads the packaged configuration, starts the local daemon and web sidecars, registers `map-design://`, and delegates the window to `@mapseekai/desktop`.

- Use `@mapseekai/sidecar-proto`, `@mapseekai/sidecar`, and `@mapseekai/platform` for process identity, IPC, and paths.
- Keep packaged data under `MAP_DESIGN_DATA_DIR` when configured; otherwise use the packaged namespace root.
- Treat packaged configuration, map content, and sidecar output as untrusted at their boundaries.
- Keep product behavior in the daemon, web, or desktop packages rather than duplicating it here.

```bash
pnpm --filter @mapseekai/packaged test
pnpm --filter @mapseekai/packaged typecheck
```
