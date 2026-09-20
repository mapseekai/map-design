# Contributing to MapDesign

Keep changes focused on map projects, source inspection, drafts, preview, validation, revisions, local agent runs, and the web or desktop clients that expose them.

## Development

Use Node.js 24 and the pnpm version in `package.json` for both dependency installation and validation. When using nvm, select the checked-in `.nvmrc` before running project commands:

```bash
nvm use
node --version # Must report v24.x
```

For non-interactive shells, load `$NVM_DIR/nvm.sh` (or `$HOME/.nvm/nvm.sh`) before `nvm use`. Native dependencies such as `better-sqlite3` must match the selected Node ABI. A `NODE_MODULE_VERSION` mismatch in SQLite or `.stylx` tests can indicate that the shell is running a different Node major; select Node 24 first rather than rebuilding dependencies for an unsupported runtime.

```bash
corepack enable
pnpm install
pnpm tools-dev start
```

Use package-scoped build and test commands. `pnpm tools-dev` owns local application lifecycle; `pnpm tools-pack` owns installer build and lifecycle commands.

## Boundaries

- Keep web and daemon communication behind shared contracts and daemon APIs.
- Keep daemon-owned data under `MAP_DESIGN_DATA_DIR`; never commit local data, credentials, logs, or generated runtime state.
- Keep agent adapters local and provider-specific; do not embed provider credentials in source or browser code.
- Add user-visible strings to every supported web locale.

## Before review

```bash
pnpm guard
pnpm typecheck
```

Also run focused tests and any relevant local runtime or installer smoke command.