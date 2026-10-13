# Bundled cartographic design systems

`monet/CARTOGRAPHY.md` is the default bundled preset, based on the saved
“莫奈风格” document. It preserves its warm canvas, blue-green water, muted
vegetation, ochre roads, and label hierarchy in CARTOGRAPHY.md format 0.4.0.
Existing user documents and pinned project revisions remain unchanged.

`quiet-atlas/CARTOGRAPHY.md` is the unmodified upstream Quiet Atlas example, using
format 0.4.0 and validated with `@mapseekai/cartography.md` 0.4.1.

Source: `mapseekai/cartography.md`, commit
`85b9661ea1ee6de16d50cded8ac2d1d29ff5ab50`,
`examples/quiet-atlas/CARTOGRAPHY.md` (Apache-2.0).

These documents define reusable visual identity only. Project data, layer and
field bindings, renderer output, and runtime quality policy stay outside them.
Documents are pinned by their complete content digest when a project is created.
See [cartography runtime](../docs/cartography-runtime.md) for binding and migration behavior.
