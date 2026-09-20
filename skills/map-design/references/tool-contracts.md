# MapDesign tool contracts

Every tool accepts one strict JSON object and returns exactly one envelope:

- Success: `{ "ok": true, "data": <tool output>, "meta": { "requestId", "projectId", "runId", "draftRevision"? } }`
- Domain failure: `{ "ok": false, "error": { "code", "message", "retryable", "details"? }, "meta": { "requestId", "projectId", "runId", "draftRevision"? } }`

`projectId`, `runId`, and authorization never belong in tool input. They come only from the run grant. Unknown input fields are invalid. The `json-schema` block in each section is the exact schema advertised by the current runtime; use it as the authority when constructing input. The following `json` blocks are executable examples.

## `map_get_context`

Returns project lifecycle/source availability, pinned design-system identity, draft and committed revisions, style and semantic summaries, validation/preview status, and cartographic guidance.

```json-schema
{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{},"additionalProperties":false}
```

```json
{}
```

## `map_inspect`

`target` is exactly one root, layer, source, or source-layer selector. The result contains the normalized target view and a `truncated` flag.

```json-schema
{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"target":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"root"}},"required":["kind"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"layer"},"layerId":{"type":"string","minLength":1,"maxLength":256}},"required":["kind","layerId"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"source"},"sourceId":{"type":"string","minLength":1,"maxLength":256}},"required":["kind","sourceId"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"source-layer"},"sourceId":{"type":"string","minLength":1,"maxLength":256},"sourceLayer":{"type":"string","minLength":1,"maxLength":256}},"required":["kind","sourceId","sourceLayer"],"additionalProperties":false}]}},"required":["target"],"additionalProperties":false}
```

```json
{"target":{"kind":"root"}}
```

```json
{"target":{"kind":"layer","layerId":"road-label"}}
```

```json
{"target":{"kind":"source","sourceId":"composite"}}
```

```json
{"target":{"kind":"source-layer","sourceId":"composite","sourceLayer":"road"}}
```

## `map_search_layers`

All filters are optional. `query` may contain at most 256 characters; `types` contains unique supported layer types; `limit` is an integer from 1 through 100 and defaults to 25 when omitted by the wrapper input parser. The advertised JSON schema materializes that default as a required `limit`.

```json-schema
{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"query":{"type":"string","maxLength":256},"types":{"maxItems":10,"type":"array","items":{"type":"string","enum":["background","fill","line","symbol","raster","circle","fill-extrusion","heatmap","hillshade","color-relief"]}},"sourceId":{"type":"string","minLength":1,"maxLength":256},"sourceLayer":{"type":"string","minLength":1,"maxLength":256},"limit":{"default":25,"type":"integer","minimum":1,"maximum":100}},"required":["limit"],"additionalProperties":false}
```

```json
{"sourceId":"composite","types":["line","symbol"],"limit":25}
```

Returns matching layers plus `returned` and `truncated` counts.

## `map_apply_transaction`

`expectedRevision` is a non-negative safe integer. `idempotencyKey` is 8–128 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, and `-`. `transaction` contains 1–100 MapLibre SDK operations and `intentSummary` is a trimmed nonempty string of at most 500 characters. Reuse an idempotency key only for the byte-equivalent logical request. Split larger edits into revision-aware batches: use the returned draft revision as `expectedRevision` for the next batch and give each batch a new idempotency key.

Every example is a shape only. Replace `RUN_ID` with the exact current Run and derive each new logical write key from that Run, the expected revision, and the batch number. Never copy an example key literally.

The runtime-advertised schema is the authority for the SDK transaction union. This reference intentionally does not inline that fast-changing union; inspect the `map_apply_transaction` tool definition supplied by the current runtime before constructing an operation.

```json
{"expectedRevision":0,"idempotencyKey":"RUN_ID:r0:batch1","transaction":{"operations":[{"op":"setLayerProperties","layerId":"background","paint":{"background-color":"#111318"}}]},"intentSummary":"Apply the first dark-theme batch"}
```

Returns the new `draftRevision`, `styleHash`, changed layer/source ids, normalized diff, warnings, and validation summary.

## `map_update_semantics`

Updates the version-1 semantic document. Each group requires an id, label, role, at least one layer id, and a source-id array.

