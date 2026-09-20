# MapDesign skill protocol

`skills/map-design` is the repository's bundled skill. It contains `SKILL.md` and focused reference material used by MapDesign agent runs.

The daemon discovers the skill, stages it for a selected project run, and tells the selected local agent where to read it. The staged copy keeps the run independent of global agent configuration.

Keep the skill specific to map sources, projects, drafts, preview, validation, revisions, and local agent workflow. Do not add unrelated skill catalogs here.