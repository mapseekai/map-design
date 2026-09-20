# MapDesign engineering guide

MapDesign is a local-first map workspace. Read the nearest directory `AGENTS.md` before changing an app, package, tool, or test.

## Architecture and boundaries

- `apps/web` and `apps/desktop` are clients of the local daemon; shared request and response shapes belong in `packages/contracts`.
- `apps/daemon` owns API routes, SQLite state, map projects, agent execution, MCP, and the `md` CLI.
- `packages/map-design-contracts` owns map-domain types. Keep `packages/contracts` pure TypeScript.
- `skills/map-design`, `skills/cartography-init`, `skills/cartography-md`, and `skills/data-profile` are bundled skills.
- Use `MAP_DESIGN_DATA_DIR` as the daemon data-root configuration. Daemon-owned state, logs, credentials, and agent state derive from it; never commit it.

## Commands

Node 24 and pnpm 10.33 are required. Before running project commands, verify `node --version` reports `v24.x`. With nvm, run `nvm use` from the repository root; in a non-interactive shell, load `$NVM_DIR/nvm.sh` (or `$HOME/.nvm/nvm.sh`) first. Do not run checks under another Node major or rebuild native dependencies for an unsupported runtime.

```bash
pnpm install
pnpm tools-dev start
pnpm tools-dev status
md status
pnpm guard
pnpm typecheck
```

`tools-dev` manages local daemon, web, and desktop processes. `tools-pack` builds and controls local installers for `mac`, `win`, and `linux`. Use focused package commands instead of root build or test aliases.

## Security and UI

Keep credentials server-side and local. Validate source paths and untrusted map content at the daemon boundary. Never expose local files, secrets, or daemon-only APIs to browser code.

Reuse web primitives, preserve accessibility, and update every locale for user-visible strings. Put app and tool tests in their `tests/` directories; Playwright coverage belongs in `e2e`.

## Code intelligence

Use CodeGraph when this checkout is indexed to inspect symbols and call paths before code changes. Do not rely on an unavailable index; use focused source reads instead.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **map-design** (13871 symbols, 36691 relationships, 902 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact analysis before editing.** Use `impact({target: "symbolName", direction: "upstream"})` (MCP) or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .` (CLI fallback); report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/map-design/context` | Codebase overview, check index freshness |
| `gitnexus://repo/map-design/clusters` | All functional areas |
| `gitnexus://repo/map-design/processes` | All execution flows |
| `gitnexus://repo/map-design/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |
| Work in the Application area (530 symbols) | `.claude/skills/gitnexus-area-application/SKILL.md` |
| Work in the Win area (221 symbols) | `.claude/skills/gitnexus-area-win/SKILL.md` |
| Work in the Scripts area (147 symbols) | `.claude/skills/gitnexus-area-scripts/SKILL.md` |
| Work in the Routes area (143 symbols) | `.claude/skills/gitnexus-area-routes/SKILL.md` |
| Work in the Runtimes area (140 symbols) | `.claude/skills/gitnexus-area-runtimes/SKILL.md` |
| Work in the Map-design area (115 symbols) | `.claude/skills/gitnexus-area-map-design/SKILL.md` |
| Work in the Acp area (114 symbols) | `.claude/skills/gitnexus-area-acp/SKILL.md` |
| Work in the Components area (106 symbols) | `.claude/skills/gitnexus-area-components/SKILL.md` |
| Work in the Mac area (95 symbols) | `.claude/skills/gitnexus-area-mac/SKILL.md` |
| Work in the Ingestion area (94 symbols) | `.claude/skills/gitnexus-area-ingestion/SKILL.md` |
| Work in the Sidecar area (87 symbols) | `.claude/skills/gitnexus-area-sidecar/SKILL.md` |
| Work in the Chat area (82 symbols) | `.claude/skills/gitnexus-area-chat/SKILL.md` |
| Work in the Resources area (74 symbols) | `.claude/skills/gitnexus-area-resources/SKILL.md` |
| Work in the Hooks area (64 symbols) | `.claude/skills/gitnexus-area-hooks/SKILL.md` |
| Work in the Runtime area (59 symbols) | `.claude/skills/gitnexus-area-runtime/SKILL.md` |
| Work in the Storage area (52 symbols) | `.claude/skills/gitnexus-area-storage/SKILL.md` |
| Work in the Tests area (46 symbols) | `.claude/skills/gitnexus-area-tests/SKILL.md` |
| Work in the Playwright area (41 symbols) | `.claude/skills/gitnexus-area-playwright/SKILL.md` |
| Work in the Preview area (34 symbols) | `.claude/skills/gitnexus-area-preview/SKILL.md` |
| Work in the Defs area (28 symbols) | `.claude/skills/gitnexus-area-defs/SKILL.md` |

<!-- gitnexus:end -->
