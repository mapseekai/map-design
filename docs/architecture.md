# MapDesign architecture

MapDesign is a local application: web and desktop clients use one local daemon.

## Runtime

- `apps/web` renders the browser client and calls daemon APIs.
- `apps/desktop` hosts the desktop window.
- `apps/packaged` starts packaged local processes and launches the desktop host.
- `apps/daemon` exposes the local API, owns SQLite persistence, starts local agents, serves MCP, and implements `md`.
- `packages/contracts` carries shared API shapes; `packages/map-design-contracts` carries map-domain types.

`tools-dev` starts and observes daemon, web, and desktop development processes. `tools-pack` builds installers for its `mac`, `win`, and `linux` targets.

## Data flow

A map source enters a project through the daemon. The daemon stores project state, drafts, validation output, previews, revisions, and runs under its data root. Web, desktop, `md`, MCP, and local agent runs use that daemon state instead of separate stores.

Set `MAP_DESIGN_DATA_DIR` before daemon startup to select the data root; otherwise it is `.map-design` in the working directory.

## Security boundary

The daemon is the trusted local boundary for filesystem access, SQLite data,
credentials, and agent subprocesses. It binds to loopback by default and
accepts only loopback HTTP origins for local daemon requests. A non-loopback
bind requires API-token authentication unless explicitly disabled. Tool routes
also require a bearer tool grant minted for one project and run, scoped to the
allowed MapDesign endpoints and operations, and revoked when the child exits.

The desktop renderer is not a privileged boundary: Electron runs it with
`sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`. Its
preload exposes a narrow, versioned bridge for the desktop working-directory
picker rather than Node or Electron APIs. New-window and navigation requests
are denied in the renderer; trusted current content remains in the desktop
window and HTTP(S) destinations open externally.

Map-source content and agent output are untrusted input and must be validated
before they affect local state or rendering.