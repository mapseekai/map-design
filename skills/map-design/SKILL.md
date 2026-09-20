---
name: map-design
description: Safely inspect, edit, validate, preview, commit, and discard MapDesign projects through run-scoped tools.
triggers:
  - map design
  - map style
  - cartography
---

# MapDesign

Use only the native run-scoped MapDesign tools in the `map-design` dynamic-tool namespace for every map read or mutation:

- `map_get_context`
- `map_inspect`
- `map_search_layers`
- `map_apply_transaction`
- `map_update_semantics`
- `map_validate`
- `map_render_preview`
- `map_commit_revision`
- `map_discard_draft`

Do not use shell commands, `md tool`, MCP, or direct HTTP requests for map work. These alternate transports are not authorized inside a MapDesign agent run.

Never edit canonical map blobs or files directly. The native tools are the only authority for drafts, semantics, previews, revisions, and project/style writes.

Follow the exact runtime-advertised input schema. [references/tool-contracts.md](references/tool-contracts.md) documents the workflow, but the native tool definition is authoritative. Preserve `expectedRevision` and `idempotencyKey` values across retries, and resolve every failed tool result before continuing.

Each `map_apply_transaction` transaction contains 1–100 SDK operations. Split larger edits into revision-aware batches: use the returned draft revision as `expectedRevision` for the next batch and give each batch a new `idempotencyKey`.

For every new logical write or batch, derive a new public `idempotencyKey` from the exact current Run, expected revision, and batch number. Tool examples are shapes only; never reuse their literal keys.

Use this deterministic edit flow unless the task is read-only:

1. `map_get_context`
2. `map_apply_transaction`
3. `map_validate`
4. `map_render_preview`
5. `map_commit_revision`

Use `map_search_layers` with `limit` and narrow query, type, source, or source-layer filters to discover valid IDs. Use `map_inspect` only with IDs returned by `map_get_context` or `map_search_layers`; never guess or brute-force layer or source IDs.

Use `map_update_semantics` when the semantic document changes. Use `map_discard_draft` only when the requested outcome is to abandon the active draft.
