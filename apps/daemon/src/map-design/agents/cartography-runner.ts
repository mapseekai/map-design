import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { MapDesignRuntimeSelectionInput } from '@mapseekai/contracts';
import type { MapDesignLocalAgentRegistry } from '../application/local-agent-registry.js';
import type { MapAgentEvent } from './types.js';
import { MapDraftError } from '../application/errors.js';

export async function runCartographyAgent(options: {
  agents: Pick<MapDesignLocalAgentRegistry, 'runtimeCatalog' | 'getMapAgent'>;
  dataRoot: string; prompt: string; runtime: MapDesignRuntimeSelectionInput;
  sessionId: string; conversationId: string; runId: string;
  configuredApiModel?: string | undefined; signal: AbortSignal;
  onEvent?: ((event: MapAgentEvent) => void) | undefined;
}): Promise<string> {
  const sessionId = z.string().uuid().parse(options.sessionId);
  const conversationId = z.string().uuid().parse(options.conversationId);
  const resolved = options.agents.runtimeCatalog.resolveChoice(options.runtime.agentId, options.runtime);
  if (resolved.agentId !== options.runtime.agentId) throw new MapDraftError('RUNTIME_CONFLICT', 'The selected Agent is no longer available.');
  const adapter = options.agents.getMapAgent?.(resolved.agentId);
  if (!adapter) throw new MapDraftError('INVALID_INPUT', 'The selected Agent is unavailable.');
  const cwd = join(options.dataRoot, 'cartography-edits', 'agents', sessionId, conversationId);
  await mkdir(cwd, { recursive: true });
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  let output = '';
  let bytes = 0;
  let oversized = false;
  try {
    const handle = await adapter.startMapRun({
      runId: options.runId, projectId: sessionId, conversationId, cwd,
      prompt: options.prompt, resumePrompt: options.prompt, taskKind: 'cartography',
      model: resolved.agentId === 'api' && resolved.model === 'default' ? options.configuredApiModel ?? resolved.model : resolved.model,
      reasoning: resolved.reasoning ?? null, serviceTier: resolved.serviceTier ?? null,
      signal: controller.signal,
      // Document edits return a validated proposal. They receive no map mutation authority.
      toolRuntime: { execute: async (call) => ({ ok: false, toolUseId: call.toolUseId, error: { code: 'RUN_NOT_AUTHORIZED', message: 'Map mutations are unavailable in specification editing.', retryable: false } }), closeRun: () => undefined },
      toolCallback: { url: 'http://127.0.0.1:1/tools-disabled', token: randomUUID(), close: () => undefined },
    }, [], (event) => {
      if (event.kind === 'tool_use') output = '';
      if (event.kind === 'text') {
        bytes += Buffer.byteLength(event.text);
        if (bytes > 512 * 1024) { oversized = true; controller.abort(); return; }
        output += event.text;
      }
      try { options.onEvent?.(event); } catch { /* Activity reporting does not own the result. */ }
    });
    const result = await handle.done;
    if (oversized) throw new MapDraftError('INVALID_INPUT', 'The Agent response is too large.');
    if (controller.signal.aborted) throw new Error('Canceled');
    if (result.status !== 'succeeded') throw new MapDraftError('INVALID_INPUT', result.error?.message ?? 'The selected Agent failed.');
    return output;
  } finally { options.signal.removeEventListener('abort', abort); }
}
