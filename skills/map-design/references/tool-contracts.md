# MapDesign tool contracts

The runtime-advertised tool schema is authoritative. This reference describes workflow and examples; it deliberately does not repeat schemas already in model context.

Native tools return decision-oriented model content and a separate aggregate UI summary. HTTP/MCP envelopes contain the full typed output. Authorization, projectId and runId come from the trusted Run grant, never from arguments.

## Efficient edit flow

Reuse the canonical context injected at Run start. Discover IDs and required properties in one search, batch the edit, render and review the current preview, then commit. Successful writes include validationSummary; a valid current result can be reused instead of calling map_validate again. Refresh context only if unavailable or stale. Read-only tasks do not create drafts or previews.

Revision and idempotency checks remain mandatory. Derive each new logical write key from the exact Run, expected revision and batch number. Replays reuse the same logical request and key. Examples below are shapes; replace RUN_ID and revision values.

## map_get_context

Input: `{}`. Returns lifecycle, source/design identity, current and committed revisions, style/semantic summaries and validation/preview status. The native model result omits verbose cartographic guidance already supplied by the pinned document.

## map_search_layers

Combine query (substring or up to 20 alternatives), types, sourceId and sourceLayer. limit is 1–200 (default 25). Results stay in style order and are deduplicated.

Request properties while discovering IDs:

```json
{"query":["road","street"],"types":["line"],"limit":100,"properties":{"paint":["line-color","line-width"]}}
```

fields selects complete paint/layout/filter sections; properties selects named paint/layout keys and implies those fields. Without projection, search returns summaries. Follow nextOffset using the same query and projection. Missing requested properties are absent; omittedFields means values could not fit and must be read more narrowly before editing.

## map_inspect

Use discovered IDs, never guessed IDs. Batch 1–200 IDs:

```json
{"target":{"kind":"layers","layerIds":["road-primary","road-secondary"]},"properties":{"paint":["line-color"]}}
```

Single-layer reads default to paint, layout and filter; batches default to paint and layout. fields:[] requests summaries. Missing IDs are reported separately from omitted IDs. Request omitted IDs with fewer fields or a larger budget.

Root/source-layer reads use offset/nextOffset. Root source summaries have sourceOffset/nextSourceOffset. Reuse unchanged results, and re-read only values omitted or compacted out of model history.

Read responses default to 16384 bytes. maxBytes can be 8192–262144. A truncated result always needs its continuation or omission metadata checked; a full 200-layer response is not guaranteed within the default budget.

## map_apply_transaction

1–100 operations after expansion, applied atomically. Carry returned draftRevision into the next write. Group identical properties:

```json
{"expectedRevision":4,"idempotencyKey":"RUN_ID:r4:batch1","transaction":{"operations":[{"op":"setLayersProperties","layerIds":["road-primary","road-secondary"],"paint":{"line-color":"#6688aa"}}]},"intentSummary":"Use one color for the selected roads"}
```

setLayersProperties supports the common paint/layout/metadata/minzoom/maxzoom shape; each target counts as one expanded operation. Unique explicit IDs are required. Standard SDK operations remain available for other edits, including addGeoJsonLayer for source-plus-layer creation.

Native results include revision, style hash, bounded changed IDs, warnings and validationSummary, without echoing the full style diff. Check omission counts. A valid validationSummary allows proceeding directly to preview.

## map_validate

```json
{"expectedRevision":5}
```

Use for explicit checks, stale/missing validation, or diagnosing blockers. Native results include the summary and up to 20 safe findings with severity, code, scope and available property location. omittedFindings includes findings excluded by the model budget. Repair visible blockers and validate again. Validation never substitutes for visual review.

## map_render_preview

```json
{"expectedRevision":5,"idempotencyKey":"RUN_ID:r5:preview1"}
```

Optional viewport uses the runtime schema (center, zoom, bearing, pitch, width, height, pixelRatio). Waits for a revision-bound preview and returns its ID and terminal status. Preview processing validates authoritative current inputs and may reuse an identical validation computation. Re-render after a draft change.

## map_commit_revision

```json
{"expectedRevision":5,"idempotencyKey":"RUN_ID:r5:commit1","previewId":"preview-1","intentSummary":"Save the reviewed map"}
```

Commits only valid current preview evidence. Revision, expiry and integrity checks still run even when pure validation computation is cached.

## map_update_semantics

Replace the version-1 semantic document with expectedRevision, idempotencyKey, semantics and intentSummary. Groups require id, label, role, layerIds and sourceIds. Keep dataset bindings outside CARTOGRAPHY.md. Successful output includes the new revision and validation summary.

## map_discard_draft

Supply expectedRevision, idempotencyKey and intentSummary only when abandoning the draft is the requested outcome. Returns restored revision and validation status.
