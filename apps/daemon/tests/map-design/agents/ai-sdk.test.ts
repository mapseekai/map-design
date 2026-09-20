import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { sha256CanonicalJson } from 'maplibre-style-tools/bridge';
import { createApiMapAgentAdapter } from '../../../src/map-design/agents/ai-sdk.js';
import { createSdkMapToolRuntime } from '../../../src/map-design/agents/sdk-tool-runtime.js';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignProjectServices } from '../../../src/server-context.js';
import type { MapAgentEvent, MapRunInput } from '../../../src/map-design/agents/types.js';
import { readDesignReference } from '../../../src/map-design/agents/design-references.js';

const repo = resolve(import.meta.dirname, '../../../../..');
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const toolStep = (name: string, args: unknown, id: string) => ({ stream: simulateReadableStream({ chunks: [
  { type: 'stream-start' as const, warnings: [] },
  { type: 'tool-call' as const, toolCallId: id, toolName: name, input: JSON.stringify(args) },
  { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage },
] }) });
const finalStep = () => ({ stream: simulateReadableStream({ chunks: [
  { type: 'stream-start' as const, warnings: [] },
  { type: 'text-start' as const, id: 'message' },
  { type: 'text-delta' as const, id: 'message', delta: 'The map background is updated.' },
  { type: 'text-end' as const, id: 'message' },
  { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage },
] }) });

describe('API map agent', () => {
  it('sends screenshots as AI SDK user image content', async () => {
    const model = new MockLanguageModelV4({ doStream: finalStep() });
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model });
    const handle = await adapter.startMapRun({
      runId: 'image-run', projectId: 'map', conversationId: 'conversation',
      prompt: 'Style this screenshot.', resumePrompt: 'Style this screenshot.', cwd: repo,
      model: 'test', reasoning: null, serviceTier: null,
      images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
      signal: new AbortController().signal,
      toolRuntime: createSdkMapToolRuntime({ definitions: () => [], call: async () => { throw new Error('Unexpected map call'); } }),
      toolCallback: {} as MapRunInput['toolCallback'],
    }, [], () => undefined);

    await expect(handle.done).resolves.toEqual({ status: 'succeeded' });
    expect(model.doStreamCalls[0]?.prompt.at(-1)).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'Style this screenshot.' },
        {
          type: 'file',
          data: { type: 'data', data: 'iVBORw0KGgo=' },
          mediaType: 'image/png',
        },
      ],
    });
  });

  it('reads design guidance and changes a real stored draft through the AI SDK tool loop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'api-map-tools-'));
    const db = openMapDesignDatabase(root);
    const services = createMapDesignProjectServices({ db, dataRoot: root, projectRoot: repo,
      runStore: { get: (runId) => runId === 'api-run' ? { runId, projectId: 'api-map', runtime: { id: 'api', version: '7', adapter: 'ai-sdk' }, model: { id: 'test', provider: 'openai' } } : null },
      designSystem: { id: 'api-test', digest: 'd'.repeat(64), humanGuidance: '', rules: { version: 1, requiredSemanticRoles: [], maxLabelLayerCount: 10, minimumContrastRatio: 1 } },
    });
    try {
      const projectId = 'api-map';
      const style = { version: 8 as const, sources: {}, layers: [{ id: 'background', type: 'background' as const, paint: { 'background-color': '#ffffff' } }] };
      const [styleBlob, semantics, manifest] = await Promise.all([
        services.blobStore.putJson(projectId, 'styles', style),
        services.blobStore.putJson(projectId, 'semantics', { version: 1, groups: [] }),
        services.blobStore.putJson(projectId, 'sources', { kind: 'style', digest: 'a'.repeat(64), mediaType: 'application/json', byteLength: 1, resourceCount: 1, capturedAt: '2026-09-07T00:00:00Z' }),
      ]);
      db.prepare('INSERT INTO projects (id,title,runtime_json,created_at,updated_at) VALUES (?,?,?,?,?)').run(projectId, 'API test', '{}', '2026-09-07', '2026-09-07');
      db.prepare(`INSERT INTO map_design_projects (project_id,lifecycle_state,source_kind,source_manifest_digest,design_system_id,design_system_digest,draft_revision,draft_style_digest,draft_style_hash,draft_semantic_digest,created_at,updated_at) VALUES (?,'ready','style',?,'api-test',?,0,?,?,?,'2026-09-07','2026-09-07')`).run(projectId,manifest.digest,'d'.repeat(64),styleBlob.digest,await sha256CanonicalJson(style),semantics.digest);
      const model = new MockLanguageModelV4({ doStream: [
        toolStep('read_design_reference', { name: 'cartography-md' }, 'reference-1'),
        toolStep('map_get_context', {}, 'context-1'),
        toolStep('map_apply_transaction', { expectedRevision: 0, idempotencyKey: 'api-run-0-1', transaction: { operations: [{ op: 'setLayerProperties', layerId: 'background', paint: { 'background-color': '#cc785c' } }] }, intentSummary: 'Use a warm coral background' }, 'edit-1'),
        toolStep('map_validate', { expectedRevision: 1 }, 'validate-1'),
        finalStep(),
      ] });
      const events: MapAgentEvent[] = [];
      const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model });
      const handle = await adapter.startMapRun({ runId: 'api-run', projectId, conversationId: 'conversation-api', prompt: 'Read CARTOGRAPHY guidance and make the background coral.', resumePrompt: '', cwd: root, model: 'test', reasoning: null, serviceTier: null, signal: new AbortController().signal, toolRuntime: createSdkMapToolRuntime(services.nativeToolRegistry), toolCallback: {} as MapRunInput['toolCallback'] }, [...services.nativeToolRegistry.definitions()], (event) => events.push(event));
      const terminal = await handle.done;
      expect(terminal, JSON.stringify(events)).toEqual({ status: 'succeeded' });
      expect(events.filter((e) => e.kind === 'tool_result')).toContainEqual(expect.objectContaining({ toolUseId: 'edit-1', status: 'succeeded' }));
      const updated = await services.queryService.getStyle(projectId);
      expect(updated.layers[0]?.paint).toEqual({ 'background-color': '#cc785c' });
      expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', toolUseId: 'edit-1', status: 'succeeded' }));
      expect(events).toContainEqual({ kind: 'text', text: 'The map background is updated.' });
      expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('cartography.md agent skill');
    } finally { services.previewService.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('limits design reference access to the allowlist', async () => {
    expect(await readDesignReference(repo, 'ui-design')).toContain('colors:');
    await expect(readDesignReference(repo, '../.env')).rejects.toThrow('Unknown design reference');
  });
});

it('aborts an in-flight SDK stream and never starts map work after cancellation', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const model = new MockLanguageModelV4({ doStream: async ({ abortSignal }) => {
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      abortSignal?.addEventListener('abort', () => controller.close(), { once: true });
    } });
    started();
    return { stream };
  } });
  const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model });
  const handle = await adapter.startMapRun({ runId: 'canceled-run', projectId: 'map', conversationId: 'conversation', prompt: 'Analyze', resumePrompt: '', cwd: repo, model: 'test', reasoning: null, serviceTier: null, signal: new AbortController().signal,
    toolRuntime: createSdkMapToolRuntime({ definitions: () => [], call: async () => { throw new Error('Unexpected map call'); } }), toolCallback: {} as MapRunInput['toolCallback'],
  }, [], () => {});
  await ready;
  await handle.cancel();
  expect(await handle.done).toEqual({ status: 'canceled' });
});
