# Model APIs in MapDesign

MapDesign uses AI SDK 7 in the local daemon. API Model requires no agent CLI. Choose a model that supports tool/function calling for map editing.

## Configure

1. Open Settings and select **API Model** as the runtime.
2. Select `openai` or `anthropic`.
3. For OpenAI, select **Chat Completions** (the compatibility default) or **Responses**.
4. Enter the API key, model ID and optional Base URL. Base URLs are API prefixes, for example `https://api.example.com/v1`; the standard provider URL is used when blank. A full endpoint ending in `/chat/completions`, `/responses`, or `/messages` is also accepted.
5. Save settings. Select API Model when creating a map, or use the runtime switcher for an existing conversation. Existing conversations keep their own runtime selection.

Keys stay in the daemon configuration under `MAP_DESIGN_DATA_DIR`, with owner-only file permissions. Config responses redact keys. Metadata-only updates preserve the saved key. Requests never forward credentials through redirects.

## Analysis and editing

Each run receives the current project context, conversation history, custom instructions and selected CARTOGRAPHY.md. `read_design_reference` exposes only bundled map-design, cartography-md, cartography-init and data-profile skills, the map tool contract reference and the repository DESIGN.md. It cannot read arbitrary local files. DESIGN.md describes application UI; the selected CARTOGRAPHY.md governs map design.

The model can use the existing run-scoped tools to inspect/search layers, apply transactions, update semantics, validate, preview, commit revisions or discard drafts. Calls retain project/run authority, revision checks and idempotency. Tool progress and text stream into the conversation. Unresolved map tool failures prevent a run from being reported as successful.

Runs allow up to 24 model steps and 96 tool calls. Cancellation aborts the model request and stops subsequent tool execution. A limit or failure can leave already-applied draft changes available for inspection; it does not silently discard them.

## CARTOGRAPHY.md creation

The manager's AI creation form offers **API Model** and **Codex CLI**. API Model uses the same saved API configuration and cartography-md skill. Generated documents must pass lint before becoming editable drafts. Saving to the library remains explicit.

## Verification

Protocol fixtures exercise real AI SDK adapters for OpenAI Chat Completions, OpenAI Responses and Anthropic Messages, including streaming for both provider families. A multi-step test reads a skill and edits a real SQLite/blob-backed map draft through the native tool registry. These tests require no paid credentials.
