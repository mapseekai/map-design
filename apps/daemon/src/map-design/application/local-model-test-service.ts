import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { MapApiConnectionTest } from '@mapseekai/contracts';
import type { MapRunHandle } from '../agents/types.js';
import type { MapDesignLocalAgentRegistry } from './local-agent-registry.js';

export class LocalModelTestError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

/** Exercise the same adapter and locally configured credentials as map runs. */
export class LocalModelTestService {
  private busy = false;
  constructor(private readonly agents: MapDesignLocalAgentRegistry, private readonly dataRoot: string, private readonly timeoutMs = 45_000) {}

  async test(agentId: string, modelId: string, signal: AbortSignal): Promise<MapApiConnectionTest> {
    const agent = this.agents.runtimeCatalog.list().find(item => item.id === agentId && item.id !== 'api');
    if (!agent?.available || !agent.models?.some(model => model.id === modelId)) throw new LocalModelTestError('INVALID_INPUT');
    const adapter = this.agents.getMapAgent?.(agentId);
    if (!adapter) throw new LocalModelTestError('RUNTIME_TEST_UNSUPPORTED');
    if (this.busy) throw new LocalModelTestError('RUNTIME_TEST_BUSY', 429);
    this.busy = true;
    const started = Date.now();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const id = randomUUID();
    let cwd: string | undefined;
    let handle: MapRunHandle | undefined;
    let text = '';
    try {
      const root = join(this.dataRoot, 'runtime-tests');
      await mkdir(root, { recursive: true });
      cwd = await mkdtemp(join(root, 'model-'));
      if (combined.aborted) throw new LocalModelTestError('RUNTIME_TEST_CANCELED');
      handle = await adapter.startMapRun({
        runId: id, projectId: id, conversationId: id, cwd, model: modelId, reasoning: null, serviceTier: null,
        prompt: 'Reply with OK only. This is a model connection test. Do not use tools, read files or change any files.',
        resumePrompt: '', signal: combined,
        toolRuntime: { execute: async call => ({ ok: false, toolUseId: call.toolUseId,
          error: { code: 'UNKNOWN_TOOL', message: 'Tools are unavailable during a connection test.', retryable: false } }), closeRun: () => undefined },
        toolCallback: { url: 'http://127.0.0.1:1/tools-disabled', token: randomUUID(), close: () => undefined },
      }, [], event => { if (event.kind === 'text' && text.length < 1024) text += event.text.slice(0, 1024 - text.length); });
      const terminal = await withAbort(handle.done, combined);
      const passed = !combined.aborted && terminal.status === 'succeeded' && text.trim().length > 0;
      const code = timeout.aborted ? 'RUNTIME_TEST_TIMEOUT' : signal.aborted ? 'RUNTIME_TEST_CANCELED'
        : terminal.error?.code === 'API_AUTH_FAILED' ? 'API_AUTH_FAILED' : 'RUNTIME_TEST_FAILED';
      return { status: passed ? 'passed' : 'failed', testedAt: new Date().toISOString(), latencyMs: Date.now() - started,
        ...(!passed ? { code } : {}) };
    } catch {
      return { status: 'failed', testedAt: new Date().toISOString(), latencyMs: Date.now() - started,
        code: timeout.aborted ? 'RUNTIME_TEST_TIMEOUT' : signal.aborted ? 'RUNTIME_TEST_CANCELED' : 'RUNTIME_TEST_FAILED' };
    } finally {
      try { await handle?.cancel(); } finally {
        try { if (cwd) await rm(cwd, { recursive: true, force: true }); } finally { this.busy = false; }
      }
    }
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new LocalModelTestError('RUNTIME_TEST_CANCELED'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new LocalModelTestError('RUNTIME_TEST_CANCELED'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
