import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Keep this above the shared Testing Library asyncUtilTimeout so failed
    // waits retain Testing Library's assertion/DOM diagnostics.
    testTimeout: 5_000,
    setupFiles: ['./tests/setup/jsdom-lexical.ts'],
  },
});
