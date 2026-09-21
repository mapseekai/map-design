# MapDesign quickstart

## Requirements

Use Node.js 24, Corepack, and the pnpm version selected by `package.json`.

```bash
corepack enable
pnpm install
pnpm tools-dev start
pnpm tools-dev status
```

`tools-dev` starts local daemon, web, and desktop processes. Stop them with `pnpm tools-dev stop`; inspect logs with `pnpm tools-dev logs`.
Install and authenticate a supported local coding-agent CLI, or configure the built-in
**API Model** endpoint, key and model in Settings before creating a project. After the daemon starts, list the detected agent IDs:

```bash
MAP_DESIGN_DAEMON_URL=http://127.0.0.1:7456 md agents list --json
```

The example below uses `codex`; replace it with a detected agent ID when Codex
CLI is not installed and configured.

## Create a map project

Start the local runtime, then point `md` at the daemon. `--prompt-file -` reads
the initial brief from standard input:

```bash
printf '%s\n' 'Create an accessible base map with a restrained color palette.' \
  | MAP_DESIGN_DAEMON_URL=http://127.0.0.1:7456 md project create \
      --name "City base map" \
      --source-url "https://demotiles.maplibre.org/style.json" \
      --runtime codex \
      --prompt-file -
```

`MAP_DESIGN_DAEMON_URL` may instead be supplied as
`--daemon-url http://127.0.0.1:7456`. The required create options are
`--name`, `--source-url`, `--runtime`, and `--prompt-file`; `--model`,
`--reasoning`, and `--service-tier` are optional. Run `md --help` for the
top-level command list.

In Web Home, paste a public **MapLibre Style URL** in **Public map URL**. The
browser loads an interactive map automatically after a short input debounce;
a project name, design brief and local agent are not required for preview.
There is no **Check source** step. Preview failures show a retry action and do
not disable project creation. Browser preview requires cross-origin access
(CORS) to the Style and its resources; it does not use the daemon's resource
gateway or private credentials.

To create an editable project, enter **Project name** and **Design requirement**,
select a compatible **Local agent**, and select **Create map design**. Creation
downloads and validates the Style once, then saves an editable local draft.
Public tile, glyph, sprite and source-metadata URLs stay online and are loaded
on demand by MapLibre, using the same request policy as Home. A failed optional
resource does not invalidate the imported project. Preview success does not
guarantee future network availability. GeoJSON, TileJSON
and PMTiles URLs remain supported by project import; the direct Home preview
currently expects a MapLibre Style URL. Desktop Home also offers **Choose working
directory**.

## Local data

Set `MAP_DESIGN_DATA_DIR` before starting the daemon to choose its data root. It contains daemon-owned SQLite data, configuration, logs, projects, and agent state. Do not share it between unrelated local runs.

## Check changes

```bash
pnpm guard
pnpm typecheck
```

Run the focused package test for changed behavior.
## Import troubleshooting

Style JSON and GeoJSON URLs are downloaded directly, without an initial PMTiles
range probe. New Style projects do not eagerly download nested TileJSON documents.
Older gateway-backed projects remain compatible; within gateway preparation,
shared TileJSON documents are fetched only once.

Transient HTTP 408, 429, 500, 502, 503 and 504 responses receive at most two
retries with backoff. Retries honor `Retry-After` and share the original request
timeout and cancellation signal. A `Retry-After` longer than the available
budget is not ignored: the project remains retryable and displays a rate-limit
notice for HTTP 429. Retrying imports the existing project; it does not create
another project. Authentication failures and missing resources are not retried.

After updating daemon source or changing runtime dependencies, restart the daemon.
Refreshing the browser only updates the web client, not the running backend:

```bash
pnpm --filter @mapseekai/daemon build
pnpm tools-dev restart daemon
```

A stale daemon can otherwise continue using older import code and an older
CARTOGRAPHY runtime even when the web interface shows the latest changes.

## API execution budget

Choose **API Model** in Settings to expose **API execution budget**. Defaults are
48 model steps, 192 tool calls, 16,384 output tokens per map-editing model call,
and 32,768 output tokens per Cartography call. Output budgets must be supported
by the selected model; larger budgets can increase provider charges. Budgets
are persisted in `apiExecution` in the daemon configuration.

A failed operation is not resolved merely because another call of the same tool
succeeds. A model retry must reference `retryOfToolCallId` and preserve the same
semantic operation. Output truncation, model-step exhaustion, tool-count
exhaustion, repeated failures and unresolved calls have separate error codes.
Interrupted tasks retain the saved draft; a new user request should inspect
current state and continue only unfinished work. The app does not automatically
start an unbounded paid continuation loop.

Completed runs are persisted locally and removed from the active-memory registry.
Historical run queries, completion events and provenance are read from SQLite.
On restart, interrupted runs are marked as interrupted instead of being silently
executed again. Existing messages and project revisions are preserved.

## Network-independent and real-service tests

The usual Home UI tests use deterministic browser resources. The daemon's
`local-http-import.test.ts` exercises a real isolated HTTP server, compression,
project creation, persistence and reopening without relying on an external host.
To additionally run the real public-map acceptance tests:

```bash
MAP_DESIGN_EXTERNAL_SMOKE=1 pnpm --dir e2e exec playwright test \
  -c playwright.config.ts ui/map-design-home-layout.test.ts --workers=1
```

Only the agent is simulated in those acceptance tests. Map resources and the
import/rendering path are real. They depend on the external service being
available. No paid model API is needed for this test suite.

## Save and switch API models

In **Settings → Runtime → API Model**, use **Add model** and **Save model** to
keep multiple named endpoint/key/model configurations. Saved cards remain after
reload. **Test connection** explicitly verifies a basic response and displays its
status, time and latency; it may incur a small API charge. Saving alone does not
contact the model provider.

Choose **Set as default**, choose a saved model on project creation, or select a
profile in the conversation runtime picker. **Delete** removes a profile after
confirmation. A removed profile is not silently replaced in existing conversations.
See [Saved API model configurations](docs/api-model-profiles.md) for credentials,
connection testing and in-flight task behavior.
