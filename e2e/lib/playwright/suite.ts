import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test as base } from '@playwright/test';

import {
  PLAYWRIGHT_TOOLS_DEV_FIXTURE_TIMEOUT_MS,
  warmPlaywrightDaemonRuntime,
  warmPlaywrightWebRuntime,
} from './runtime-lifecycle.ts';
import { createFakeMapAcpRuntime, type FakeMapAcpRuntime } from './fake-map-acp-runtime.ts';
import { resolvePlaywrightSlotNamespace } from './runtime-identity.ts';
import { createToolsDevSuite, e2eWorkspaceRoot } from '../tools-dev/runtime.ts';
import type { ToolsDevSuite } from '../tools-dev/types.ts';

type PlaywrightToolsDevSuite = ToolsDevSuite & {
  fakeMapAcp: FakeMapAcpRuntime;
  markFailed: () => void;
};

type TestFixtures = {
  _toolsDevFailureTracker: void;
};

type WorkerFixtures = {
  toolsDev: PlaywrightToolsDevSuite;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  toolsDev: [
    async ({ browser }, use, workerInfo) => {
      const suite = await createPlaywrightToolsDevSuite(workerInfo.parallelIndex, workerInfo.workerIndex);
      const fakeMapAcp = await createFakeMapAcpRuntime({
        root: join(suite.root, 'scratch', 'fake-map-acp'),
      });
      let failed = false;
      const toolsDev: PlaywrightToolsDevSuite = Object.assign(suite, {
        fakeMapAcp,
        markFailed() {
          failed = true;
        },
      });
      let useError: unknown = null;
      let stopError: unknown = null;
      try {
        await toolsDev.startWeb({
          AMR_HOME: join(toolsDev.root, 'scratch', 'amr-home'),
          MAP_DESIGN_BIN: join(e2eWorkspaceRoot(), 'apps', 'daemon', 'dist', 'cli.js'),
          MAP_DESIGN_NODE_BIN: process.execPath,
          MAP_DESIGN_WEB_DIST_DIR: join(toolsDev.toolsDevRoot, toolsDev.namespace, 'web', 'next'),
          MAP_DESIGN_WEB_TSCONFIG_PATH: join(toolsDev.toolsDevRoot, toolsDev.namespace, 'web', 'tsconfig.json'),
          ...fakeMapAcp.env,
        });
        await warmPlaywrightDaemonRuntime(toolsDev.url.daemon('/api/health'));
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await warmPlaywrightWebRuntime(page, toolsDev.url.web('/'));
        } finally {
          await context.close();
        }
        await use(toolsDev);
      } catch (error) {
        useError = error;
        failed = true;
        throw error;
      } finally {
        try {
          await toolsDev.stopWeb();
        } catch (error) {
          stopError = error;
          failed = true;
        }
        if (!failed) await rm(toolsDev.root, { force: true, recursive: true });
        if (stopError != null && useError == null) throw stopError;
      }
    },
    { scope: 'worker', timeout: PLAYWRIGHT_TOOLS_DEV_FIXTURE_TIMEOUT_MS },
  ],
  baseURL: async ({ toolsDev }, use) => await use(toolsDev.url.web()),
  _toolsDevFailureTracker: [
    async ({ toolsDev }, use, testInfo) => {
      await use(undefined);
      if (testInfo.status === testInfo.expectedStatus) return;
      toolsDev.markFailed();
      await testInfo.attach('tools-dev-runtime', {
        body: JSON.stringify({
          dataDir: toolsDev.dataDir,
          daemonUrl: toolsDev.daemonUrl,
          namespace: toolsDev.namespace,
          root: toolsDev.root,
          webUrl: toolsDev.webUrl,
        }, null, 2),
        contentType: 'application/json',
      });
    },
    { auto: true },
  ],
});

export { expect };
export type { PlaywrightToolsDevSuite };

async function createPlaywrightToolsDevSuite(
  parallelIndex: number,
  workerIndex: number,
): Promise<ToolsDevSuite> {
  const namespace = resolvePlaywrightSlotNamespace(parallelIndex);
  const root = join(e2eWorkspaceRoot(), '.tmp', 'e2e', namespace, `i${workerIndex}-p${process.pid}`);
  const scratchDir = join(root, 'scratch');
  await mkdir(scratchDir, { recursive: true });
  return createToolsDevSuite({
    codexHomeDir: join(scratchDir, 'codex-home'),
    dataDir: join(scratchDir, 'data'),
    namespace,
    ownerPid: process.pid,
    root,
    toolsDevRoot: join(scratchDir, 'tools-dev'),
  });
}
