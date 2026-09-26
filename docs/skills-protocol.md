# MapDesign skill protocol

The bundled skills are `skills/map-design`, `skills/cartography-md`,
`skills/cartography-init`, and `skills/data-profile`. The first defines the
native map-tool workflow; the others cover cartography documents, style
conversion and evidence-based data profiles.

For local agent runs, the daemon stages required skill files in
`.map-design-skills/<folder>/` under the run's working directory. These are
private working copies of bundled sources, so agent writes cannot modify the
original skill. API Model receives bundled reference content through the
daemon's restricted reference reader.

Inside a MapDesign agent run, use the advertised native map tools. The bundled
skill does not authorize shell, `md tool`, MCP or direct HTTP as alternative
transports. External integrations use their separately granted daemon APIs.

Edit source skills under `skills/`, not generated copies. Staged copies can be
removed after related runs stop and will be recreated when needed. See
[local data and cleanup](local-data.md).
