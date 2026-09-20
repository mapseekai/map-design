# Packages

Use packages for shared contracts and runtime primitives, not application workflow.

- `contracts` contains shared web/daemon API shapes and remains pure TypeScript.
- `map-design-contracts` contains map-domain types.
- `components` contains reusable UI primitives.
- `sidecar`, `sidecar-proto`, and `platform` own local-process protocols and primitives.

Do not import app-private source into another app. Keep package tests in a sibling `tests/` directory and run the relevant package command after a change.