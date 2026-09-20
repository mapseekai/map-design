import { defineConfig, devices } from '@playwright/test';

import { initializePlaywrightRunNamespace } from './lib/playwright/runtime-identity.ts';

initializePlaywrightRunNamespace();

export default defineConfig({
  testDir: './ui',
  testMatch: 'map-design-home-layout.test.ts',
  outputDir: './ui/reports/visual-test-results',
  timeout: Number(process.env.MAP_DESIGN_PLAYWRIGHT_TIMEOUT) || 90_000,
  retries: 0,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['json', { outputFile: './ui/reports/visual-results.json' }]],
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  },
});
