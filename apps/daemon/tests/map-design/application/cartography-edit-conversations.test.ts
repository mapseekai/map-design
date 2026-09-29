import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { CartographyEditService } from '../../../src/map-design/application/cartography-edit-service.js';
import { MapDesignConversationService } from '../../../src/map-design/application/conversation-service.js';
import { MapDesignConversationRuntimeService } from '../../../src/map-design/application/conversation-runtime-service.js';
import type { MapDesignRuntimeCatalog } from '../../../src/map-design/application/runtime-catalog.js';
import type { generateCartographyEdit } from '../../../src/map-design/application/cartography-authoring.js';
import { closeMapDesignDatabase, openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';
import { MapDraftError } from '../../../src/map-design/application/errors.js';

const source = '---\nversion: "0.4.0"\nname: Atlas\n---\n\n## Overview\nOriginal guidance.\n';
const catalog: MapDesignRuntimeCatalog = {
  validate: (runtime) => runtime, normalizeSaved: (runtime) => ({ runtime }),
  refresh: async () => undefined, list: () => [],
  resolveChoice: (agentId, input) => ({ agentId, model: input.model ?? 'default', modelOrigin: input.modelOrigin ?? 'catalog', adapter: agentId,
    ...(input.reasoning ? { reasoning: input.reasoning } : {}), ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}) }),
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'spec-conversations-'));
  const db = openMapDesignDatabase(root);
  const store = createMapDesignLocalStore(db);
  const generate = vi.fn<typeof generateCartographyEdit>();
  const saveDocument = vi.fn(() => ({ id: 'a'.repeat(64), name: 'Atlas', description: '', version: '0.4.0' }));
  const deps = { dataRoot: root, projectRoot: '/unused', generate, saveDocument, store, agents: { runtimeCatalog: catalog, getMapAgent: () => null } };
  const edits = new CartographyEditService(deps);
  const conversations = new MapDesignConversationService({
    getActiveConversationRun: () => null, store, randomId: randomUUID, now: () => new Date().toISOString(), isConversationRunning: (id) => edits.isConversationRunning(id) });
  const runtimes = new MapDesignConversationRuntimeService({ store, now: () => new Date().toISOString(), policy: catalog, isProjectRunning: (id) => edits.isProjectRunning(id) });
  cleanups.push(async () => { await edits.shutdown(); closeMapDesignDatabase(db); await rm(root, { recursive: true, force: true }); });
  return { db, store, deps, edits, conversations, runtimes, generate };
}
it.each([
  [new MapDraftError('INVALID_INPUT', 'The model output was truncated (configured limit: 8192 tokens).'), 'The model output was truncated (configured limit: 8192 tokens).'],
  [new Error('Internal private diagnostics'), 'The specification edit failed.'],
  [new MapDraftError('INVALID_INPUT', 'Authorization: Bearer secret-api-token'), 'The specification edit failed.'],
])('preserves safe edit failure details and the original draft', async (failure, expected) => {
  const { edits, conversations, generate } = await setup();
  generate.mockRejectedValue(failure);
  const session = await edits.create({ source, runtime: 'api', description: '', initialPrompt: 'Improve' });
  await edits.turn(session.id, { requestId: randomUUID(), expectedRevision: 0, conversationId: session.id, runtimeRevision: 0, prompt: 'Improve' });
  await vi.waitFor(async () => expect((await edits.get(session.id)).status).toBe('failed'));
  expect(await edits.get(session.id)).toMatchObject({ source, revision: 0 });
  expect(conversations.get(session.id, session.id).messages.at(-1)).toMatchObject({ content: expected, runStatus: 'failed' });
});
it('starts a new specification conversation before generation completes and preserves the selected model', async () => {
  // Given a selected custom model and a generation that has not completed.
  const { edits, conversations, store, generate } = await setup();
  const runtime = { agentId: 'pi', model: 'provider/custom', modelOrigin: 'custom', reasoning: 'high', serviceTier: 'fast' } as const;
  const reply: { resolve?: (value: { source: string; message: string }) => void } = {};
  generate.mockReturnValue(new Promise((resolve) => { reply.resolve = resolve; }));
  try {
    // When the author starts AI creation from a brief.
    const session = await edits.create({ name: 'Atlas', requirements: 'Design a transit map', description: 'Transit', runtime });
    // Then the running conversation is immediately usable with the chosen runtime.
    expect(session).toMatchObject({ name: 'Atlas', description: 'Transit', status: 'running', revision: 0, initialAnalysisStarted: true, activeConversationId: session.id });
    expect(store.getConversationRuntime(session.id)).toMatchObject(runtime);
    expect(generate.mock.calls[0]?.[0]).toMatchObject({ runtime, conversationId: session.id, history: [] });
    expect(conversations.get(session.id, session.id).messages.map(({ role, runStatus }) => ({ role, runStatus }))).toEqual([
      { role: 'user', runStatus: 'succeeded' }, { role: 'assistant', runStatus: 'running' },
    ]);
    reply.resolve?.({ source, message: 'Created the specification.' });
    await vi.waitFor(async () => expect((await edits.get(session.id)).revision).toBe(1));
    expect(conversations.get(session.id, session.id).messages.at(-1)?.runStatus).toBe('succeeded');
  } finally {
    reply.resolve?.({ source, message: 'Created the specification.' });
  }
});
it('migrates file history once and does not recreate a deliberately deleted conversation', async () => {
  const { deps, edits, conversations, generate, db } = await setup();
  const legacy = new CartographyEditService({ dataRoot: deps.dataRoot, projectRoot: deps.projectRoot, generate, saveDocument: deps.saveDocument });
  const session = await legacy.create({ source, initialPrompt: 'Improve' });
  generate.mockResolvedValue({ source, message: 'Reviewed the specification.' });
  await legacy.turn(session.id, { requestId: randomUUID(), expectedRevision: 0, prompt: 'Review' });
  await vi.waitFor(async () => expect((await legacy.get(session.id)).status).toBe('idle'));
  expect(await edits.get(session.id)).toMatchObject({ initialAnalysisStarted: true, revision: 1, source });
  expect(conversations.get(session.id, session.id).messages.map((m) => m.content)).toEqual(['Review', 'Reviewed the specification.']);
  expect(db.prepare('SELECT count(*) AS n FROM map_design_projects').get()).toEqual({ n: 0 });
  conversations.delete(session.id, session.id);
  await new CartographyEditService(deps).get(session.id);
  expect(conversations.list(session.id).conversations).toEqual([]);
  expect(generate).toHaveBeenCalledTimes(1);
});
it('shares runtime choices and conversation operations while isolating histories and protecting active edits', async () => {
  const { edits, conversations, runtimes, generate } = await setup();
  const session = await edits.create({ source, initialPrompt: 'Improve' });
  const second = conversations.create(session.id, { idempotencyKey: randomUUID() }).conversation.conversationId;
  const choice = runtimes.update(session.id, second, { expectedRevision: 0, clientRequestId: randomUUID(), runtime: { agentId: 'pi', model: 'provider/custom', modelOrigin: 'custom', reasoning: 'high' } }).runtime;
  let finish!: (reply: { source: string; message: string }) => void;
  generate.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const request = { requestId: randomUUID(), expectedRevision: 0, conversationId: second, runtimeRevision: choice.revision, prompt: 'Update labels' };
  await expect(edits.turn(session.id, { ...request, runtimeRevision: 0 })).rejects.toMatchObject({ code: 'RUNTIME_CONFLICT' });
  await edits.turn(session.id, request);
  expect(generate.mock.calls[0]?.[0]).toMatchObject({ conversationId: second, runtime: { agentId: 'pi', model: 'provider/custom', modelOrigin: 'custom', reasoning: 'high' }, history: [] });
  expect(() => conversations.delete(session.id, second)).toThrow(expect.objectContaining({ code: 'RUNTIME_CONFLICT' }));
  expect(() => runtimes.update(session.id, second, { expectedRevision: choice.revision, clientRequestId: randomUUID(), runtime: { agentId: 'codex' } })).toThrow(expect.objectContaining({ code: 'RUNTIME_CONFLICT' }));
  finish({ source: source + '\n## Labels\nReadable.', message: 'Updated labels.' });
  await vi.waitFor(async () => expect((await edits.get(session.id)).revision).toBe(1));
  expect(conversations.get(session.id, second).messages.map((m) => m.content)).toEqual(['Update labels', 'Updated labels.']);
  expect(conversations.get(session.id, session.id).messages).toEqual([]);
  conversations.delete(session.id, second);
  expect((await edits.get(session.id)).source).toContain('Readable.');
});
it('rejects invalid sample bindings without replacing the source and records the failed turn', async () => {
  const { edits, conversations, generate } = await setup();
  const session = await edits.create({ source, initialPrompt: 'Improve' });
  generate.mockResolvedValue({ source: source + '\n## Labels\nChanged.', message: 'Done', sampleBindings: { 'road.primary': 'missing-element' } });
  await edits.turn(session.id, { requestId: randomUUID(), expectedRevision: 0, conversationId: session.id, runtimeRevision: 0, prompt: 'Update sample' });
  await vi.waitFor(async () => expect((await edits.get(session.id)).status).toBe('failed'));
  expect((await edits.get(session.id)).source).toBe(source);
  expect(conversations.get(session.id, session.id).messages.at(-1)?.runStatus).toBe('failed');
});
