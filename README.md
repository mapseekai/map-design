# MapDesign

MapDesign is a local-first workspace for creating and reviewing map styles. It imports map sources, keeps projects and revisions in a local daemon, renders the workflow in web and desktop clients, and lets installed coding agents work through the same local API.

## Start

Node.js 24 and Corepack-managed pnpm 10.33 are required.

```bash
corepack enable
pnpm install
pnpm tools-dev start
pnpm tools-dev status
```

`tools-dev` starts local daemon, web, and desktop processes. Use
`pnpm tools-dev stop` to stop them and `pnpm tools-dev logs` to inspect their
logs.

## Map preview and creation

Paste a public MapLibre Style URL in Web Home to preview it directly in the
browser, without a separate source check or a configured agent. Map preview and
project creation have independent states: a preview error does not block creating
an editable project. The daemon retains import-time validation and resource
management. See [Quickstart](QUICKSTART.md) for supported sources and CORS notes.

## CLI

`md` is the daemon CLI. Its top-level commands are `agents`, `config`,
`doctor`, `project`, `run`, `status`, and `tool`. Its project-create syntax is:

```text
md project create --name <name> --source-url <url> --runtime <adapter> --prompt-file <path|->
  [--model <model>] [--reasoning <level>] [--service-tier <tier>]
  [--daemon-url <url>] [--json]
```

Set `MAP_DESIGN_DAEMON_URL` instead of passing `--daemon-url`; one is required.
See [Quickstart](QUICKSTART.md) for a runnable stdin example and Web Home
controls.

## Online resources and API execution

New Style projects keep an editable local Style and load public dependencies
on demand. Home and Studio share the same direct-resource policy; existing
resource-gateway projects continue to work. Remote data is not an offline
snapshot and remains subject to CORS and service availability.

The built-in API Model has configurable step, tool-call and output budgets in
Settings. Failed calls are tracked individually, with explicit repair links;
finished run history and provenance remain in SQLite rather than accumulating
in memory. See [resource and runtime reliability](docs/resource-runtime-reliability.md).

## Workspace

- `apps/web` — web client.
- `apps/daemon` — local HTTP API, SQLite persistence, `md`, MCP, and agent orchestration.
- `apps/desktop` and `apps/packaged` — Electron desktop runtime and packaged launcher.
- `packages/contracts` and `packages/map-design-contracts` — shared API and map-domain contracts.
- `skills/map-design` — bundled agent skill.
- `tools/dev` and `tools/pack` — local lifecycle and installer tooling.

Read [Quickstart](QUICKSTART.md), [architecture](docs/architecture.md), [agent adapters](docs/agent-adapters.md), and the [skill protocol](docs/skills-protocol.md).

## Build, install, and runtime support

`tools-pack` uses platform actions. `inspect` is its status command:

```bash
pnpm tools-pack linux build --to appimage
pnpm tools-pack linux install
pnpm tools-pack linux start
pnpm tools-pack linux inspect
pnpm tools-pack linux stop
pnpm tools-pack linux cleanup
```

Build commands are platform-specific:

```bash
pnpm tools-pack mac build --to all
pnpm tools-pack win build --to nsis
pnpm tools-pack linux build --to appimage
```

Each platform accepts its own `install`, `start`, `inspect`, `stop`, and
`cleanup` actions, for example `pnpm tools-pack mac inspect`.

| Platform | Build artifact and support truth |
| --- | --- |
| Linux | The AppImage build and extracted-app lifecycle are supported. `tools-dev` Electron is current on WSL. |
| macOS | Build and lifecycle commands exist, but this workspace has test coverage only; it makes no native macOS verification claim. |
| Windows | Build and lifecycle commands exist, but this workspace has test coverage only; it makes no native Windows verification claim. |

## Validate

```bash
pnpm guard
pnpm typecheck
```

Run focused package tests for changed behavior.