# Studio screenshots and direct style editing

The camera button above the map adds a PNG of the current rendered viewport to the selected conversation. Add a message, remove unwanted thumbnails, then send. Up to four screenshots can accompany a message. Capture records the map revision, style hash and viewport, while the PNG stays in project-owned local storage. Accepted messages keep their screenshots after reload; rejected sends keep them in the composer.

The pencil button enters direct style editing. Click a rendered feature (or focus the map and press Enter); choose a candidate if several overlap. Set the scope to the feature, features matching one of its properties, or the entire style layer. Color, opacity, line width, circle radius and text size controls depend on the layer type. Expression-backed fields display a dash until edited; changing one control preserves the others. Color swatches preserve an existing alpha component.

Changes preview immediately. Cancel restores the previous values; Save validates and persists a draft transaction. Comments and direct style picking are mutually exclusive. Historical views and maps with an active AI run cannot be edited directly. Concurrent revision changes invalidate the old selection, and retries cannot apply the same edit twice. Existing invalid map semantics must be corrected before saving; validation is not bypassed.

Screenshots are passed as image content through Codex, Pi, Oh My Pi, OpenCode and API model adapters. The selected model must support image input. DeepSeek Harness currently has a text-only protocol and reports this limitation. Oh My Pi retains its advertised RPC v1 frame limit and reports when attached screenshots exceed it; use fewer/smaller images or another agent in that case.

Validation lives in the focused screenshot/style tests under each package's `tests/` directory and `e2e/ui/map-design-capture-style.test.ts`. The browser test uses an isolated project and a simulated agent to exercise capture, submission, history reload, cancel/save and narrow-screen controls without invoking a paid model.
