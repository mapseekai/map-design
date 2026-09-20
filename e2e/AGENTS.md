# End-to-end tests

`e2e` owns MapDesign browser and cross-process coverage. Keep Playwright tests in `ui/`, focused integration tests in `tests/`, and shared lifecycle code in `lib/`.

Use the provided lifecycle helpers so every worker receives isolated local daemon, web, and data state. Do not hand-spawn application processes from individual tests.

```bash
pnpm --dir e2e test
pnpm --dir e2e test:ui
```