```json-schema
{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"expectedRevision":{"type":"integer","minimum":0,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128,"pattern":"^[A-Za-z0-9._:-]+$"},"semantics":{"type":"object","properties":{"version":{"type":"number","const":1},"groups":{"maxItems":256,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128},"label":{"type":"string","minLength":1,"maxLength":128},"role":{"type":"string","minLength":1,"maxLength":128},"layerIds":{"minItems":1,"maxItems":128,"type":"array","items":{"type":"string","minLength":1,"maxLength":256}},"sourceIds":{"maxItems":128,"type":"array","items":{"type":"string","minLength":1,"maxLength":256}}},"required":["id","label","role","layerIds","sourceIds"],"additionalProperties":false}}},"required":["version","groups"],"additionalProperties":false},"intentSummary":{"type":"string","minLength":1,"maxLength":500}},"required":["expectedRevision","idempotencyKey","semantics","intentSummary"],"additionalProperties":false}
```

```json
{"expectedRevision":4,"idempotencyKey":"RUN_ID:r4:semantics1","semantics":{"version":1,"groups":[]},"intentSummary":"Refresh semantic grouping"}
```

Returns the new `draftRevision`, semantic digest/summary, and validation summary.

## `map_validate`

Validates a non-negative safe draft revision. Do not proceed to commit while validation reports blocking findings.

```json-schema
{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"expectedRevision":{"type":"integer","minimum":0,"maximum":9007199254740991}},"required":["expectedRevision"],"additionalProperties":false}
```

```json
{"expectedRevision":4}
```

Returns the validated revision/style hash, validation digest, summary, and bounded findings.

## `map_render_preview`

Renders a revision-bound preview. `viewport` is optional; when provided it contains center, zoom, bearing, pitch, width, height, and pixel ratio within the exact bounds below. Render again after any draft change.

```json-schema
{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"expectedRevision":{"type":"integer","minimum":0,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128,"pattern":"^[A-Za-z0-9._:-]+$"},"viewport":{"type":"object","properties":{"center":{"type":"array","prefixItems":[{"type":"number","minimum":-180,"maximum":180},{"type":"number","minimum":-90,"maximum":90}]},"zoom":{"type":"number","minimum":0,"maximum":24},"bearing":{"type":"number","minimum":-180,"maximum":180},"pitch":{"type":"number","minimum":0,"maximum":85},"width":{"type":"integer","minimum":320,"maximum":2048},"height":{"type":"integer","minimum":240,"maximum":2048},"pixelRatio":{"type":"number","minimum":0.5,"maximum":2}},"required":["center","zoom","bearing","pitch","width","height","pixelRatio"],"additionalProperties":false}},"required":["expectedRevision","idempotencyKey"],"additionalProperties":false}
```

```json
{"expectedRevision":4,"idempotencyKey":"RUN_ID:r4:preview1","viewport":{"center":[121.47,31.23],"zoom":12,"bearing":0,"pitch":30,"width":1280,"height":720,"pixelRatio":1}}
```

Returns preview status/id, draft revision/style hash, optional PNG reference, report reference, and validation summary.

## `map_commit_revision`

Commits only the preview for the current draft revision.

```json-schema
{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"expectedRevision":{"type":"integer","minimum":0,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128,"pattern":"^[A-Za-z0-9._:-]+$"},"previewId":{"type":"string","minLength":1,"maxLength":256},"intentSummary":{"type":"string","minLength":1,"maxLength":500}},"required":["expectedRevision","idempotencyKey","previewId","intentSummary"],"additionalProperties":false}
```

```json
{"expectedRevision":4,"idempotencyKey":"RUN_ID:r4:commit1","previewId":"preview-1","intentSummary":"Commit the validated map"}
```

Returns committed revision, draft revision, style hash, attestation digest, and commit timestamp.

## `map_discard_draft`

Discards the current draft revision and restores committed state.

```json-schema
{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"expectedRevision":{"type":"integer","minimum":0,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128,"pattern":"^[A-Za-z0-9._:-]+$"},"intentSummary":{"type":"string","minLength":1,"maxLength":500}},"required":["expectedRevision","idempotencyKey","intentSummary"],"additionalProperties":false}
```

```json
{"expectedRevision":4,"idempotencyKey":"RUN_ID:r4:discard1","intentSummary":"Discard the experimental changes"}
```

Returns the replacement draft revision, restored committed revision, style/semantic digests, and validation summary.
