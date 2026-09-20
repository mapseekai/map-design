# Local agent adapters

The daemon detects and starts local coding-agent CLIs. Adapters change process detection, arguments, and stream parsing; all runs use the same daemon-owned MapDesign project state.

## Registered adapters

The registry currently includes: `claude`, `codex`, `devin`, `opencode`, `byok-opencode`, `hermes`, `trae-cli`, `grok-build`, `kimi`, `cursor-agent`, `qwen`, `qoder`, `copilot`, `amp`, `pi`, `kiro`, `kilo`, `vibe`, `deepseek`, `aider`, `antigravity`, `reasonix`, `codebuddy`, `mimo`, and `atomcode`. Local profiles may add definitions at runtime.

Definitions live in `apps/daemon/src/runtimes/defs/`; `apps/daemon/src/runtimes/registry.ts` is the source of truth for registration. Each definition declares executable discovery and invocation behavior. The shared runtime layer owns detection, process lifecycle, cancellation, and event parsing.

## BYOK

`byok-opencode` is the registered BYOK adapter. Its provider configuration is local daemon state; keep credentials out of browser code, source control, logs, and diagnostics.

## Local-process boundary

An adapter starts the selected agent as a local user-level process. It has the
filesystem and network access available to that user; MapDesign does not add an
OS sandbox around it. Select and install only agents you trust, and understand
each CLI's own approval model: headless adapters may use that CLI's
non-interactive or auto-approval option so a tool request does not wait for a
TTY approval prompt.

Each run uses the project's selected working directory when one was granted by
the desktop picker, otherwise the MapDesign project root. The daemon supplies
the run environment, including `MAP_DESIGN_DATA_DIR`,
`MAP_DESIGN_DAEMON_URL`, `MAP_DESIGN_TOOL_TOKEN`,
`MAP_DESIGN_PROJECT_ID`, and `MAP_DESIGN_RUN_ID`. The tool token is a
run-scoped, project-scoped capability for the permitted MapDesign tool routes;
it is not a general filesystem or network sandbox.

## Changing an adapter

Edit its definition, keep it registered, reuse the shared parser when possible, and add focused tests for detection, arguments, or event parsing. A selected adapter receives the run-scoped `skills/map-design` instructions.