---
name: cartography-md
description: Use when applying a CARTOGRAPHY.md design system to cartographic work across datasets, tasks, or renderers.
---

# cartography.md agent skill

Use this skill when a repository contains `CARTOGRAPHY.md` or when work should follow a reusable cartographic design system.

## Required workflow

1. Locate and read the complete `CARTOGRAPHY.md`, including YAML front matter and every Markdown section.
2. Run `cartographymd lint CARTOGRAPHY.md` and resolve blocking document findings before applying the system.
3. Identify the stable visual identity in all nine standard chapters.
4. Identify explicit requirements and prohibitions.
5. Identify relevant families and representative elements.
6. Resolve root-based Token references to their exact declared values.
7. Combine these with the current task and available data-profile/runtime context.
8. Prefer existing components.
9. If no component fits, adapt a relevant family for the current artifact and record the rationale. A missing valve does not authorize creating a permanent valve-primary element.
10. Apply scale and state guidance: identify the base stage, substitute declared tokens, preserve invariants. Semantic state outranks interaction feedback, which outranks decoration; hover never erases selection, selection never erases critical meaning. Combined state names are opaque: never split, inherit, or merge automatically.
11. Check that the intended semantic meaning and hierarchy survive.
12. Convert according to target capabilities. Size is pre-rotation body long side (circle diameter); casing is per-side thickness. Preserve color alpha, part opacity, and post-composition opacity. Explain signed offsets and spacing conventions rather than guessing.
13. Validate the target artifact and inspect its rendered result with target-appropriate tools.
14. Report substitutions, losses, deviations, and unresolved facts. Do not claim equivalence when the target cannot preserve the effect.

Conflict priority: explicit current user requirements → explicit document requirements/prohibitions → component guidance → chapter principles → Overview → agent judgment. Apply an explicitly requested deviation to the current output and report it; do not automatically rewrite the design system. Permanent additions require an explicit request to change the design system.

Token values remain stable across scales; change their application, never their meaning. No inheritance, interpolation DSL or automatic family/state composition exists. A 0.3.0 document requires semantic migration before applying 0.4.0 conventions.

## Boundaries

`CARTOGRAPHY.md` holds stable visual guidance. Do not alter it to record a one-off task, observed data fields, runtime assumptions, or target-specific details.

Document lint checks only the document's structure and deterministic internal relationships. A passing lint result is not validation of runtime data, a target format, rendered output, or task suitability. Verify those concerns separately in the environment that owns them.

Report Format validation, Design review, Target validation, and Visual review separately. Review identity, hierarchy, component boundaries, scale rationale, state conflicts, missing versus zero, and non-color channels for important meaning. Mark unperformed checks as unperformed.

## Runtime facts

Do not invent unavailable runtime facts. State what is known, what remains unresolved, and what information or target-specific verification would resolve it. Keep these runtime observations separate from the reusable design system.

## MapDesign integration

In this repository, run document lint with `pnpm --filter @mapseekai/daemon exec cartographymd lint /absolute/path/to/CARTOGRAPHY.md`. Use absolute document paths because the command runs in the daemon package directory. The CARTOGRAPHY.md manager creates reviewable drafts; format validation does not imply completed design review or bindings triage.
