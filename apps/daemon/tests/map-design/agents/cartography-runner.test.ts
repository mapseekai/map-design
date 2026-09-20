import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runCartographyAgent } from '../../../src/map-design/agents/cartography-runner.js';
import type { MapAgentAdapter } from '../../../src/map-design/agents/types.js';
import type { MapDesignRuntimeCatalog } from '../../../src/map-design/application/runtime-catalog.js';

it.each(['api', 'codex', 'opencode', 'pi'])('executes %s with the shared model selection and no map mutation tools', async (agentId) => {
  const root = await mkdtemp(join(tmpdir(), 'cartography-runner-'));
  const startMapRun = vi.fn<MapAgentAdapter['startMapRun']>(async (_input, tools, onEvent) => {
    expect(tools).toEqual([]);
    onEvent({ kind: 'text', text: '{"message":"Done",' });
    onEvent({ kind: 'text', text: '"source":"spec"}' });
    return { done: Promise.resolve({ status: 'succeeded' }), cancel: async () => undefined };
  });
  const runtime = { agentId, model: 'provider/model', modelOrigin: 'custom' as const, reasoning: 'high', serviceTier: 'priority' };
  const runtimeCatalog: MapDesignRuntimeCatalog = { refresh: async () => undefined, list: () => [], validate: (input) => input, normalizeSaved: (input) => ({ runtime: input }), resolveChoice: () => ({ ...runtime, adapter: agentId }) };
  const getMapAgent = vi.fn(() => ({ id: agentId, capabilities: { nativeMapTools: true, publicReasoningSummary: true }, startMapRun }));
  const sessionId = randomUUID(); const conversationId = randomUUID();
  try {
    expect(await runCartographyAgent({ agents: { runtimeCatalog, getMapAgent }, dataRoot: root, prompt: 'Edit the specification', runtime, sessionId, conversationId, runId: randomUUID(), signal: new AbortController().signal })).toBe('{"message":"Done","source":"spec"}');
    expect(getMapAgent).toHaveBeenCalledWith(agentId);
    expect(startMapRun.mock.calls[0]?.[0]).toMatchObject({ projectId: sessionId, conversationId, model: runtime.model, reasoning: 'high', serviceTier: 'priority', taskKind: 'cartography', cwd: join(root, 'cartography-edits', 'agents', sessionId, conversationId) });
  } finally { await rm(root, { recursive: true, force: true }); }
});
