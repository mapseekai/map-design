# Resource and API runtime reliability

## Scope

This change addresses the eight issues identified in the resource/API audit,
plus consistent online Style loading, bounded request management, completed-run
retention, and stable local test coverage. Existing project data is not rewritten.

| Audit item | Implementation | Regression evidence |
| --- | --- | --- |
| F01 stale ETag / incorrect 304 | Missing upstream validators are replaced by a hash of the actual response bytes; individual PMTiles tiles use their own content hash. | `resources/resource-consistency.test.ts` |
| F02 compressed JSON/resources | HTTP gzip, deflate and br decode under the original deadline, cancellation and decoded-byte bound. Range requests require identity encoding. | `ingestion/decoded-body.test.ts`, `local-http-import.test.ts` |
| F03 incomplete tile templates | XYZ, native-expanded TMS, ratio, prefix, quadkey and WMS bbox values survive gateway rewriting; old XYZ paths remain valid. | `resources/tile-template.test.ts` |
| F04 lost status / generic fatal UI | Protocol errors preserve safe HTTP status and Retry-After; source failures are warnings rather than a failed workspace. | `web/tests/map-design/resource-request.test.ts` |
| F05 runtime resources bypass retries | Gateway resource reads use the same cancellation-aware finite retry helper as import. HTTP 429 remains distinguishable. | `resources/resource-consistency.test.ts` |
| F06 nested backoff ignores cancel | Parent cancellation reaches nested metadata download and retry sleeps. | `ingestion/nested-import-cancellation.test.ts` |
| F07 unrelated success clears failure | Failures use call IDs; explicit linked retries must have the same semantic operation. | `agents/api-execution.test.ts` |
| F08 provider flags ignored | Compatible Chat, Responses and Anthropic provider options use their actual namespaces and wire fields. Tool schemas explicitly opt out of strict mode. | `agents/api-model.test.ts` |

Daemon test paths in this table are relative to `apps/daemon/tests/map-design`.

## Direct and managed resources

New Style imports fetch and validate the root document, resolve public URLs
against its final URL, and persist the editable Style locally. They do not
require successful eager downloads of nested TileJSON, glyphs, sprites or tiles.
Home and Studio use the same browser resource transform. Direct external calls
receive no daemon authentication headers; normal browser CORS and Electron
sandbox protections remain in place.

Older gateway-backed projects and other import formats keep their existing
project-owned resource URLs. No automatic migration rewrites historical Style
hashes or revision evidence. Public resources remain online, mutable and subject
to service availability; preserving a Style revision is not an offline snapshot.

Local, credential-bearing and unsupported-scheme URLs cannot become public
resources. Browser syntax checks do not claim to perform DNS pinning. Requests
that the daemon executes retain DNS, redirect, private-address and size checks.

## Managed transport budgets

| Resource | Bound / policy |
| --- | --- |
| Simultaneous requests | 24 overall; 6 per origin |
| Queued requests | 128 |
| Connection pools | 32; keyed by authority, validated IP, family and connect timeout |
| Idle pool lifetime | 30 seconds |
| Response cache | 32 MiB and 256 entries maximum |
| Cache freshness | Origin must explicitly provide max-age; cap is 60 seconds; Age and Date reduce freshness |
| Non-cacheable responses | no-store/no-cache, Set-Cookie, unsupported Vary, byte ranges and conditional requests |
| HTTP retries | At most 2; respect Retry-After within the original total deadline |

Equal in-flight requests share work, but each subscriber has independent
cancellation. Only the last departing subscriber cancels the underlying request.
Returned data is copied to prevent one caller mutating another caller's result.
An uncached response without an origin freshness directive is fetched again.

## API execution

Settings exposes four budgets: 48 model steps, 192 tool calls, 16,384 map output
tokens, and 32,768 Cartography output tokens by default. See the Quickstart for
configuration and supported application ranges. Model-specific limits and
provider billing still apply.

The model must supply `retryOfToolCallId` when repairing a failed operation.
The adapter verifies tool identity and semantic arguments, permitting updated
revision/idempotency metadata, then removes that adapter-only field before
executing the domain operation. An unrelated successful operation cannot close
the failure. Repeated identical failures stop before exhausting the full budget.

Termination codes distinguish output truncation, step and tool exhaustion,
unresolved calls, repeated failures and incomplete tool calls. Safe diagnostics
record numeric usage/counts, limits and the finish reason; not provider secrets
or input prompts. Continuing an interrupted task is an explicit user action,
starting with an inspection of the saved draft, not replaying all prior edits.

## Durable history and memory

The daemon stores safe receipts, bounded messages and runtime provenance in
`map_design_run_history`. Initial message creation and the idempotency receipt
share a transaction. Production retains no completed run objects in the active
registry; history queries and terminal SSE replay fall back to SQLite. Optional
internal retention limits are capped, and never evict an active run.

Startup recovery identifies interrupted runs, preserves the latest saved
progress, and asks for review instead of automatically executing a model again.
The history table follows project deletion through its foreign key. Existing
project messages and revisions remain unchanged by the migration.

## Testing

The default browser tests use fixed browser resource fixtures. A deterministic
integration test additionally runs a real local gzip HTTP source through the
actual project service, importer, database and reopening path. Test-only pinned
dispatch injection does not alter the production network policy.

Real public-service acceptance is explicit:

```sh
MAP_DESIGN_EXTERNAL_SMOKE=1 pnpm --dir e2e exec playwright test \
  -c playwright.config.ts ui/map-design-home-layout.test.ts --workers=1
```

It covers direct Home loading, real Style import, persisted ready state, real
vector-tile requests, rendered canvas pixels and reopening the same project.
Only the agent is simulated. Public-service availability is not under the
application's control; the deterministic suites remain independent of it.
