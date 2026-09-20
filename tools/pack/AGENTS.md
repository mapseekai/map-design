# tools-pack

`tools-pack` builds and operates local MapDesign installers for `mac`, `win`, and `linux`.

- Keep packaging orchestration in this tool; product behavior belongs in the applications and shared packages.
- Use `@mapseekai/sidecar-proto`, `@mapseekai/sidecar`, and `@mapseekai/platform` for namespaces, process identity, IPC, and paths.
- Keep pack resources in `tools/pack/resources`. Keep generated output and local installer state outside source control.
- Use `MAP_DESIGN_DATA_DIR` only for daemon-owned data; do not use transient ports as path identity.
- Validate changed platform behavior with the relevant `tools-pack` command and focused tests.

```bash
pnpm --filter @mapseekai/tools-pack test
pnpm --filter @mapseekai/tools-pack typecheck
```
