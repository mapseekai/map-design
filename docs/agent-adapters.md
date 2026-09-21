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
## Built-in API Model

The `api` adapter uses the AI SDK inside the daemon; it is not a subprocess.
It supports the configured compatible Chat Completions, OpenAI Responses or
Anthropic Messages protocol. Provider options are built for that protocol's
namespace and wire fields; serial model-tool settings do not rely solely on
serializing tool execution after generation.

`apiExecution` configures `maxSteps` (default 48, range 1–128), `maxToolCalls`
(default 192, range 1–512), `maxOutputTokens` (default 16,384) and
`cartographyMaxOutputTokens` (default 32,768). Token settings accept 256–131,072;
this application bound is not a claim about a particular model's supported
maximum. Both API-based map editing and Cartography generation consume these
settings. Provider-specific restrictions still apply.

Tool failures are keyed by tool-call ID. An explicit `retryOfToolCallId` may
resolve a failed call only when the tool and semantic operation match; fresh
revision and idempotency metadata are allowed. This adapter-only field is
removed before invoking the domain tool. Three repeated failures of the same
operation stop the loop. A successful unrelated operation never clears an
older failure.

Errors distinguish `API_OUTPUT_LIMIT`, `API_STEP_LIMIT`, `API_TOOL_LIMIT`,
`API_TOOL_LOOP`, `API_TOOL_FAILED` and `API_TOOL_CALL_INCOMPLETE`. Safe run
telemetry records counts, final reason and token usage, not prompts or secrets.
The current draft is not automatically rolled back or silently re-executed when
a run stops. Continue explicitly after inspecting the persisted map state.

## Named API model profiles

API Model supports multiple saved provider/model configurations, explicit connection
testing, default selection and per-conversation switching. Credentials remain
server-side and a running task retains its admission-time selection. See
[Saved API model configurations](api-model-profiles.md).
