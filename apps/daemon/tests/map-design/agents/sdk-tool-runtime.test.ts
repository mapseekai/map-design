import type { SafeToolSummary } from '@mapseekai/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  createSdkMapToolRuntime,
  type SdkMapToolCall,
} from '../../../src/map-design/agents/sdk-tool-runtime.js';
import type {
  MapDesignNativeToolRegistry,
  MapNativeToolResult,
} from '../../../src/map-design/tools/tool-context.js';

const success = (toolUseId: string, modelContent = '{"valid":true}'): MapNativeToolResult => ({
  ok: true,
  toolUseId,
  summary: { valid: true } satisfies SafeToolSummary,
  modelContent,
});

function call(overrides: Partial<SdkMapToolCall> = {}): SdkMapToolCall {
  return {
    runId: 'run-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    agentId: 'opencode',
    toolUseId: 'tool-1',
    name: 'map_validate',
    input: { expectedRevision: 4 },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function registry(
  invoke: MapDesignNativeToolRegistry['call'] = async (context) => success(context.toolUseId),
): MapDesignNativeToolRegistry {
  return {
    definitions: () => [{
      name: 'map_validate',
      description: 'Validate the current map draft.',
      inputSchema: { type: 'object' },
    }],
    call: vi.fn(invoke),
  };
}

describe('SDK Map tool runtime', () => {
  it('dispatches one correlated call through the Native Tool Registry', async () => {
    const nativeRegistry = registry();
    const runtime = createSdkMapToolRuntime(nativeRegistry);

    const result = await runtime.execute(call());

    expect(nativeRegistry.call).toHaveBeenCalledWith({
      runId: 'run-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      toolUseId: 'tool-1',
      signal: expect.any(AbortSignal),
    }, 'map_validate', { expectedRevision: 4 });
    expect(result).toMatchObject({ ok: true, toolUseId: 'tool-1' });
  });

  it('rejects unknown tools before dispatch', async () => {
    const nativeRegistry = registry();
    const runtime = createSdkMapToolRuntime(nativeRegistry);

    const result = await runtime.execute(call({ name: 'map_shell' as never }));

    expect(result).toEqual({
      ok: false,
      toolUseId: 'tool-1',
      error: {
        code: 'UNKNOWN_TOOL',
        message: 'The map tool call is not registered.',
        retryable: false,
      },
    });
    expect(nativeRegistry.call).not.toHaveBeenCalled();
  });

  it('replays an identical duplicate tool-use id without executing twice', async () => {
    let resolve!: (result: MapNativeToolResult) => void;
    const pending = new Promise<MapNativeToolResult>((done) => { resolve = done; });
    const nativeRegistry = registry(async () => pending);
    const runtime = createSdkMapToolRuntime(nativeRegistry);

    const first = runtime.execute(call());
    const replay = runtime.execute(call({ input: { expectedRevision: 4 } }));
    resolve(success('tool-1'));

    await expect(first).resolves.toEqual(await replay);
    expect(nativeRegistry.call).toHaveBeenCalledTimes(1);
  });

  it('reports activity only for a newly admitted execution and its genuine completion', async () => {
    let release!: (result: MapNativeToolResult) => void;
    const pending = new Promise<MapNativeToolResult>((resolve) => { release = resolve; });
    const nativeRegistry = registry(async () => pending);
    const runtime = createSdkMapToolRuntime(nativeRegistry);
    const activity = vi.fn();

    const first = runtime.execute(call({ activity }));
    await vi.waitFor(() => expect(activity.mock.calls).toEqual([['admitted']]));
    const replayActivity = vi.fn();
    const replay = runtime.execute(call({ activity: replayActivity }));
    const conflictActivity = vi.fn();
    const conflict = runtime.execute(call({ input: { expectedRevision: 5 }, activity: conflictActivity }));

    release(success('tool-1'));

    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(replay).resolves.toMatchObject({ ok: true });
    await expect(conflict).resolves.toMatchObject({ ok: false, error: { code: 'DUPLICATE_TOOL_CALL' } });
    expect(activity.mock.calls).toEqual([['admitted'], ['completed']]);
    expect(replayActivity).not.toHaveBeenCalled();
    expect(conflictActivity).not.toHaveBeenCalled();
    expect(nativeRegistry.call).toHaveBeenCalledOnce();
  });

  it('rejects a duplicate tool-use id reused for a different call', async () => {
    const nativeRegistry = registry();
    const runtime = createSdkMapToolRuntime(nativeRegistry);
    await runtime.execute(call());

    const result = await runtime.execute(call({ input: { expectedRevision: 5 } }));

    expect(result).toMatchObject({
      ok: false,
      toolUseId: 'tool-1',
      error: { code: 'DUPLICATE_TOOL_CALL', retryable: false },
    });
    expect(nativeRegistry.call).toHaveBeenCalledTimes(1);
  });

  it('binds a Run to its first project, conversation, and Agent identity', async () => {
    const nativeRegistry = registry();
    const runtime = createSdkMapToolRuntime(nativeRegistry);
    await runtime.execute(call());

    for (const mismatch of [
      { projectId: 'project-2', toolUseId: 'tool-project' },
      { conversationId: 'conversation-2', toolUseId: 'tool-conversation' },
      { agentId: 'pi', toolUseId: 'tool-agent' },
    ]) {
      await expect(runtime.execute(call(mismatch))).resolves.toMatchObject({
        ok: false,
        error: { code: 'RUN_NOT_AUTHORIZED', retryable: false },
      });
    }
    expect(nativeRegistry.call).toHaveBeenCalledTimes(1);
  });

  it('rejects calls after the Run is closed and closes idempotently', async () => {
    const nativeRegistry = registry();
    const runtime = createSdkMapToolRuntime(nativeRegistry);
    await runtime.execute(call());

    runtime.closeRun('run-1');
    runtime.closeRun('run-1');

    await expect(runtime.execute(call({ toolUseId: 'late-tool' }))).resolves.toMatchObject({
      ok: false,
      toolUseId: 'late-tool',
      error: { code: 'RUN_CLOSED', retryable: false },
    });
    expect(nativeRegistry.call).toHaveBeenCalledTimes(1);
  });

  it('cancels before dispatch and propagates an in-flight abort to the registry', async () => {
    const before = new AbortController();
    before.abort();
    const nativeRegistry = registry();
    const runtime = createSdkMapToolRuntime(nativeRegistry);

    await expect(runtime.execute(call({ signal: before.signal }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'CANCELED' },
    });
    expect(nativeRegistry.call).not.toHaveBeenCalled();

    let release!: () => void;
    const inFlight = registry(async (context) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return context.signal.aborted
        ? {
            ok: false,
            toolUseId: context.toolUseId,
            error: { code: 'CANCELED', message: 'The map tool call was canceled.', retryable: false },
          }
        : success(context.toolUseId);
    });
    const inFlightRuntime = createSdkMapToolRuntime(inFlight);
    const controller = new AbortController();
    const result = inFlightRuntime.execute(call({ signal: controller.signal }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    controller.abort();
    release();

    await expect(result).resolves.toMatchObject({
      ok: false,
      toolUseId: 'tool-1',
      error: { code: 'CANCELED', retryable: false },
    });
  });

  it('does not admit a call canceled before deferred dispatch begins', async () => {
    const controller = new AbortController();
    const nativeRegistry = registry();
    const runtime = createSdkMapToolRuntime(nativeRegistry);
    const activity = vi.fn();

    const result = runtime.execute(call({ signal: controller.signal, activity }));
    controller.abort();

    await expect(result).resolves.toMatchObject({ ok: false, error: { code: 'CANCELED' } });
    expect(activity).not.toHaveBeenCalled();
    expect(nativeRegistry.call).not.toHaveBeenCalled();
  });

  it('maps thrown secrets, bad correlation, and oversized model content to fixed safe errors', async () => {
    const secret = 'odtt_super-secret-token';
    const thrown = createSdkMapToolRuntime(registry(async () => {
      throw new Error(`${secret} at /Users/private/map.sqlite`);
    }));
    const badCorrelation = createSdkMapToolRuntime(registry(async () => success('other-tool')));
    const oversized = createSdkMapToolRuntime(registry(async (context) =>
      success(context.toolUseId, 'x'.repeat(256 * 1024 + 1))));

    const results = await Promise.all([
      thrown.execute(call()),
      badCorrelation.execute(call()),
      oversized.execute(call()),
    ]);

    expect(results[0]).toMatchObject({ ok: false, error: { code: 'SDK_TOOL_FAILED' } });
    expect(results[1]).toMatchObject({ ok: false, error: { code: 'TOOL_PROTOCOL_ERROR' } });
    expect(results[2]).toMatchObject({ ok: false, error: { code: 'TOOL_RESULT_TOO_LARGE' } });
    expect(JSON.stringify(results)).not.toContain(secret);
    expect(JSON.stringify(results)).not.toContain('/Users/private');
  });

  it('maps a malformed failure without an error object to a fixed protocol result', async () => {
    const runtime = createSdkMapToolRuntime(registry(async (context) => ({
      ok: false,
      toolUseId: context.toolUseId,
    } as never)));

    await expect(runtime.execute(call())).resolves.toEqual({
      ok: false,
      toolUseId: 'tool-1',
      error: {
        code: 'TOOL_PROTOCOL_ERROR',
        message: 'The map tool returned an invalid result.',
        retryable: false,
      },
    });
  });
});
