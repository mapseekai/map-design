# MapDesign documentation

Maintained guides were checked against the local source and configuration on
2026-09-26 (package version 0.1.2, including current working-tree changes).
This is a source audit, not a new claim of cross-platform or live-provider verification.

## Use MapDesign

- [中文使用说明](usage.zh-CN.md): creation, conversations, queues, editing and revisions.
- [Quickstart](../QUICKSTART.md): local startup and CLI examples.
- [API Model](model-api.md) and [saved model profiles](api-model-profiles.md).
- [Screenshots and direct style editing](studio-tools.md).
- [Local data, backups and cleanup](local-data.md).
- [Privacy](../PRIVACY.md).

## Architecture and development

- [Architecture](architecture.md) and [terminology](../CONTEXT.md).
- [Agent adapters](agent-adapters.md) and [skill protocol](skills-protocol.md).
- [CARTOGRAPHY runtime](cartography-runtime.md) and [bundled documents](../design-systems/README.md).
- [Resource and API reliability](resource-runtime-reliability.md).
- [Map tool efficiency](map-tool-efficiency.md): behavior plus historical verification records.
- [UI ownership](ui.md), [visual reference](../DESIGN.md), and [contributing](../CONTRIBUTING.md).
- [Testing guidance](testing/test-efficiency.zh-CN.md).
- [Packaging and releases](../tools/pack/README.md) and [packaged runtime](../apps/packaged/README.md).

## Dated plans and reviews

These retain their original baseline, observations and test results. Read their
status notes before treating a finding or proposal as current work.

- [2026-09-22 AI Elements research plan](ai-elements-upgrade-plan.md).
- [2026-09-26 agent scheduling review](reviews/2026-09-26-agent-scheduling-review.zh-CN.md).
- [2026-09-26 release 0.1.2 validation](reviews/2026-09-26-release-0.1.2.zh-CN.md).

Bundled skill instructions live under `skills/`. License notices, upstream
cartography examples and test fixtures retain their provenance and intentional
version-specific content.
