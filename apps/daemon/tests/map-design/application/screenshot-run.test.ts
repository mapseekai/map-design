import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';
import { createMapDesignBlobStore } from '../../../src/map-design/storage/blob-store.js';
import { MapScreenshotService } from '../../../src/map-design/application/screenshot-service.js';
import { createMapDesignRunService } from '../../../src/map-design/application/run-service.js';
import type { MapAgentAdapter, MapRunInput } from '../../../src/map-design/agents/types.js';
import { ToolTokenRegistry } from '../../../src/tool-tokens.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'map-shot-run-'));
  const db = openMapDesignDatabase(root);
  const store = createMapDesignLocalStore(db);
  store.createProject({ project: { projectId: 'p', title: 'Map', runtime: { agentId: 'codex' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Clear', idempotencyKey: 'k' }, primaryConversationId: 'c', verifiedWorkingDirectory: null });
  const screenshots = new MapScreenshotService({ blobStore: createMapDesignBlobStore(root), projectReader: { getProject: async () => ({}), getContext: async () => ({ draftRevision: 2, styleHash: 'a'.repeat(64) }) } });
  const shot = await screenshots.save('p', { pngBase64, width: 1, height: 1, draftRevision: 2, styleHash: 'a'.repeat(64), viewport: { center: [120, 30], zoom: 10, bearing: 0, pitch: 0 } });
  const inputs: MapRunInput[] = [];
  const adapter: MapAgentAdapter = { id: 'codex', capabilities: { nativeMapTools: true, publicReasoningSummary: true },
    startMapRun: async (input) => { inputs.push(input); let finish!: (value: { status: 'canceled' }) => void; return { done: new Promise((resolve) => { finish = resolve; }), cancel: async () => { finish({ status: 'canceled' }); } }; } };
  const service = createMapDesignRunService({ store, screenshots,
    agents: { get: () => ({ id: 'codex', bin: 'codex', buildArgs: () => [], streamFormat: 'json' }), getMapAgent: () => adapter, stageSkill: async () => {} },
    toolTokens: new ToolTokenRegistry(), dataDir: root, projectRoot: root, mcpCliPath: '', daemonUrl: () => 'http://127.0.0.1:54321',
    mapContext: { getContext: async () => ({ draftRevision: 2, styleHash: 'a'.repeat(64) }) },
    nativeToolRegistry: { definitions: () => [], call: async () => { throw new Error('No tool calls'); } },
    runtimeChoices: { requireCurrent: () => ({ agentId: 'codex', revision: 0, updatedAt: '2026-09-08T00:00:00.000Z' }) },
    runtimeCatalog: { resolveChoice: () => ({ agentId: 'codex', model: 'test', modelOrigin: 'catalog', adapter: 'codex-app-server' }) },
  });
  cleanups.push(async () => { await service.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { service, inputs, store, shot };
}
const request = { projectId: 'p', conversationId: 'c', prompt: 'Change these colors', runtimeRevision: 0,
  clientRequestId: 'req', userMessageId: 'u', assistantMessageId: 'a' };

it('delivers actual owned images and view context, and persists screenshot history', async () => {
  const { service, inputs, store, shot } = await fixture();
  await service.start({ ...request, screenshotIds: [shot.id] });
  expect(inputs[0]?.images).toEqual([{ data: pngBase64, mimeType: 'image/png' }]);
  expect(inputs[0]?.prompt).toContain('"zoom":10');
  expect(inputs[0]?.resumePrompt).toContain('"draftRevision":2');
  expect(store.getConversation('c')!.messages[0]).toMatchObject({ content: request.prompt, screenshots: [shot] });
});

it('rejects unknown screenshots before starting a run or persisting user messages', async () => {
  const { service, inputs, store } = await fixture();
  await expect(service.start({ ...request, screenshotIds: ['0'.repeat(64)] })).rejects.toBeInstanceOf(Error);
  expect(inputs).toHaveLength(0);
  expect(store.getConversation('c')!.messages).toHaveLength(0);
});

it('rechecks the project run lock after asynchronous screenshot loading', async () => {
  const { service, inputs, shot } = await fixture();
  const results = await Promise.allSettled([
    service.start({ ...request, screenshotIds: [shot.id] }),
    service.start({ ...request, clientRequestId: 'req2', userMessageId: 'u2', assistantMessageId: 'a2', screenshotIds: [shot.id] }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(inputs).toHaveLength(1);
});
