# CARTOGRAPHY.md runtime integration

## Standard and provenance

MapDesign uses the published `@mapseekai/cartography.md` **0.4.1** parser and
linter. Its document format version is **0.4.0**; these two versions are not
interchangeable. The default document is
`design-systems/quiet-atlas/CARTOGRAPHY.md`, copied without modification from
`mapseekai/cartography.md` commit
`85b9661ea1ee6de16d50cded8ac2d1d29ff5ab50`,
`examples/quiet-atlas/CARTOGRAPHY.md` (Apache-2.0).

The former `quiet-walking` file merely put a private `mapdesign-rules` JSON
block inside Markdown. Renaming that file did not make it conformant. That
preset and its generic private parser have now been removed.

## Three separate responsibilities

1. **Reusable design document.** YAML front matter contains `version`, `name`,
   and root-level `colors`, `typography`, `widths`, `sizes`, `opacities`,
   `spacing`, `dashes`, and `elements`. Nine standard Markdown chapters explain
   identity, boundaries, hierarchy, scale, and states. Tokens retain their
   precise semantics. Unknown extension content stays in the original source.
2. **Task and data context.** Data profiles, actual source layers, attributes,
   fields, category values, and task-specific bindings remain outside the
   document. An element named `park` does not require a park dataset to exist.
3. **Renderer and output review.** MapLibre syntax/resource validation,
   semantic mapping, previews, and application quality policy remain runtime
   concerns. Format lint success is not target validation or visual approval.

`cartographic-quality-validator.ts` retains the application's label-density and
literal-color contrast warnings. Its default policy has no mandatory semantic
roles, at most 80 label layers, and a 4.5 minimum contrast ratio. These are
application defaults, not fields or universal requirements of CARTOGRAPHY.md.
An explicit runtime policy can set other task constraints. The contrast check
is a conservative approximation: patterned, expression-based, or unknown
surfaces are reported as unverifiable rather than declared compliant. A map
with no blocking structural errors still requires rendered visual review.

## One project, one pinned source

Creating a project uses its explicitly selected library document. If none is
selected, it uses the bundled Quiet Atlas default. The bundled default is registered as a read-only-deletion preset in the document
library, so its project reference can also be opened in the editor. Existing
identical user imports retain their original classification. Deletion checks both
explicit library associations and active pinned sources, including default bindings
whose ID is a preset slug rather than the library content ID. Historical snapshots
remain readable without permanently blocking deletion of unused library entries.
The selected source is
validated with the official linter and stored verbatim in
`map_design_cartography_snapshots`, keyed by `(id, digest)`.

The library ID remains SHA-256 of the source, while the existing runtime
`designSystemDigest` contract remains BLAKE3 of the complete UTF-8 source.
Neither digest is derived from a display name. Import jobs, revision
attestations, map context, validation, and AI prompts read the same pinned
source. Editing a library document creates a different content ID and does not
silently change an existing project. Updating a bundled preset preserves old
snapshots. Missing or corrupted pinned bytes fail closed; the loader does not
substitute a newer or unrelated document.

Public fields named `designSystemId` and `designSystemDigest` remain for API
and revision-evidence compatibility. They now identify the standard document,
not a private rules block. `MapDesignRules` and
`parseMapDesignSystemDocument` are no longer exported.

## Input safety and validation

File loading requires an explicit safe design-system ID, verifies real paths
remain within the configured resource root, and accepts only regular files.
Both the file read and decoded source are bounded to 64 KiB before linting.
Invalid UTF-8, BOM, duplicate YAML keys, aliases, invalid references, unsupported
format versions, and other standard errors are rejected. Older format versions
are not automatically reinterpreted as 0.4.0. Markdown code blocks are data,
not executable policy or agent permissions.

The complete pinned source is supplied as untrusted design reference data in
the agent prompt. Native map tools remain the authority for project mutations.
Application policy participates in the validation digest so policy changes
invalidate previous preview evidence even when the finding list stays empty.

## Existing projects and historical evidence

On daemon startup, known unmodified `quiet-walking` project bindings are
migrated in a single SQLite transaction. An already-selected standard library
document wins; otherwise the new bundled default is used. For ready projects,
the draft revision advances, stale previews expire, and the old initial
validation pair is cleared. `map_design_cartography_migrations` records the
old binding, new binding, prior draft revision, and migration time. Repeating
startup does not repeat the migration.

Historical revision rows, content blobs, reports, attestations, and idempotency
receipts are **not rewritten**. An isolated read-only compatibility module
recognizes only the exact former bundled source digest and reproduces its old
validation semantics for historical evidence. It is not a selectable preset
and cannot import arbitrary old documents. Restoring or discarding to an old
revision verifies that evidence but keeps the active standard document,
instead of reactivating the retired preset.

A modified/custom legacy digest is deliberately not guessed: startup reports
that an explicit document migration is required and rolls the transaction
back. Recover the exact historical document and plan its migration; do not
replace a stored digest with an unrelated value or delete project data.

## Validation commands

```bash
nvm use
pnpm --filter @mapseekai/daemon exec cartographymd lint ../../design-systems/quiet-atlas/CARTOGRAPHY.md --strict
pnpm --filter @mapseekai/daemon exec vitest run tests/map-design/validation tests/map-design/storage/cartography-bindings.test.ts tests/map-design/application/revision-service.test.ts
pnpm guard
pnpm typecheck
```

The migration code is exercised with temporary test databases. Installing this
source change does not migrate a running daemon's database until that daemon
is restarted with the new code.
