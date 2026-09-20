import { defineConfig, devices } from '@playwright/test';

import { initializePlaywrightRunNamespace } from './lib/playwright/runtime-identity.ts';

initializePlaywrightRunNamespace();

function parseWorkerCount(value: string | undefined): number {
  if (value == null || value.length === 0) return 2;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`MAP_DESIGN_PLAYWRIGHT_WORKERS must be a positive integer, got: ${value}`);
  }
  return parsed;
}

export default defineConfig({
  testDir: './ui',
  outputDir: './ui/reports/test-results',
  timeout: Number(process.env.MAP_DESIGN_PLAYWRIGHT_TIMEOUT) || 45_000,
  retries: process.env.CI ? 1 : 0,
  expect: { timeout: 10_000 },
  fullyParallel: process.env.MAP_DESIGN_PLAYWRIGHT_FULLY_PARALLEL === '1',
  workers: parseWorkerCount(process.env.MAP_DESIGN_PLAYWRIGHT_WORKERS),
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './ui/reports/playwright-html-report' }],
    ['json', { outputFile: './ui/reports/results.json' }],
    ['junit', { outputFile: './ui/reports/junit.xml' }],
  ],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
