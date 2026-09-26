# MapDesign terminology

- **Map source** — an imported style or geographic input.
- **Project** — the local daemon record that owns a map workflow.
- **Draft** — editable project state before a revision is created.
- **Preview** — rendered view of the current map state.
- **Validation** — checks that report whether a source or draft is usable.
- **Revision** — a saved project state that can be inspected independently.
- **Resource** — a map input or file associated with a project.
- **Run** — one daemon-managed execution using a selected local agent or the built-in API Model.
- **Local agent** — an installed coding-agent CLI detected and started by the daemon.

- **API Model** — model execution inside the daemon using a saved provider profile.
- **Cartography document** — a reusable `CARTOGRAPHY.md` whose source is pinned to a project.

The daemon is the authority for project, draft, revision, validation, and run state.
