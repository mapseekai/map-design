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
## Cartographic design documents

The runtime uses the standard CARTOGRAPHY.md format 0.4.0 with the official
0.4.1 parser/linter, pins each project's full document source, and keeps runtime
quality policy separate from document format validation. See
[Cartography runtime integration](cartography-runtime.md) for selection,
content digests, compatibility, and migration details.

## Resource transport

New Style imports persist a validated, editable document with public resource
URLs resolved against the final Style URL. Nested TileJSON, glyphs, sprites and
tiles are not eagerly captured. The Home preview and Studio use the shared
`resource-request.ts` transform. Direct requests carry no daemon headers.
Private/local schemes and same-origin application APIs cannot be used as public
map resources. Browser CORS and Electron isolation remain enabled.

Older projects and non-Style import paths can retain project-scoped gateways.
Those gateways use a bounded DNS-pinned connection pool, per-host scheduling,
in-flight request sharing, explicit-freshness LRU caching, content-correct ETags,
bounded HTTP decoding, and cancellation-aware finite retries. See
[resource and runtime reliability](resource-runtime-reliability.md) for bounds,
compatibility and regression coverage.

## Run history

`map_design_run_history` stores bounded final messages, request-id/digest receipts
and safe runtime/model provenance. Initial messages and the run receipt are
created in one transaction. Completed runs are evicted from the active registry;
GET, terminal SSE replay and revision provenance fall back to persisted records.
Startup recovery marks interrupted runs failed for explicit user review and does
not replay model calls automatically. The history table references its project
with cascading deletion.
