import { createMapRunHistory } from '../../../src/map-design/storage/run-history.js';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { setImmediate as waitForNextTick } from 'node:timers/promises';

import {
  MapDesignMessageSchema,
  PersistedMapAgentEventsSchema,
  SafeToolSummarySchema,
  type MapDesignRunEvent,
  type PersistedMapAgentEvent,
} from '@mapseekai/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  createMapDesignRunService as createMapDesignRunServiceProduction,
  MapDesignProjectRunConflictError,
  MapDesignRunConflictError,
  MapDesignRunRequestError,
  normalizeLocalAgentFailure,
  stopMapDesignProcessTree,
  type CreateMapDesignRunServiceDeps,
  type SpawnedLocalAgent,
} from '../../../src/map-design/application/run-service.js';
import { RunEventAccumulator } from '../../../src/map-design/application/run-events.js';
import type { MapAgentAdapter, MapAgentEvent, MapRunInput } from '../../../src/map-design/agents/types.js';
import { createSdkMapToolRuntime, type SdkMapToolRuntime } from '../../../src/map-design/agents/sdk-tool-runtime.js';
import type { MapDesignNativeToolRegistry } from '../../../src/map-design/tools/tool-context.js';
import { createClaudeStreamHandler } from '../../../src/runtimes/claude-stream.js';
import { createJsonEventStreamHandler } from '../../../src/runtimes/json-event-stream.js';
import { closeMapDesignDatabase, openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';
import { ToolTokenRegistry } from '../../../src/tool-tokens.js';
import type { RuntimeBuildOptions, RuntimeContext } from '../../../src/runtimes/types.js';

const TEST_MCP_CLI_PATH = '/opt/map-design/app/prebundled/daemon/map-design-mcp-cli.mjs';
const LITERAL_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtYXAtZGVzaWduIn0.c2lnbmF0dXJlMTIzNDU2';
type FixtureTerminal = {
  status: 'succeeded' | 'failed' | 'canceled';
  error?: { code: string; message: string };
};

type TestRunServiceDeps = Omit<
  CreateMapDesignRunServiceDeps,
  'mcpCliPath' | 'runtimeChoices' | 'runtimeCatalog'
> & Partial<Pick<CreateMapDesignRunServiceDeps, 'runtimeChoices' | 'runtimeCatalog'>>
  & { mcpCliPath?: string };

function createMapDesignRunService(
  deps: TestRunServiceDeps,
) {
  let legacyChoice = {
    agentId: 'codex',
    revision: 0,
    updatedAt: '2026-09-02T00:00:00.000Z',
  } as {
    agentId: string;
    model?: string;
    reasoning?: string;
    serviceTier?: string;
    revision: number;
    updatedAt: string;
  };
  const usesFixtureAdapter = !deps.agents.getMapAgent;
  const nativeToolRegistry = deps.nativeToolRegistry
    ?? (usesFixtureAdapter ? fixtureNativeToolRegistry : undefined);
  const fixtureAdapters = new Map<string, MapAgentAdapter>();
  const agents = !usesFixtureAdapter
    ? deps.agents
    : {
        ...deps.agents,
        getMapAgent(agentId: string): MapAgentAdapter | null {
          const agent = deps.agents.get(agentId);
          if (!agent) return null;
          let adapter = fixtureAdapters.get(agent.id);
          if (!adapter) {
            adapter = createFixtureNativeAdapter(agent, deps);
            fixtureAdapters.set(agent.id, adapter);
          }
          return adapter;
        },
      };
  const production = createMapDesignRunServiceProduction({
    ...deps,
    store: { ...deps.store, inTransaction: deps.store.inTransaction ?? vi.fn() },
    agents,
    mcpCliPath: deps.mcpCliPath ?? TEST_MCP_CLI_PATH,
    ...(nativeToolRegistry ? { nativeToolRegistry } : {}),
    runtimeChoices: deps.runtimeChoices ?? { requireCurrent: () => legacyChoice },
    runtimeCatalog: deps.runtimeCatalog ?? {
      resolveChoice: (_agentId, choice) => ({
        agentId: choice.agentId,
        model: choice.model ?? 'default',
        modelOrigin: choice.modelOrigin ?? 'catalog',
        ...(choice.reasoning === undefined ? {} : { reasoning: choice.reasoning }),
        ...(choice.serviceTier === undefined ? {} : { serviceTier: choice.serviceTier }),
        adapter: deps.agents.get(choice.agentId)?.mapDesign?.nativeToolAdapter ?? choice.agentId,
      }),
    },
  });
  return {
    ...production,
    start(request: Omit<Parameters<typeof production.start>[0], 'runtimeRevision'> & {
      runtimeRevision?: number;
      agentId?: string;
      model?: string;
      reasoning?: string;
      serviceTier?: string;
    }) {
      if (!deps.runtimeChoices) {
        legacyChoice = {
          agentId: request.agentId ?? legacyChoice.agentId,
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
          ...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
          revision: request.runtimeRevision ?? 0,
          updatedAt: '2026-09-02T00:00:00.000Z',
        };
      }
      const {
        agentId: _agentId,
        model: _model,
        reasoning: _reasoning,
        serviceTier: _serviceTier,
        ...authoritative
      } = request;
      return production.start({
        ...authoritative,
        runtimeRevision: request.runtimeRevision ?? 0,
      });
    },
  };
}

const fixtureNativeToolRegistry: MapDesignNativeToolRegistry = {
  definitions: () => [],
  call: async () => ({
    ok: false,
    toolUseId: 'fixture-tool-call',
    error: {
      code: 'UNKNOWN_TOOL',
      message: 'The map tool is not registered.',
      retryable: false,
    },
  }),
};

function createFixtureNativeAdapter(
  agent: NonNullable<ReturnType<CreateMapDesignRunServiceDeps['agents']['get']>>,
  deps: TestRunServiceDeps,
): MapAgentAdapter {
  return {
    id: agent.id,
    capabilities: { nativeMapTools: true, publicReasoningSummary: true },
    async startMapRun(input, _tools, onEvent) {
      let child: SpawnedLocalAgent | null = null;
      let terminal = false;
      let canceling = false;
      let cancellation: Promise<void> | null = null;
      let resolveDone!: (result: FixtureTerminal) => void;
      const done = new Promise<FixtureTerminal>((resolve) => {
        resolveDone = resolve;
      });
      const finish = (result: FixtureTerminal) => {
        if (terminal) return;
        terminal = true;
        input.signal.removeEventListener('abort', onAbort);
        resolveDone(result);
      };
      const cancel = (): Promise<void> => {
        if (terminal) return Promise.resolve();
        if (cancellation) return cancellation;
        canceling = true;
        cancellation = (async () => {
          if (child) {
            // Fixture PIDs are synthetic; default cancellation must stay inside the fake child.
            const stop = deps.stopProcessTree
              ?? ((target: SpawnedLocalAgent) => stopMapDesignProcessTree(
                { once: target.once.bind(target), kill: target.kill.bind(target) },
                deps.processStopTimeoutMs ?? 250,
              ));
            await stop(child);
          }
          finish({ status: 'canceled' });
        })();
        return cancellation;
      };
      const onAbort = () => { void cancel(); };
      input.signal.addEventListener('abort', onAbort, { once: true });

      try {
        const args = agent.buildArgs(
          input.prompt,
          [],
          [],
          { model: input.model, reasoning: input.reasoning, serviceTier: input.serviceTier },
          { cwd: input.cwd },
        );
        const environment = deps.agents.launchEnv?.(agent.id, { model: input.model }) ?? {};
        const spawn = deps.agents.spawn ?? (() => {
          throw new Error('fixture native host is unavailable');
        });
        child = spawn(agent.bin, args, {
          cwd: input.cwd,
          env: { ...environment },
          detached: false,
        });
      } catch {
        finish({
          status: 'failed',
          error: { code: 'RUN_FAILED', message: 'The local agent could not start.' },
        });
        return { done, cancel };
      }

      const emit = (event: Record<string, unknown>) => {
        if (terminal || canceling) return;
        if (event.type === 'error') {
          finish({ status: 'failed', error: normalizeLocalAgentFailure(event) });
          return;
        }
        const persisted = fixturePersistedEvent(event);
        if (persisted && persisted.kind !== 'run_finished') onEvent(persisted);
      };
      const parser = agent.streamFormat === 'claude-stream-json'
        ? createClaudeStreamHandler(emit)
        : agent.streamFormat === 'json-event-stream'
          ? createJsonEventStreamHandler(agent.eventParser ?? agent.id, emit)
          : null;
      const decoder = new StringDecoder('utf8');
      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (terminal || canceling) return;
        const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        if (!text) return;
        if (parser) parser.feed(text);
        else onEvent({ kind: 'text', text });
      });
      child.once('close', (code) => {
        if (terminal || canceling) return;
        const trailing = decoder.end();
        if (trailing) {
          if (parser) parser.feed(trailing);
          else onEvent({ kind: 'text', text: trailing });
        }
        parser?.flush();
        finish(code === 0
          ? { status: 'succeeded' }
          : {
              status: 'failed',
              error: { code: 'RUN_FAILED', message: 'The local agent exited unsuccessfully.' },
            });
      });
      child.once('error', () => {
        finish({
          status: 'failed',
          error: { code: 'RUN_FAILED', message: 'The local agent could not start.' },
        });
      });
      return { done, cancel };
    },
  };
}

function fixturePersistedEvent(event: Record<string, unknown>): PersistedMapAgentEvent | null {
  if (event.type === 'status') return { kind: 'status', label: 'analyzing' };
  if (event.type === 'thought_summary_delta' && typeof event.delta === 'string') {
    return { kind: 'thinking', text: event.delta };
  }
  if (event.type === 'text_delta' && typeof event.delta === 'string') {
    return { kind: 'text', text: event.delta };
  }
  if (event.type === 'tool_use' && typeof event.id === 'string' && typeof event.name === 'string') {
    return {
      kind: 'tool_use',
      id: event.id,
      name: event.name,
      summary: fixtureSummary(event.summary),
    };
  }
  if (event.type === 'tool_result' && typeof event.toolUseId === 'string') {
    return {
      kind: 'tool_result',
      toolUseId: event.toolUseId,
      status: event.status === 'failed' || event.isError === true ? 'failed' : 'succeeded',
      summary: fixtureSummary(event.summary),
    };
  }
  return null;
}

function fixtureSummary(value: unknown): Record<string, string | number | boolean> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, string | number | boolean>
    : {};
}

describe('MapDesignRunService', () => {
  it('preserves provider event order and merges thinking only within its current block', () => {
    const events = new RunEventAccumulator();

    expect(events.apply({ kind: 'tool_use', id: 'tools-omitted', name: 'provider_tool', summary: {} })).toBe(false);
    expect(events.apply({ kind: 'tool_result', toolUseId: 'tools-omitted', status: 'succeeded', summary: {} })).toBe(false);
    expect(events.apply({ kind: 'status', label: 'analyzing' })).toBe(true);
    expect(events.apply({ kind: 'thinking', text: 'Inspecting ' })).toBe(true);
    expect(events.apply({ kind: 'thinking', text: 'road hierarchy.' })).toBe(true);
    expect(events.apply({ kind: 'tool_use', id: 'call-1', name: 'map_inspect', summary: { target: 'root' } })).toBe(true);
    expect(events.apply({ kind: 'tool_result', toolUseId: 'call-1', status: 'succeeded', summary: { returned: 12 } })).toBe(true);
    expect(events.apply({ kind: 'tool_result', toolUseId: 'call-1', status: 'failed', summary: { returned: 0 } })).toBe(false);
    expect(events.apply({ kind: 'thinking', text: 'Preparing the final answer.' })).toBe(true);
    expect(events.apply({ kind: 'text', text: 'The map is ready.' })).toBe(true);
    expect(events.finish('succeeded', undefined, 1_788_100_002_000)).toBe(true);
    expect(events.finish('failed', { code: 'RUN_FAILED', message: 'late' }, 1_788_100_003_000)).toBe(false);

    expect(events.snapshot()).toEqual([
      { kind: 'status', label: 'analyzing' },
      { kind: 'thinking', text: 'Inspecting road hierarchy.' },
      { kind: 'tool_use', id: 'call-1', name: 'map_inspect', summary: { target: 'root' } },
      { kind: 'tool_result', toolUseId: 'call-1', status: 'succeeded', summary: { returned: 12 } },
      { kind: 'thinking', text: 'Preparing the final answer.' },
      { kind: 'text', text: 'The map is ready.' },
      { kind: 'run_finished', status: 'succeeded' },
    ]);
  });

  it('preserves a schema-safe SDK issue path through the persisted event round-trip', () => {
    const details = {
      firstPath: 'transaction.operations.0',
      operationIndex: 0,
      issueCount: 1,
    };
    expect(SafeToolSummarySchema.safeParse(details).success).toBe(true);
    const events = new RunEventAccumulator();
    expect(events.apply({
      kind: 'tool_use',
      id: 'call-sdk-invalid',
      name: 'map_apply_transaction',
      summary: {},
    })).toBe(true);
    expect(events.apply({
      kind: 'tool_result',
      toolUseId: 'call-sdk-invalid',
      status: 'failed',
      summary: { code: 'INVALID_INPUT', retryable: false, ...details },
    })).toBe(true);

    const persisted = PersistedMapAgentEventsSchema.parse(
      JSON.parse(JSON.stringify(events.snapshot())),
    );

    expect(persisted).toContainEqual({
      kind: 'tool_result',
      toolUseId: 'call-sdk-invalid',
      status: 'failed',
      summary: {
        code: 'INVALID_INPUT',
        retryable: false,
        firstPath: 'transaction.operations.0',
        operationIndex: 0,
        issueCount: 1,
      },
    });
  });

  it('preserves whitespace-only and line-break text deltas without inserting an unavailable-content fallback', () => {
    const events = new RunEventAccumulator();
    expect(events.apply({ kind: 'text', text: 'Revision' })).toBe(true);
    expect(events.apply({ kind: 'text', text: ' ' })).toBe(true);
    expect(events.apply({ kind: 'text', text: '0' })).toBe(true);
    expect(events.apply({ kind: 'text', text: '\n' })).toBe(true);
    expect(events.apply({ kind: 'text', text: '- valid' })).toBe(true);
    expect(events.apply({ kind: 'text', text: '\r\n' })).toBe(true);
    expect(events.apply({ kind: 'text', text: '- previewed' })).toBe(true);

    const text = events.snapshot()
      .filter((event) => event.kind === 'text')
      .map((event) => event.text)
      .join('');
    expect(text).toBe('Revision 0\n- valid\n- previewed');
    expect(text).not.toContain('Content unavailable.');
  });

  it('keeps the latest bounded Agent deltas visible and redacts secrets assembled across chunks', () => {
    const thinking = new RunEventAccumulator();
    expect(thinking.apply({ kind: 'thinking', text: 'A'.repeat(2_048) })).toBe(true);
    expect(thinking.apply({ kind: 'thinking', text: 'LATEST THINKING' })).toBe(true);
    const thinkingText = thinking.snapshot().find((event) => event.kind === 'thinking')?.text ?? '';
    expect(Array.from(thinkingText)).toHaveLength(2_048);
    expect(thinkingText.startsWith('…')).toBe(true);
    expect(thinkingText.endsWith('LATEST THINKING')).toBe(true);

    const text = new RunEventAccumulator();
    expect(text.apply({ kind: 'text', text: 'B'.repeat(8_192) })).toBe(true);
    expect(text.apply({ kind: 'text', text: '\nLATEST TEXT' })).toBe(true);
    const answerText = text.snapshot().find((event) => event.kind === 'text')?.text ?? '';
    expect(Array.from(answerText)).toHaveLength(8_192);
    expect(answerText.startsWith('…')).toBe(true);
    expect(answerText.endsWith('\nLATEST TEXT')).toBe(true);

    const secret = new RunEventAccumulator();
    const split = Math.floor(LITERAL_JWT.length / 2);
    expect(secret.apply({ kind: 'thinking', text: LITERAL_JWT.slice(0, split) })).toBe(true);
    expect(secret.apply({ kind: 'thinking', text: LITERAL_JWT.slice(split) })).toBe(true);
    expect(secret.snapshot()).toEqual([{ kind: 'thinking', text: 'Summary unavailable.' }]);
    expect(JSON.stringify(secret.snapshot())).not.toContain(LITERAL_JWT);
  });

  it('uses one fixed fallback for compact JWTs and established credential families in public thinking', () => {
    for (const sensitive of [
      LITERAL_JWT,
      `Bearer ${LITERAL_JWT}`,
      'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
      'glpat-0123456789abcdefghijklmnop',
      'xoxb-0123456789-abcdefghijklmnop',
      'ya29.0123456789abcdefghijklmnop',
      'AIza0123456789abcdefghijklmnop',
      'TOKEN_SUPERSECRET',
      'token_supersecret',
      'sk_0123456789abcdef',
      'secret_0123456789abcdef',
    ]) {
      const events = new RunEventAccumulator();
      expect(events.apply({ kind: 'thinking', text: sensitive })).toBe(true);
      expect(events.snapshot()).toEqual([{ kind: 'thinking', text: 'Summary unavailable.' }]);
      expect(JSON.stringify(events.snapshot())).not.toContain(sensitive);
    }

    for (const safeIdentifier of ['token_count', 'secret_status', 'credential_type', 'api_key_count']) {
      const events = new RunEventAccumulator();
      expect(events.apply({ kind: 'thinking', text: safeIdentifier })).toBe(true);
      expect(events.snapshot()).toEqual([{ kind: 'thinking', text: safeIdentifier }]);
    }
  });

  it('normalizes credential-shaped provider error codes and messages to fixed safe values', () => {
    expect(normalizeLocalAgentFailure({
      error: { code: 'TOKEN_SUPERSECRET', message: 'token_supersecret' },
    })).toEqual({
      code: 'RUN_FAILED',
      message: 'The local agent reported an error.',
    });
  });

  it('bounds ordered event snapshots while retaining the latest terminal tool and run result', () => {
    const events = new RunEventAccumulator();
    for (let index = 0; index < 100; index += 1) {
      expect(events.apply({
        kind: 'tool_use', id: `call-${index}`, name: 'map_inspect',
        summary: { target: `layer-${index}`, padding: '一'.repeat(1_024) },
      })).toBe(true);
      expect(events.apply({
        kind: 'tool_result', toolUseId: `call-${index}`, status: 'succeeded', summary: { returned: index },
      })).toBe(true);
    }
    expect(events.finish('succeeded', undefined, 1_788_100_002_000)).toBe(true);

    const snapshot = events.snapshot();
    expect(snapshot.length).toBeLessThanOrEqual(80);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(65_536);
    expect(snapshot).toContainEqual(expect.objectContaining({ kind: 'tool_use', id: 'tools-omitted' }));
    expect(snapshot).toContainEqual(expect.objectContaining({ kind: 'tool_use', id: 'call-99' }));
    expect(snapshot.at(-1)).toEqual({ kind: 'run_finished', status: 'succeeded' });
    expect(snapshot.filter((event) => event.kind === 'tool_use' && event.id === 'tools-omitted')).toHaveLength(1);
    expect(snapshot.filter((event) => event.kind === 'tool_result' && event.toolUseId === 'tools-omitted')).toHaveLength(1);
  });

  it('fits multibyte final content and ordered evidence into one complete persisted message budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'map-design-run-budget-'));
    const database = openMapDesignDatabase(root);
    try {
      const store = createMapDesignLocalStore(database);
      store.createProject({
        project: {
          projectId: 'map-1', title: 'Map', runtime: { agentId: 'codex' },
          source: { url: 'https://example.com/style.json' },
          designRequirement: 'Keep the final answer complete.', idempotencyKey: 'key-1',
        },
        primaryConversationId: 'conversation-1',
        verifiedWorkingDirectory: null,
      });
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
      child.stdout = new PassThrough(); child.kill = () => true; child.pid = 4321;
      const events: MapDesignRunEvent[] = [];
      const service = createMapDesignRunService({
        store,
        agents: { get: () => ({ id: 'codex', bin: 'codex', streamFormat: 'json-event-stream', eventParser: 'codex', buildArgs: () => ['exec'] }), spawn: () => child, stageSkill: async () => undefined },
        toolTokens: new ToolTokenRegistry(), dataDir: root, projectRoot: root,
        daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) },
        randomId: () => 'run-1', now: (() => { let value = 1_788_100_000_000; return () => value += 1_000; })(),
      });
      const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Write a detailed final answer.', agentId: 'codex', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
      service.subscribe(run.runId, (event) => events.push(event));

      const chunk = '界'.repeat(2_700);
      expect(() => {
        child.stdout.write('{"type":"turn.started"}\n');
        child.stdout.write('{"type":"item.started","item":{"id":"call-latest","type":"command_execution","command":"validate"}}\n');
        child.stdout.write('{"type":"item.completed","item":{"id":"call-latest","type":"command_execution","command":"validate","aggregated_output":"valid","exit_code":0}}\n');
        for (let index = 0; index < 10; index += 1) {
          child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: `message-${index}`, type: 'agent_message', text: chunk } })}\n`);
        }
        child.stdout.end();
        child.emit('close', 0);
      }).not.toThrow();
      await waitForNextTick();

      const completed = events.find((event) => event.type === 'message_completed');
      expect(completed?.type).toBe('message_completed');
      if (completed?.type !== 'message_completed') throw new Error('missing completed message');
      expect(() => MapDesignMessageSchema.parse(completed.message)).not.toThrow();
      expect(Buffer.byteLength(JSON.stringify(completed.message))).toBeLessThanOrEqual(65_536);
      expect(completed.message.content.endsWith('…')).toBe(true);
      expect(completed.message.events).toContainEqual(expect.objectContaining({ kind: 'tool_use', id: 'call-latest' }));
      expect(completed.message.events).toContainEqual(expect.objectContaining({ kind: 'tool_result', toolUseId: 'call-latest' }));
      expect(completed.message.events.at(-1)).toEqual({ kind: 'run_finished', status: 'succeeded' });
      for (const event of events.filter((candidate) => candidate.type === 'event_snapshot')) {
        expect(Buffer.byteLength(JSON.stringify(event.events))).toBeLessThanOrEqual(65_536);
      }
      expect(store.getConversation('conversation-1')?.messages.find((message) => message.id === 'assistant-1')).toEqual(completed.message);
    } finally {
      closeMapDesignDatabase(database);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists one literal provider sequence as a single ordered event stream', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.kill = () => true; child.pid = 4321;
    const patches: Array<Record<string, unknown>> = [];
    const events: MapDesignRunEvent[] = [];
    const service = createMapDesignRunService({
      store: {
        getProject: () => ({ id: 'map-1', runtime: { agentId: 'codex' }, workingDirectory: null, primaryConversationId: 'conversation-1' }),
        getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }),
        appendMessage: () => undefined,
        updateRunMessage: (_id: string, patch: Record<string, unknown>) => { patches.push(structuredClone(patch)); },
      } as never,
      agents: { get: () => ({ id: 'codex', bin: 'codex', streamFormat: 'json-event-stream', eventParser: 'codex', buildArgs: () => ['exec'] }), spawn: () => child, stageSkill: async () => undefined },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) }, randomId: () => 'run-1',
    });
    const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Inspect labels.', agentId: 'codex', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    service.subscribe(run.runId, (event) => events.push(event));

    child.stdout.end([
      '{"type":"turn.started"}',
      '{"type":"item.updated","item":{"id":"reason-1","type":"reasoning","text":"Inspecting the road hierarchy."}}',
      '{"type":"item.started","item":{"id":"call-1","type":"command_execution","command":"validate"}}',
      '{"type":"item.completed","item":{"id":"call-1","type":"command_execution","command":"validate","aggregated_output":"valid","exit_code":0}}',
      '{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"The map is ready."}}',
    ].join('\n') + '\n');
    child.emit('close', 0);
    await waitForNextTick();

    const stored = patches.at(-1)?.events as Array<{ kind: string }>;
    expect(stored.map((event) => event.kind)).toEqual([
      'status', 'thinking', 'tool_use', 'tool_result', 'text', 'run_finished',
    ]);
    expect(events.find((event) => event.type === 'message_completed')).toMatchObject({
      message: { events: stored },
    });
  });

  it('coalesces semantic events into immutable ordered snapshots and flushes terminal state immediately', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
      child.stdout = new PassThrough(); child.kill = () => true; child.pid = 4321;
      const patches: Array<Record<string, unknown>> = [];
      const events: MapDesignRunEvent[] = [];
      const service = createMapDesignRunService({
        store: {
          getProject: () => ({ id: 'map-1', runtime: { agentId: 'codex' }, workingDirectory: null, primaryConversationId: 'conversation-1' }),
          getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }),
          appendMessage: () => undefined,
          updateRunMessage: (_id: string, patch: Record<string, unknown>) => { patches.push(patch); },
          getAgentSession: () => null,
          upsertAgentSession: () => undefined,
        } as never,
        agents: {
          get: () => ({ id: 'codex', bin: 'codex', streamFormat: 'json-event-stream', eventParser: 'codex', buildArgs: () => ['exec'] }),
          spawn: () => child,
          stageSkill: async () => undefined,
        },
        toolTokens: new ToolTokenRegistry(),
        dataDir: '/tmp/data',
        projectRoot: '/tmp/projects',
        daemonUrl: () => 'http://localhost',
        mapContext: { getContext: async () => ({}) },
        randomId: () => 'run-1',
      });
      const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Inspect labels.', agentId: 'codex', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
      service.subscribe(run.runId, (event) => events.push(event));

      child.stdout.write('{"type":"turn.started"}\n');
      expect(patches).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(49);
      expect(patches).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(patches).toHaveLength(1);
      expect(patches[0]?.events).toEqual([{ kind: 'status', label: 'analyzing' }]);

      child.stdout.write('{"type":"item.updated","item":{"id":"reason-1","type":"reasoning","text":"Inspecting"}}\n');
      child.stdout.write('{"type":"item.updated","item":{"id":"reason-1","type":"reasoning","text":"Inspecting layers"}}\n');
      expect(patches).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(49);
      expect(patches).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(patches).toHaveLength(2);
      expect(patches[1]?.events).toEqual([
        { kind: 'status', label: 'analyzing' },
        { kind: 'thinking', text: 'Inspecting layers' },
      ]);

      child.stdout.write('{"type":"item.updated","item":{"id":"reason-1","type":"reasoning","text":"Inspecting layers safely"}}\n');
      child.stdout.end('{"type":"turn.completed","usage":{}}\n');
      child.emit('close', 0);
      await waitForNextTick();

      expect(vi.getTimerCount()).toBe(0);
      expect(patches.at(-1)?.events).toEqual([
        { kind: 'status', label: 'analyzing' },
        { kind: 'thinking', text: 'Inspecting layers safely' },
        { kind: 'run_finished', status: 'succeeded' },
      ]);
      const eventTypes = events.map((event) => event.type);
      const snapshotEvents = events.filter((event) => event.type === 'event_snapshot');
      const snapshots = snapshotEvents.map((event) => event.events);
      expect(snapshots).toHaveLength(3);
      expect(snapshots.every((snapshot) => Object.isFrozen(snapshot))).toBe(true);
      expect(snapshots.every((snapshot) => snapshot.every((entry) => Object.isFrozen(entry)))).toBe(true);
      const terminalSnapshotIndex = eventTypes.lastIndexOf('event_snapshot');
      expect(terminalSnapshotIndex).toBeGreaterThan(-1);
      expect(eventTypes.indexOf('message_completed')).toBeGreaterThan(terminalSnapshotIndex);
      expect(eventTypes.indexOf('run_finished')).toBeGreaterThan(eventTypes.indexOf('message_completed'));
      expect(events.find((event) => event.type === 'message_completed')).toMatchObject({
        message: { runStatus: 'succeeded', events: expect.arrayContaining([{ kind: 'run_finished', status: 'succeeded' }]) },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces a large semantic burst into one complete bounded event snapshot', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.kill = () => true; child.pid = 4321;
    const events: MapDesignRunEvent[] = [];
    const service = createMapDesignRunService({
      store: {
        getProject: () => ({ id: 'map-1', runtime: { agentId: 'codex' }, workingDirectory: null, primaryConversationId: 'conversation-1' }),
        getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }),
        appendMessage: () => undefined,
        updateRunMessage: () => undefined,
        getAgentSession: () => null,
        upsertAgentSession: () => undefined,
      } as never,
      agents: { get: () => ({ id: 'codex', bin: 'codex', streamFormat: 'json-event-stream', eventParser: 'codex', buildArgs: () => ['exec'] }), spawn: () => child, stageSkill: async () => undefined },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) }, randomId: () => 'run-1',
    });
    const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Inspect labels.', agentId: 'codex', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    service.subscribe(run.runId, (event) => events.push(event));

    for (let index = 0; index < 100; index += 1) {
      child.stdout.write(`${JSON.stringify({ type: 'item.started', item: { id: `tool-${index}`, type: 'command_execution', command: `validate-${index}` } })}\n`);
      child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: `tool-${index}`, type: 'command_execution', command: `validate-${index}`, aggregated_output: 'valid', exit_code: 0 } })}\n`);
    }

      expect(events).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(49);
      expect(events).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);

      const snapshotEvents = events.filter((event) => event.type === 'event_snapshot');
      expect(snapshotEvents).toHaveLength(1);
      const snapshots = snapshotEvents.map((event) => event.events);
      for (const snapshot of snapshots) {
        expect(snapshot.length).toBeLessThanOrEqual(80);
        expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(65_536);
      }
      expect(snapshots.at(-1)).toContainEqual(expect.objectContaining({ kind: 'tool_use', id: 'tools-omitted' }));
      expect(snapshots.at(-1)).toContainEqual(expect.objectContaining({ kind: 'tool_use', id: 'tool-99' }));

      child.stdout.end();
      child.emit('close', 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never streams a compact JWT in either the changed entry or bounded snapshot', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.kill = () => true; child.pid = 4321;
    const events: MapDesignRunEvent[] = [];
    const service = createMapDesignRunService({
      store: {
        getProject: () => ({ id: 'map-1', runtime: { agentId: 'codex' }, workingDirectory: null, primaryConversationId: 'conversation-1' }),
        getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }),
        appendMessage: () => undefined,
        updateRunMessage: () => undefined,
        getAgentSession: () => null,
        upsertAgentSession: () => undefined,
      } as never,
      agents: { get: () => ({ id: 'codex', bin: 'codex', streamFormat: 'json-event-stream', eventParser: 'codex', buildArgs: () => ['exec'] }), spawn: () => child, stageSkill: async () => undefined },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) }, randomId: () => 'run-1',
    });
    const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Inspect labels.', agentId: 'codex', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    service.subscribe(run.runId, (event) => events.push(event));

    child.stdout.write(`${JSON.stringify({ type: 'item.updated', item: { id: 'reason-1', type: 'reasoning', text: `Inspecting ${LITERAL_JWT}` } })}\n`);
    service.subscribe(run.runId, () => undefined);

    const browserFacing = events.filter((event) => event.type === 'event_snapshot');
    expect(browserFacing).toHaveLength(1);
    expect(JSON.stringify(browserFacing)).toContain('Summary unavailable.');
    expect(JSON.stringify(browserFacing)).not.toContain(LITERAL_JWT);
  });

  it.each([
    { outcome: 'failed', finish: async (service: ReturnType<typeof createMapDesignRunService>, child: EventEmitter) => { child.emit('close', 1); } },
    { outcome: 'canceled', finish: async (service: ReturnType<typeof createMapDesignRunService>, _child: EventEmitter) => { await service.cancel('run-1'); } },
  ] as const)('persists and streams a safe $outcome terminal event', async ({ outcome, finish }) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.kill = () => true; child.pid = 4321;
    const patches: Array<Record<string, unknown>> = [];
    const events: MapDesignRunEvent[] = [];
    const service = createMapDesignRunService({
      store: {
        getProject: () => ({ id: 'map-1', runtime: { agentId: 'codex' }, workingDirectory: null, primaryConversationId: 'conversation-1' }),
        getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }),
        appendMessage: () => undefined,
        updateRunMessage: (_id: string, patch: Record<string, unknown>) => { patches.push(patch); },
      } as never,
      agents: { get: () => ({ id: 'codex', bin: 'codex', streamFormat: 'json-event-stream', eventParser: 'codex', buildArgs: () => ['exec'] }), spawn: () => child, stageSkill: async () => undefined },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) }, randomId: () => 'run-1',
    });
    const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Inspect labels.', agentId: 'codex', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    service.subscribe(run.runId, (event) => events.push(event));

    await finish(service, child);

    expect(patches.at(-1)?.events).toEqual(expect.arrayContaining([
      { kind: 'run_finished', status: outcome },
    ]));
    expect([...events].reverse().find((event) => event.type === 'event_snapshot')).toMatchObject({
      events: expect.arrayContaining([{ kind: 'run_finished', status: outcome }]),
    });
    expect(JSON.stringify(events)).not.toContain('/tmp/');
  });

  it('persists the current thinking block synchronously before shutdown terminalizes it', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
      child.stdout = new PassThrough(); child.kill = () => true; child.pid = 4321;
      const patches: Array<Record<string, unknown>> = [];
      const service = createMapDesignRunService({
        store: {
          getProject: () => ({ id: 'map-1', runtime: { agentId: 'codex' }, workingDirectory: null, primaryConversationId: 'conversation-1' }),
          getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }),
          appendMessage: () => undefined,
          updateRunMessage: (_id: string, patch: Record<string, unknown>) => { patches.push(patch); },
        } as never,
        agents: { get: () => ({ id: 'codex', bin: 'codex', streamFormat: 'json-event-stream', eventParser: 'codex', buildArgs: () => ['exec'] }), spawn: () => child, stageSkill: async () => undefined },
        toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) }, randomId: () => 'run-1', stopProcessTree: async () => undefined,
      });
      await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Inspect labels.', agentId: 'codex', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
      const timersBeforeSummary = vi.getTimerCount();
      child.stdout.write('{"type":"item.updated","item":{"id":"reason-1","type":"reasoning","text":"Inspecting layers"}}\n');
      expect(vi.getTimerCount()).toBe(timersBeforeSummary + 1);
      expect(patches).toHaveLength(0);

      const shutdown = service.shutdown();
      expect(vi.getTimerCount()).toBe(timersBeforeSummary);
      await shutdown;
      expect(vi.getTimerCount()).toBe(0);
      const writesAfterShutdown = patches.length;
      await vi.advanceTimersByTimeAsync(500);

      expect(patches).toHaveLength(writesAfterShutdown);
      expect(patches.at(-1)?.events).toEqual([
        { kind: 'thinking', text: 'Inspecting layers' },
        { kind: 'run_finished', status: 'canceled' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses late events while process cancellation is pending', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
      child.stdout = new PassThrough(); child.kill = () => true; child.pid = 4321;
      let releaseStop!: () => void;
      const stop = new Promise<void>((resolve) => { releaseStop = resolve; });
      type Operation =
        | { kind: 'write'; patch: Record<string, unknown> }
        | { kind: 'event'; event: MapDesignRunEvent };
      const operations: Operation[] = [];
      const service = createMapDesignRunService({
        store: {
          getProject: () => ({ id: 'map-1', runtime: { agentId: 'codex' }, workingDirectory: null, primaryConversationId: 'conversation-1' }),
          getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }),
          appendMessage: () => undefined,
          updateRunMessage: (_id: string, patch: Record<string, unknown>) => { operations.push({ kind: 'write', patch: structuredClone(patch) }); },
        } as never,
        agents: { get: () => ({ id: 'codex', bin: 'codex', streamFormat: 'json-event-stream', eventParser: 'codex', buildArgs: () => ['exec'] }), spawn: () => child, stageSkill: async () => undefined },
        toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) }, randomId: () => 'run-1', stopProcessTree: async () => stop,
      });
      const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Inspect labels.', agentId: 'codex', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
      service.subscribe(run.runId, (event) => operations.push({ kind: 'event', event }));
      const timersBeforeSummary = vi.getTimerCount();

      child.stdout.write('{"type":"item.updated","item":{"id":"reason-1","type":"reasoning","text":"Initial summary"}}\n');
      expect(vi.getTimerCount()).toBe(timersBeforeSummary + 1);
      expect(operations.filter((operation) => operation.kind === 'write')).toHaveLength(0);

      const cancellation = service.cancel(run.runId);
      expect(vi.getTimerCount()).toBe(timersBeforeSummary);
      const operationsAtPendingCancel = operations.length;
      child.stdout.write([
        '{"type":"turn.started"}',
        '{"type":"item.updated","item":{"id":"reason-1","type":"reasoning","text":"Initial summary LATE_SECRET /Users/alice/token"}}',
        '{"type":"item.started","item":{"id":"late-tool","type":"command_execution","command":"cat /Users/alice/token"}}',
        '{"type":"turn.failed","error":{"code":"TOKEN_SUPERSECRET","message":"error sending request for url (https://provider.invalid/private)"}}',
      ].join('\n') + '\n');
      await vi.advanceTimersByTimeAsync(501);

      expect(operations).toHaveLength(operationsAtPendingCancel);
      expect(operations.filter((operation) => operation.kind === 'write')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(timersBeforeSummary);

      releaseStop();
      await expect(cancellation).resolves.toEqual({ runId: run.runId, status: 'canceled' });
      const operationsAfterTerminal = operations.length;
      await vi.advanceTimersByTimeAsync(501);

      expect(operations).toHaveLength(operationsAfterTerminal);
      expect(vi.getTimerCount()).toBe(0);
      const terminalSnapshots = operations.filter((operation) => operation.kind === 'event'
        && operation.event.type === 'event_snapshot'
        && operation.event.events.some((event) => event.kind === 'run_finished' && event.status === 'canceled'));
      const completedMessages = operations.filter((operation) => operation.kind === 'event' && operation.event.type === 'message_completed');
      const finishedRuns = operations.filter((operation) => operation.kind === 'event' && operation.event.type === 'run_finished');
      expect(terminalSnapshots).toHaveLength(1);
      expect(completedMessages).toHaveLength(1);
      expect(finishedRuns).toHaveLength(1);
      expect(completedMessages[0]).toMatchObject({ event: { message: { runStatus: 'canceled' } } });
      expect(finishedRuns[0]).toMatchObject({ event: { run: { status: 'canceled' } } });

      const finalEventPatchIndex = operations.findIndex((operation) => operation.kind === 'write'
        && operation.patch.runStatus === 'canceled'
        && Array.isArray(operation.patch.events));
      const messageCompletedIndex = operations.findIndex((operation) => operation.kind === 'event' && operation.event.type === 'message_completed');
      const runFinishedIndex = operations.findIndex((operation) => operation.kind === 'event' && operation.event.type === 'run_finished');
      expect(finalEventPatchIndex).toBeGreaterThan(-1);
      expect(messageCompletedIndex).toBeGreaterThan(finalEventPatchIndex);
      expect(runFinishedIndex).toBeGreaterThan(messageCompletedIndex);

      const publicEvents = operations.filter((operation) => operation.kind === 'write'
        || (operation.kind === 'event' && operation.event.type === 'event_snapshot'));
      expect(JSON.stringify(publicEvents)).not.toContain('LATE_SECRET');
      expect(JSON.stringify(publicEvents)).not.toContain('/Users/alice');
      expect(JSON.stringify(publicEvents)).not.toContain('TOKEN_SUPERSECRET');
      expect(JSON.stringify(publicEvents)).not.toContain('provider.invalid');
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists the conversation in lifecycle order while keeping map authority server-side', async () => {
    const writes: Array<{ id: string; role: string }> = [];
    const store = {
      getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: '/tmp/map-1', primaryConversationId: 'conversation-1' }),
      getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z', messages: [] }),
      appendMessage: ({ message }: { message: { id: string; role: string } }) => writes.push({ id: message.id, role: message.role }),
      updateRunMessage: () => undefined,
    };
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (signal?: NodeJS.Signals) => boolean; pid: number };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 4321;
    child.kill = () => true;
    const staged: string[] = [];
    let modelPrompt = '';
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const service = createMapDesignRunService({
      store: store as never,
      agents: {
        get: () => ({ id: 'opencode', bin: 'opencode', streamFormat: 'json-event-stream', eventParser: 'opencode', buildArgs: (prompt: string) => { modelPrompt = prompt; return ['run']; } }),
        spawn: (_command, _args, options) => {
          spawnedEnv = options.env;
          return child;
        },
        stageSkill: async (skillId: string) => { staged.push(skillId); },
      },
      toolTokens: new ToolTokenRegistry(),
      dataDir: '/tmp/data',
      projectRoot: '/tmp/projects',
      daemonUrl: () => 'http://127.0.0.1:8787',
      mapContext: { getContext: async () => ({ draftRevision: 4, committedRevision: 3, validationStatus: 'valid' }) },
      now: () => 0,
      randomId: (() => { let n = 0; return () => `id-${++n}`; })(),
    });

    const events: string[] = [];
    const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Improve the road labels.', agentId: 'opencode', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    const unsubscribe = service.subscribe(run.runId, (event) => events.push(event.type));
    child.stdout.write('{"type":"step_start","sessionID":"session-1"}\n');
    child.stdout.write('{"type":"text","part":{"text":"Done"}}\n');
    child.stdout.write('{"type":"tool_use","sessionID":"session-1","part":{"tool":"map_get_context","callID":"tool-1","state":{"input":"{}"}}}\n');
    child.stdout.end();
    child.emit('close', 0, null);
    await waitForNextTick();
    unsubscribe();

    expect(run.status).toBe('running');
    expect(writes).toEqual([{ id: 'user-1', role: 'user' }, { id: 'assistant-1', role: 'assistant' }]);
    expect(events).toEqual([
      'event_snapshot', 'message_completed', 'run_finished',
    ]);
    expect(staged).toEqual(['map-design']);
    expect(service.get(run.runId)).toMatchObject({ status: 'succeeded' });
    expect(service.getGrant(run.runId)).toMatchObject({ projectId: 'map-1', allowedEndpoints: expect.arrayContaining(['/api/map-design/tools/map_get_context']) });
    expect(service.getGrant(run.runId)?.allowedEndpoints).toHaveLength(9);
    expect(spawnedEnv).not.toHaveProperty('MAP_DESIGN_DAEMON_URL');
    expect(spawnedEnv).not.toHaveProperty('MAP_DESIGN_TOOL_TOKEN');
    expect(modelPrompt).toContain('native run-scoped MapDesign tools in the `map-design` dynamic-tool namespace');
    for (const tool of [
      'map_get_context',
      'map_inspect',
      'map_search_layers',
      'map_apply_transaction',
      'map_update_semantics',
      'map_validate',
      'map_render_preview',
      'map_commit_revision',
      'map_discard_draft',
    ]) expect(modelPrompt).toContain(`\`${tool}\``);
    expect(modelPrompt).toContain('Do not use shell commands, `md tool`, MCP, or direct HTTP requests');
    expect(modelPrompt).toMatch(/new logical write.*exact current Run.*expected revision.*batch/iu);
    expect(modelPrompt).toContain('examples are shapes only');
    expect(modelPrompt).not.toContain('Daemon:');
  });

  it('reports a conversation and project as running only while their Run is non-terminal', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.kill = () => true; child.pid = 4321;
    const service = createMapDesignRunService({
      store: {
        getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' }),
        getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }),
        appendMessage: () => undefined, updateRunMessage: () => undefined,
      } as never,
      agents: { get: () => ({ id: 'opencode', bin: 'opencode', streamFormat: 'text', buildArgs: () => ['run'] }), spawn: () => child, stageSkill: async () => undefined },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost',
      mapContext: { getContext: async () => ({}) }, randomId: () => 'run-1',
    });

    await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Improve labels.', agentId: 'opencode', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    expect(service.getActiveConversationRun('conversation-1')).toMatchObject({ conversationId: 'conversation-1', status: 'running' });
    expect(service.getActiveConversationRun('conversation-2')).toBeNull();
    expect(service.isConversationRunning('conversation-1')).toBe(true);
    expect(service.isConversationRunning('conversation-2')).toBe(false);
    expect(service.isProjectRunning('map-1')).toBe(true);
    expect(service.isProjectRunning('map-2')).toBe(false);

    child.emit('close', 0, null);
    await waitForNextTick();
    expect(service.getActiveConversationRun('conversation-1')).toBeNull();
    expect(service.isConversationRunning('conversation-1')).toBe(false);
    expect(service.isProjectRunning('map-1')).toBe(false);
  });

  it.each([0, 1, Number.MAX_SAFE_INTEGER])(
    'rejects historical-mode Run creation before reading project state (viewed revision %s)',
    async (viewedRevision) => {
      const getProject = vi.fn(() => null);
      const service = createMapDesignRunService({
        store: {
          getProject,
          getConversation: vi.fn(() => null),
          appendMessage: vi.fn(),
          updateRunMessage: vi.fn(),
        } as never,
        agents: { get: vi.fn(() => null) },
        toolTokens: new ToolTokenRegistry(),
        dataDir: '/tmp/data',
        projectRoot: '/tmp/projects',
        daemonUrl: () => 'http://localhost',
        mapContext: { getContext: vi.fn(async () => ({})) },
        randomId: () => 'run-1',
      });

      await expect(service.start({
        projectId: 'map-1',
        conversationId: 'conversation-1',
        prompt: 'Do not mutate this historical revision.',
        agentId: 'opencode',
        viewedRevision,
        clientRequestId: `request-historical-${viewedRevision}`,
        userMessageId: 'user-historical',
        assistantMessageId: 'assistant-historical',
      })).rejects.toBeInstanceOf(MapDesignRunRequestError);

      expect(getProject).not.toHaveBeenCalled();
      expect(service.get('run-1')).toBeNull();
      expect(service.isProjectRunning('map-1')).toBe(false);
    },
  );

  it('allows only one active run per project while preserving replay and cross-project independence', async () => {
    const children = Array.from({ length: 3 }, () => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
      child.stdout = new PassThrough(); child.kill = () => true; child.pid = 4321;
      return child;
    });
    const writes: string[] = [];
    let spawns = 0;
    const service = createMapDesignRunService({
      store: {
        getProject: (projectId: string) => ['map-1', 'map-2'].includes(projectId)
          ? { id: projectId, runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: projectId === 'map-1' ? 'conversation-a' : 'conversation-c' }
          : null,
        getConversation: (conversationId: string) => {
          const projectId = conversationId === 'conversation-c' ? 'map-2' : 'map-1';
          return ['conversation-a', 'conversation-b', 'conversation-c'].includes(conversationId)
            ? { id: conversationId, projectId, createdAt: '', updatedAt: '', messages: [] }
            : null;
        },
        appendMessage: ({ message }: { message: { id: string } }) => { writes.push(message.id); },
        updateRunMessage: () => undefined,
      } as never,
      agents: {
        get: () => ({ id: 'text', bin: 'text', streamFormat: 'text', buildArgs: () => ['run'] }),
        spawn: () => children[spawns++]!,
        stageSkill: async () => undefined,
      },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost',
      mapContext: { getContext: async () => ({}) }, randomId: (() => { let id = 0; return () => `run-${++id}`; })(),
    });
    const requestA = { projectId: 'map-1', conversationId: 'conversation-a', prompt: 'Run A.', agentId: 'text', clientRequestId: 'request-a', userMessageId: 'user-a', assistantMessageId: 'assistant-a' };

    const runA = await service.start(requestA);
    await expect(service.start(requestA)).resolves.toEqual(runA);
    await expect(service.start({ projectId: 'map-1', conversationId: 'conversation-b', prompt: 'Run B.', agentId: 'text', clientRequestId: 'request-b', userMessageId: 'user-b', assistantMessageId: 'assistant-b' }))
      .rejects.toBeInstanceOf(MapDesignProjectRunConflictError);
    expect(writes).toEqual(['user-a', 'assistant-a']);
    expect(spawns).toBe(1);
    expect(service.getGrant('run-2')).toBeNull();

    await expect(service.start({ projectId: 'map-2', conversationId: 'conversation-c', prompt: 'Run C.', agentId: 'text', clientRequestId: 'request-c', userMessageId: 'user-c', assistantMessageId: 'assistant-c' }))
      .resolves.toMatchObject({ projectId: 'map-2', conversationId: 'conversation-c', status: 'running' });

    children[0]?.emit('close', 0, null);
    await waitForNextTick();
    await expect(service.start({ projectId: 'map-1', conversationId: 'conversation-b', prompt: 'Run B.', agentId: 'text', clientRequestId: 'request-b', userMessageId: 'user-b', assistantMessageId: 'assistant-b' }))
      .resolves.toMatchObject({ projectId: 'map-1', conversationId: 'conversation-b', status: 'running' });
  });

  it('keeps BYOK provider credentials out of unsupported Map Studio launches', async () => {
    const buildArgs = vi.fn(() => ['run']);
    const launchEnv = vi.fn(() => ({}));
    const spawn = vi.fn(() => {
      throw new Error('BYOK OpenCode must not be spawned');
    });
    const getMapAgent = vi.fn(() => null);
    const service = createMapDesignRunService({
      store: { getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' }), getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }), appendMessage: () => undefined, updateRunMessage: () => undefined } as never,
      agents: {
        get: () => ({
          id: 'byok-opencode',
          bin: 'opencode',
          streamFormat: 'json-event-stream',
          eventParser: 'opencode',
          buildArgs,
          mapDesign: { nativeToolAdapter: null, publicReasoningSummary: false },
        }),
        getMapAgent,
        launchEnv,
        spawn,
        stageSkill: async () => undefined,
      },
      nativeToolRegistry: fixtureNativeToolRegistry,
      config: { read: () => ({ agentModels: { 'byok-opencode': { model: 'preference-model' } } }) },
      mapContext: { getContext: async () => ({}) }, toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', randomId: () => 'run-1',
    });

    await expect(service.start({
      projectId: 'map-1',
      conversationId: 'conversation-1',
      prompt: 'Use BYOK.',
      agentId: 'byok-opencode',
      byokProvider: { protocol: 'openai', apiKey: 'request-only-key' },
      clientRequestId: 'request-1',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
    })).rejects.toBeInstanceOf(MapDesignRunRequestError);

    expect(service.get('run-1')).toBeNull();
    expect(getMapAgent).toHaveBeenCalledWith('byok-opencode');
    expect(buildArgs).not.toHaveBeenCalled();
    expect(launchEnv).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    await expect(service.start({
      projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Reject nested model authority.',
      agentId: 'byok-opencode',
      byokProvider: { protocol: 'openai', apiKey: 'request-only-key', model: 'request-provider-model' },
      clientRequestId: 'request-nested-model', userMessageId: 'user-nested-model', assistantMessageId: 'assistant-nested-model',
    } as never)).rejects.toBeInstanceOf(MapDesignRunRequestError);
    expect(getMapAgent).toHaveBeenCalledTimes(1);
    await expect(service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Reject invalid provider.', agentId: 'byok-opencode', byokProvider: null, clientRequestId: 'request-2', userMessageId: 'user-2', assistantMessageId: 'assistant-2' } as never)).rejects.toBeInstanceOf(MapDesignRunRequestError);
  });

  it('cancels the process tree once and emits one terminal event', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (signal?: NodeJS.Signals) => boolean; pid: number };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 4321;
    const signals: string[] = []; child.kill = (signal) => { signals.push(signal ?? 'SIGTERM'); child.emit('close', null, signal); return true; };
    const service = createMapDesignRunService({
      store: { getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' }), getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }), appendMessage: () => undefined, updateRunMessage: () => undefined } as never,
      agents: { get: () => ({ id: 'opencode', bin: 'opencode', streamFormat: 'json-event-stream', eventParser: 'opencode', buildArgs: () => ['run'] }), spawn: () => child, stageSkill: async () => undefined },
      mapContext: { getContext: async () => ({ draftRevision: 4, committedRevision: 3, validationStatus: 'valid' }) },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', randomId: (() => { let n = 0; return () => `id-${++n}`; })(),
    });
    const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Cancel.', agentId: 'opencode', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    const events: string[] = []; service.subscribe(run.runId, (event) => events.push(event.type));
    await expect(Promise.all([service.cancel(run.runId), service.cancel(run.runId)]))
      .resolves.toEqual([{ runId: run.runId, status: 'canceled' }, { runId: run.runId, status: 'canceled' }]);
    child.emit('close', null, 'SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));
    expect(signals).toEqual(['SIGTERM']);
    expect(events.filter((type) => type === 'run_finished')).toHaveLength(1);
    expect(service.get(run.runId)).toMatchObject({ status: 'canceled' });
  });

  it('does not resume a legacy CLI session or write a Map Studio prompt to stdin', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stdin: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true; child.pid = 4321;
    let stdin = ''; child.stdin.on('data', (chunk: Buffer) => { stdin += chunk.toString(); });
    const sessions: Array<Record<string, unknown>> = [];
    let buildContext: RuntimeContext | undefined;
    const service = createMapDesignRunService({
      store: {
        getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: '/tmp/map-1', primaryConversationId: 'conversation-1' }),
        getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }),
        appendMessage: () => undefined, updateRunMessage: () => undefined,
        getAgentSession: () => ({ conversationId: 'conversation-1', agentId: 'claude', sessionId: 'stored-session', stablePromptHash: null, model: null, cwd: '/tmp/map-1', lastMessageId: null, updatedAt: '' }),
        upsertAgentSession: (session: Record<string, unknown>) => { sessions.push(session); },
      } as never,
      agents: {
        get: () => ({ id: 'claude', bin: 'claude', streamFormat: 'claude-stream-json', promptViaStdin: true, promptInputFormat: 'stream-json', resumesSessionViaCli: true, capturesSessionIdFromStream: true, buildArgs: (_prompt: string, _images: string[], _dirs: string[] | undefined, _options: RuntimeBuildOptions | undefined, context: RuntimeContext | undefined) => { buildContext = context; return ['--stream-json']; } }),
        spawn: () => child, stageSkill: async () => undefined,
      },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost',
      mapContext: { getContext: async () => ({ draftRevision: 4, committedRevision: 3, validationStatus: 'valid' }) },
      now: () => 0, randomId: () => 'run-1',
    });
    await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Improve labels.', agentId: 'claude', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    child.stdout.end('{"type":"system","subtype":"init","session_id":"captured-session"}\n');
    child.emit('close', 0, null);
    await waitForNextTick();

    expect(buildContext).toEqual({ cwd: '/tmp/map-1' });
    expect(stdin).toBe('');
    expect(child.stdin.writableEnded).toBe(false);
    expect(sessions).toEqual([]);
  });

  it('does not write a Map Studio prompt to a legacy text stdin stream', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stdin: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true; child.pid = 4321;
    let stdin = ''; child.stdin.on('data', (chunk: Buffer) => { stdin += chunk.toString(); });
    const service = createMapDesignRunService({
      store: { getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' }), getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }), appendMessage: () => undefined, updateRunMessage: () => undefined, getAgentSession: () => null, upsertAgentSession: () => undefined } as never,
      agents: { get: () => ({ id: 'text', bin: 'text', streamFormat: 'text', promptViaStdin: true, promptInputFormat: 'text', buildArgs: () => ['run'] }), spawn: () => child, stageSkill: async () => undefined },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({ draftRevision: 4 }) }, randomId: () => 'run-1',
    });
    await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Improve labels.', agentId: 'text', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    await waitForNextTick();

    expect(stdin).toBe('');
    expect(child.stdin.writableEnded).toBe(false);
  });

  it.each([
    ['stage', { stageSkill: async () => { throw new Error('stage'); } }],
    ['build', { buildArgs: () => { throw new Error('build'); } }],
    ['spawn', { spawn: () => { throw new Error('spawn'); } }],
  ])('records a failed terminal run when %s preflight fails', async (_kind, value) => {
    const failure = value as { stageSkill?: () => Promise<void>; buildArgs?: () => string[]; spawn?: () => never };
    const service = createMapDesignRunService({
      store: { getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' }), getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }), appendMessage: () => undefined, updateRunMessage: () => undefined, getAgentSession: () => null, upsertAgentSession: () => undefined } as never,
      agents: {
        get: () => ({ id: 'text', bin: 'text', streamFormat: 'text', buildArgs: failure.buildArgs ?? (() => ['run']) }),
        stageSkill: failure.stageSkill ?? (async () => undefined),
        spawn: failure.spawn ?? (() => { const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number }; child.stdout = new PassThrough(); child.kill = () => true; child.pid = 4321; return child; }),
      },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({ draftRevision: 4 }) }, randomId: () => 'run-1',
    });
    const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Improve labels.', agentId: 'text', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });

    expect(service.get(run.runId)).toMatchObject({ status: 'failed', error: { code: 'RUN_FAILED' } });
  });

  it('does not spawn when shutdown cancels a delayed stage', async () => {
    let resolveStage!: () => void;
    const stage = new Promise<void>((resolve) => { resolveStage = resolve; });
    let spawns = 0;
    const service = createMapDesignRunService({
      store: { getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' }), getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }), appendMessage: () => undefined, updateRunMessage: () => undefined, getAgentSession: () => null, upsertAgentSession: () => undefined } as never,
      agents: { get: () => ({ id: 'text', bin: 'text', streamFormat: 'text', buildArgs: () => ['run'] }), stageSkill: () => stage, spawn: () => { spawns += 1; throw new Error('must not spawn'); } },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({ draftRevision: 4 }) }, randomId: () => 'run-1',
    });
    const start = service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Improve labels.', agentId: 'text', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    await waitForNextTick();
    service.shutdown();
    resolveStage();
    const run = await start;

    expect(spawns).toBe(0);
    expect(service.get(run.runId)).toMatchObject({ status: 'canceled' });
  });
  it('does not flush a partial parser frame or accept runtime output after cancellation', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: (signal?: NodeJS.Signals) => boolean; pid: number };
    child.stdout = new PassThrough(); child.pid = 4321; child.kill = () => true;
    const service = createMapDesignRunService({
      store: { getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' }), getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }), appendMessage: () => undefined, updateRunMessage: () => undefined } as never,
      agents: { get: () => ({ id: 'opencode', bin: 'opencode', streamFormat: 'json-event-stream', eventParser: 'opencode', buildArgs: () => ['run'] }), spawn: () => child, stageSkill: async () => undefined },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) }, randomId: () => 'run-1', processStopTimeoutMs: 0,
    });
    const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Cancel.', agentId: 'opencode', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    const events: MapDesignRunEvent[] = []; service.subscribe(run.runId, (event) => events.push(event));
    child.stdout.write('{"type":"message.updated","properties":{"text":"partial');
    await service.cancel(run.runId);
    child.stdout.write(' output"}}\n');
    child.emit('close', 0, null);
    await waitForNextTick();
    expect(events.map((event) => event.type)).toEqual(['event_snapshot', 'message_completed', 'run_finished']);
  });

  it('retains immutable safe tool events without raw input or output', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.pid = 4321; child.kill = () => true;
    let saved: Record<string, unknown> | undefined;
    const service = createMapDesignRunService({
      store: { getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' }), getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }), appendMessage: () => undefined, updateRunMessage: (_id: string, value: Record<string, unknown>) => { saved = value; } } as never,
      agents: { get: () => ({ id: 'gemini', bin: 'gemini', streamFormat: 'json-event-stream', eventParser: 'gemini', buildArgs: () => ['run'] }), spawn: () => child, stageSkill: async () => undefined },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) }, randomId: () => 'run-1',
    });
    const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Use tools.', agentId: 'gemini', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    child.stdout.end('{"type":"tool_use","tool_id":"tool-1","tool_name":"map_get_context","parameters":"{\\"nested\\":{\\"value\\":1}}"}\n{"type":"tool_result","tool_id":"tool-1","status":"error","output":"denied","error":{"code":"DENIED","message":"No access"}}\n');
    child.emit('close', 0, null);
    await waitForNextTick();
    const replay: MapDesignRunEvent[] = []; service.subscribe(run.runId, (event) => replay.push(event));
    const finalSnapshot = [...replay].reverse().find((event) => event.type === 'event_snapshot');
    expect(finalSnapshot).toMatchObject({ events: [
      { kind: 'tool_use', id: 'tool-1', name: 'map_get_context', summary: {} },
      { kind: 'tool_result', toolUseId: 'tool-1', status: 'failed', summary: {} },
      { kind: 'run_finished', status: 'succeeded' },
    ] });
    expect(saved?.events).toEqual([
      { kind: 'tool_use', id: 'tool-1', name: 'map_get_context', summary: {} },
      { kind: 'tool_result', toolUseId: 'tool-1', status: 'failed', summary: {} },
      { kind: 'run_finished', status: 'succeeded' },
    ]);
    expect(Object.isFrozen(finalSnapshot)).toBe(true);
    expect(JSON.stringify(replay)).not.toContain('denied');
    expect(JSON.stringify(replay)).not.toContain('nested');
  });

  it('escalates a stubborn process and makes cancellation idempotent', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: (signal?: NodeJS.Signals) => boolean; pid: number };
    child.stdout = new PassThrough(); child.pid = undefined as unknown as number;
    const signals: string[] = []; child.kill = (signal) => { signals.push(signal ?? 'SIGTERM'); return true; };
    const service = createMapDesignRunService({
      store: { getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' }), getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }), appendMessage: () => undefined, updateRunMessage: () => undefined } as never,
      agents: { get: () => ({ id: 'opencode', bin: 'opencode', streamFormat: 'json-event-stream', eventParser: 'opencode', buildArgs: () => ['run'] }), spawn: () => child, stageSkill: async () => undefined },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) }, randomId: () => 'run-1', processStopTimeoutMs: 0,
    });
    const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Cancel.', agentId: 'opencode', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    await expect(service.cancel(run.runId)).resolves.toEqual({ runId: run.runId, status: 'canceled' });
    await expect(service.cancel(run.runId)).resolves.toEqual({ runId: run.runId, status: 'canceled' });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('ignores every runtime frame after an error terminal event', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.pid = 4321; child.kill = () => true;
    const service = createMapDesignRunService({
      store: { getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' }), getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }), appendMessage: () => undefined, updateRunMessage: () => undefined } as never,
      agents: { get: () => ({ id: 'gemini', bin: 'gemini', streamFormat: 'json-event-stream', eventParser: 'gemini', buildArgs: () => ['run'] }), spawn: () => child, stageSkill: async () => undefined },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) }, randomId: () => 'run-1',
    });
    const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Fail.', agentId: 'gemini', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    const events: MapDesignRunEvent[] = []; service.subscribe(run.runId, (event) => events.push(event));
    child.stdout.end('{"type":"error","message":"sk-ant-api03-secret /home/private"}\n{"type":"message","role":"assistant","content":"late one"}\n{"type":"message","role":"assistant","content":"late two"}\n');
    await waitForNextTick();
    expect(events.map((event) => event.type)).toEqual(['event_snapshot', 'message_completed', 'run_finished']);
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(service.get(run.runId)).toMatchObject({ status: 'failed', error: { message: 'The local agent reported an error.' } });
  });

  it('surfaces a redacted provider connection failure in the completed assistant message', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.pid = 4321; child.kill = () => true;
    let saved: Record<string, unknown> | undefined;
    const service = createMapDesignRunService({
      store: { getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' }), getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }), appendMessage: () => undefined, updateRunMessage: (_id: string, patch: Record<string, unknown>) => { saved = patch; }, getAgentSession: () => null, upsertAgentSession: () => undefined } as never,
      agents: { get: () => ({ id: 'codex', bin: 'codex', streamFormat: 'json-event-stream', eventParser: 'codex', buildArgs: () => ['exec'] }), spawn: () => child, stageSkill: async () => undefined },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) }, randomId: () => 'run-1',
    });
    const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Fail.', agentId: 'codex', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    const events: MapDesignRunEvent[] = []; service.subscribe(run.runId, (event) => events.push(event));
    child.stdout.end('{"type":"turn.failed","error":{"message":"error sending request for url (https://chatgpt.com/backend-api/codex/responses)"}}\n');
    await waitForNextTick();

    const expected = { code: 'AGENT_CONNECTION_DROPPED', message: 'The local agent could not connect to its model provider.' };
    expect(service.get(run.runId)).toMatchObject({ status: 'failed', error: expected });
    expect(saved).toMatchObject({ runStatus: 'failed', events: [{ kind: 'run_finished', status: 'failed' }] });
    expect(events.find((event) => event.type === 'message_completed')).toMatchObject({
      message: { id: 'assistant-1', runStatus: 'failed', events: [{ kind: 'run_finished', status: 'failed' }] },
    });
    expect(JSON.stringify(events)).not.toContain('chatgpt.com');
  });

  it('returns the original run for an exact client request replay and rejects mismatches', async () => {
    let spawns = 0;
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.pid = 4321; child.kill = () => true;
    const service = createMapDesignRunService({
      store: { getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' }), getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }), appendMessage: () => undefined, updateRunMessage: () => undefined } as never,
      agents: { get: () => ({ id: 'text', bin: 'text', streamFormat: 'text', buildArgs: () => ['run'] }), spawn: () => { spawns += 1; return child; }, stageSkill: async () => undefined },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) }, randomId: () => 'run-1',
    });
    const request = { projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Improve labels.', agentId: 'text', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' };
    const first = await service.start(request);
    await expect(service.start(request)).resolves.toEqual(first);
    await expect(service.start({ ...request, prompt: 'Different request.' })).rejects.toMatchObject({ name: 'Error' });
    expect(spawns).toBe(1);
  });
  it('replays an exact client request before unavailable dependencies or unreadable configuration', async () => {
    let unavailable = false;
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.pid = 4321; child.kill = () => true;
    const service = createMapDesignRunService({
      store: {
        getProject: () => unavailable ? null : { id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' },
        getConversation: () => unavailable ? null : { id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] },
        appendMessage: () => undefined, updateRunMessage: () => undefined,
      } as never,
      agents: { get: () => unavailable ? null : { id: 'text', bin: 'text', streamFormat: 'text', buildArgs: () => ['run'] }, spawn: () => child, stageSkill: async () => undefined },
      config: { read: () => { if (unavailable) throw new Error('config unavailable'); return {}; } },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) }, randomId: () => 'run-1',
    });
    const request = { projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Improve labels.', agentId: 'text', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' };
    const first = await service.start(request);
    unavailable = true;

    await expect(service.start(request)).resolves.toEqual(first);
    await expect(service.start({ ...request, prompt: 'Different request.' })).rejects.toMatchObject({ name: 'Error' });
  });

  it('retains newest complete history messages within the 64 KiB cap including separators', async () => {
    let prompt = '';
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.pid = 4321; child.kill = () => true;
    const older = 'a'.repeat(32_762);
    const newer = 'b'.repeat(32_762);
    const service = createMapDesignRunService({
      store: {
        getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' }),
        getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [
          { id: 'old', conversationId: 'conversation-1', role: 'user', content: older, events: [], runStatus: 'succeeded', startedAt: 1, endedAt: 1 },
          { id: 'new', conversationId: 'conversation-1', role: 'user', content: newer, events: [], runStatus: 'succeeded', startedAt: 2, endedAt: 2 },
        ] }),
        appendMessage: () => undefined, updateRunMessage: () => undefined,
      } as never,
      agents: { get: () => ({ id: 'text', bin: 'text', streamFormat: 'text', buildArgs: (value: string) => { prompt = value; return ['run']; } }), spawn: () => child, stageSkill: async () => undefined },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) }, randomId: () => 'run-1',
    });

    await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Improve labels.', agentId: 'text', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    expect(prompt).toContain(`user: ${newer}`);
    expect(prompt).not.toContain(`user: ${older}`);
  });

  it('terminalizes a run when stored-session lookup throws', async () => {
    const service = createMapDesignRunService({
      store: { getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' }), getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }), appendMessage: () => undefined, updateRunMessage: () => undefined, getAgentSession: () => { throw new Error('store unavailable'); }, upsertAgentSession: () => undefined } as never,
      agents: { get: () => ({ id: 'claude', bin: 'claude', streamFormat: 'text', resumesSessionViaCli: true, buildArgs: () => ['run'] }), stageSkill: async () => undefined },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({ draftRevision: 4 }) }, randomId: () => 'run-1',
    });
    const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Improve labels.', agentId: 'claude', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });

    expect(service.get(run.runId)).toMatchObject({ status: 'failed', error: { code: 'RUN_FAILED' } });
  });

  it.each(['cancellation', 'shutdown'])('does not stage after %s during delayed context loading', async (action) => {
    let resolveContext!: (value: { draftRevision: number }) => void;
    const context = new Promise<{ draftRevision: number }>((resolve) => { resolveContext = resolve; });
    let stages = 0;
    const service = createMapDesignRunService({
      store: { getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' }), getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }), appendMessage: () => undefined, updateRunMessage: () => undefined, getAgentSession: () => null, upsertAgentSession: () => undefined } as never,
      agents: { get: () => ({ id: 'text', bin: 'text', streamFormat: 'text', buildArgs: () => ['run'] }), stageSkill: async () => { stages += 1; } },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: () => context }, randomId: () => 'run-1',
    });
    const start = service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Improve labels.', agentId: 'text', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    await waitForNextTick();
    if (action === 'cancellation') await service.cancel('run-1');
    else service.shutdown();
    resolveContext({ draftRevision: 4 });
    await start;

    expect(stages).toBe(0);
  });
  it('joins concurrent cancellation until process termination terminalizes the run', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.pid = 4321; child.kill = () => true;
    let releaseStop!: () => void;
    const stop = new Promise<void>((resolve) => { releaseStop = resolve; });
    const service = createMapDesignRunService({
      store: { getProject: () => ({ id: 'map-1', runtime: { kind: 'map' }, workingDirectory: null, primaryConversationId: 'conversation-1' }), getConversation: () => ({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', messages: [] }), appendMessage: () => undefined, updateRunMessage: () => undefined } as never,
      agents: { get: () => ({ id: 'opencode', bin: 'opencode', streamFormat: 'json-event-stream', eventParser: 'opencode', buildArgs: () => ['run'] }), spawn: () => child, stageSkill: async () => undefined },
      toolTokens: new ToolTokenRegistry(), dataDir: '/tmp/data', projectRoot: '/tmp/projects', daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) }, randomId: () => 'run-1', stopProcessTree: async () => stop,
    });
    const run = await service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Cancel.', agentId: 'opencode', clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
    const first = service.cancel(run.runId);
    const second = service.cancel(run.runId);
    let secondSettled = false; void second.then(() => { secondSettled = true; });
    await waitForNextTick();
    expect(secondSettled).toBe(false);
    expect(service.get(run.runId)?.status).toBe('running');
    releaseStop();
    await expect(Promise.all([first, second])).resolves.toEqual([{ runId: run.runId, status: 'canceled' }, { runId: run.runId, status: 'canceled' }]);
  });
  it('bounds each hung Windows taskkill invocation before escalating descendants', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), { pid: 4321, kill: vi.fn(() => true) });
      const invocations: string[][] = [];
      const helpers: Array<ReturnType<typeof vi.fn>> = [];
      const stopping = stopMapDesignProcessTree(child, 0, 'win32', (args) => {
        invocations.push(args);
        const kill = vi.fn(() => true);
        helpers.push(kill);
        return Object.assign(new EventEmitter(), { kill });
      });
      const rejected = expect(stopping).rejects.toThrow('process tree could not be stopped');
      await vi.runAllTimersAsync();
      await rejected;
      expect(invocations).toEqual([['/pid', '4321', '/T'], ['/pid', '4321', '/T', '/F']]);
      expect(helpers.every((kill) => kill.mock.calls.length === 1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('awaits a successful forced taskkill beyond the graceful-stop interval', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), { pid: 4321, kill: vi.fn(() => true) });
      const forced = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
      let settled = false;
      const stopping = stopMapDesignProcessTree(child, 250, 'win32', (args) => {
        if (args.includes('/F')) return forced;
        return Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
      }).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      forced.emit('close', 0);
      await stopping;
      expect(forced.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects when forced taskkill reports failure', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 4321, kill: vi.fn(() => true) });
    await expect(stopMapDesignProcessTree(child, 250, 'win32', () => {
      const helper = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
      queueMicrotask(() => helper.emit('close', 1));
      return helper;
    })).rejects.toThrow('process tree could not be stopped');
  });

  it('does not taskkill an already exited Windows child whose PID may be reused', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: 0, kill: vi.fn(() => true) });
    const spawn = vi.fn(() => Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }));
    await expect(stopMapDesignProcessTree(child, 250, 'win32', spawn)).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('accepts an absent Windows process that exits during taskkill', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4321, exitCode: null, kill: vi.fn(() => true),
    });
    await expect(stopMapDesignProcessTree(child, 250, 'win32', () => {
      const helper = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
      queueMicrotask(() => { child.emit('close', 0); helper.emit('close', 128); });
      return helper;
    })).resolves.toBeUndefined();
  });

  it('awaits taskkill even when its command parent closes first', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), { pid: 4321, kill: vi.fn(() => true) });
      const forced = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
      let settled = false;
      const stopping = stopMapDesignProcessTree(child, 250, 'win32', (args) => {
        if (args.includes('/F')) return forced;
        return Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
      }).then(() => { settled = true; });
      child.emit('close', 0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      forced.emit('close', 0);
      await stopping;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a Windows tree once when taskkill closes the child', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 4321, kill: vi.fn(() => true) });
    const invocations: string[][] = [];
    await stopMapDesignProcessTree(child, 100, 'win32', (args) => {
      invocations.push(args);
      const taskkill = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
      queueMicrotask(() => { child.emit('close', 0); taskkill.emit('close', 0); });
      return taskkill;
    });
    expect(invocations).toEqual([['/pid', '4321', '/T']]);
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('MapDesign native Map Agent selection', () => {
  function nativeRunFixture(options: {
    adapter: MapAgentAdapter | null;
    store?: CreateMapDesignRunServiceDeps['store'];
    runHistory?: CreateMapDesignRunServiceDeps['runHistory'];
    randomId?: CreateMapDesignRunServiceDeps['randomId'];
    cartography?: { id: string; name: string; description: string; version: string; source: string };
    nativeToolRegistry?: MapDesignNativeToolRegistry;
    runtimeChoice?: {
      agentId: string;
      model?: string;
      modelOrigin?: 'catalog' | 'custom';
      reasoning?: string;
      serviceTier?: string;
      revision: number;
      updatedAt: string;
    };
    resolvedRuntime?: {
      agentId: string;
      agentVersion?: string;
      model: string;
      modelOrigin: 'catalog' | 'custom';
      reasoning?: string;
      serviceTier?: string;
      adapter: string;
    };
    sdkToolRuntime?: SdkMapToolRuntime;
    appendMessage?: ReturnType<typeof vi.fn>;
    config?: CreateMapDesignRunServiceDeps['config'];
    inactivityTimeoutMs?: number;
  }) {
    const spawn = vi.fn(() => {
      throw new Error('CLI spawn must not be reached');
    });
    const buildArgs = vi.fn(() => {
      throw new Error('codex exec must not be reached');
    });
    const appendMessage = options.appendMessage ?? vi.fn();
    const updateRunMessage = vi.fn();
    const runtimeChoice = options.runtimeChoice ?? {
      agentId: 'codex',
      revision: 0,
      updatedAt: '2026-09-02T00:00:00.000Z',
    };
    const resolvedRuntime = options.resolvedRuntime ?? {
      agentId: runtimeChoice.agentId,
      model: runtimeChoice.model ?? 'default',
      modelOrigin: runtimeChoice.modelOrigin ?? 'catalog',
      ...(runtimeChoice.reasoning === undefined ? {} : { reasoning: runtimeChoice.reasoning }),
      ...(runtimeChoice.serviceTier === undefined ? {} : { serviceTier: runtimeChoice.serviceTier }),
      adapter: 'codex-app-server',
    };
    const requireCurrent = vi.fn(() => runtimeChoice);
    const resolveChoice = vi.fn(() => resolvedRuntime);
    const toolTokens = new ToolTokenRegistry();
    const getAgent = vi.fn(() => ({
      id: 'codex',
      bin: '/opt/codex/bin/codex',
      streamFormat: 'json-event-stream' as const,
      eventParser: 'codex',
      buildArgs,
      ...(options.inactivityTimeoutMs === undefined
        ? {}
        : { inactivityTimeoutMs: options.inactivityTimeoutMs }),
      mapDesign: {
        nativeToolAdapter: 'codex-app-server' as const,
        publicReasoningSummary: true,
      },
    }));
    const service = createMapDesignRunService({
      store: options.store ?? {
        inTransaction: () => options.cartography,
        getProject: () => ({
          id: 'map-1',
          runtime: { kind: 'map' },
          workingDirectory: '/safe/map-project',
          primaryConversationId: 'conversation-1',
        }),
        getConversation: () => ({
          id: 'conversation-1',
          projectId: 'map-1',
          createdAt: '',
          updatedAt: '',
          messages: [],
        }),
        appendMessage,
        updateRunMessage,
        getAgentSession: () => null,
        upsertAgentSession: () => undefined,
      } as never,
      agents: {
        get: getAgent,
        getMapAgent: () => options.adapter,
        spawn,
        stageSkill: async () => undefined,
      },
      ...(options.nativeToolRegistry ? { nativeToolRegistry: options.nativeToolRegistry } : {}),
      toolTokens,
      dataDir: '/tmp/data',
      projectRoot: '/tmp/projects',
      daemonUrl: () => 'http://127.0.0.1:8787',
      mapContext: { getContext: async () => ({ draftRevision: 4 }) },
      randomId: options.randomId ?? (() => 'run-1'),
      ...(options.runHistory ? { runHistory: options.runHistory } : {}),
      ...(options.config ? { config: options.config } : {}),
      runtimeChoices: { requireCurrent },
      runtimeCatalog: { resolveChoice },
      ...(options.sdkToolRuntime ? { sdkToolRuntime: options.sdkToolRuntime } : {}),
    });
    return {
      appendMessage,
      buildArgs,
      getAgent,
      requireCurrent,
      resolveChoice,
      service,
      spawn,
      toolTokens,
      updateRunMessage,
    };
  }

  it('sends the complete selected cartography to both fresh and resumed runs', async () => {
    const source = `---\nversion: "0.4.0"\nname: Atlas\n---\n## Overview\n${'Quiet ink. '.repeat(1000)}\nFINAL_COLOR: #123456`;
    const adapter: MapAgentAdapter = {
      id: 'codex', capabilities: { nativeMapTools: true, publicReasoningSummary: true },
      startMapRun: vi.fn(async () => ({ done: Promise.resolve({ status: 'succeeded' as const }), cancel: async () => undefined })),
    };
    const state = nativeRunFixture({ adapter, nativeToolRegistry: fixtureNativeToolRegistry,
      cartography: { id: 'a'.repeat(64), name: 'Atlas', description: '', version: '0.4.0', source } });
    try {
      await state.service.start({ projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Style the roads.',
        runtimeRevision: 0, clientRequestId: 'cartography-run', userMessageId: 'user-carto', assistantMessageId: 'assistant-carto' });
      expect(adapter.startMapRun).toHaveBeenCalledWith(expect.objectContaining({
        prompt: expect.stringContaining('FINAL_COLOR: #123456'),
        resumePrompt: expect.stringContaining('FINAL_COLOR: #123456'),
      }), expect.any(Array), expect.any(Function));
    } finally { await state.service.shutdown(); }
  });

  function unsupportedNativeRunFixture(agent: {
    id: string;
    streamFormat: string;
    eventParser?: string;
    mapDesign?: { nativeToolAdapter: null; publicReasoningSummary: boolean };
  }) {
    const buildArgs = vi.fn(() => ['legacy-agent-command']);
    const spawn = vi.fn(() => {
      throw new Error('legacy agent CLI must not be reached');
    });
    const getMapAgent = vi.fn(() => null);
    const appendMessage = vi.fn();
    const getContext = vi.fn(async () => ({ draftRevision: 4 }));
    const stageSkill = vi.fn(async () => undefined);
    const toolTokens = new ToolTokenRegistry();
    const mint = vi.spyOn(toolTokens, 'mint');
    const service = createMapDesignRunService({
      store: {
        getProject: () => ({
          id: 'map-1',
          runtime: { kind: 'map' },
          workingDirectory: '/safe/map-project',
          primaryConversationId: 'conversation-1',
        }),
        getConversation: () => ({
          id: 'conversation-1',
          projectId: 'map-1',
          createdAt: '',
          updatedAt: '',
          messages: [],
        }),
        appendMessage,
        updateRunMessage: () => undefined,
      } as never,
      agents: {
        get: () => ({
          ...agent,
          bin: `/opt/${agent.id}/bin/${agent.id}`,
          buildArgs,
        }),
        getMapAgent,
        spawn,
        stageSkill,
      },
      nativeToolRegistry: {
        definitions: () => [],
        call: vi.fn(),
      },
      toolTokens,
      dataDir: '/tmp/data',
      projectRoot: '/tmp/projects',
      daemonUrl: () => 'http://127.0.0.1:8787',
      mapContext: { getContext },
      randomId: () => 'run-1',
    });
    return { appendMessage, buildArgs, getContext, getMapAgent, mint, service, spawn, stageSkill };
  }

  it('routes a declared Codex Map Studio Run only through the native adapter', async () => {
    const definitions = [{
      name: 'map_inspect' as const,
      description: 'Inspect the map.',
      inputSchema: { type: 'object' },
    }];
    const nativeToolRegistry: MapDesignNativeToolRegistry = {
      definitions: () => definitions,
      call: vi.fn(),
    };
    let publish!: (event: MapAgentEvent) => void;
    let finishDone!: (value: { status: 'succeeded' }) => void;
    const done = new Promise<{ status: 'succeeded' }>((resolve) => {
      finishDone = resolve;
    });
    const cancel = vi.fn(async () => undefined);
    const adapter: MapAgentAdapter = {
      id: 'codex',
      capabilities: { nativeMapTools: true, publicReasoningSummary: true },
      startMapRun: vi.fn(async (_input, _tools, onEvent) => {
        publish = onEvent;
        return { done, cancel };
      }),
    };
    const state = nativeRunFixture({ adapter, nativeToolRegistry });

    const response = await state.service.start({
      projectId: 'map-1',
      conversationId: 'conversation-1',
      prompt: 'Inspect labels.',
      runtimeRevision: 0,
      clientRequestId: 'request-1',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
    });

    expect(response.status).toBe('running');
    expect(adapter.startMapRun).toHaveBeenCalledOnce();
    expect(adapter.startMapRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        projectId: 'map-1',
        conversationId: 'conversation-1',
        cwd: '/safe/map-project',
        model: 'default',
        reasoning: null,
        serviceTier: null,
        prompt: expect.stringContaining('user: Inspect labels.'),
        signal: expect.any(AbortSignal),
      }),
      definitions,
      expect.any(Function),
    );
    expect(state.buildArgs).not.toHaveBeenCalled();
    expect(state.spawn).not.toHaveBeenCalled();

    publish({ kind: 'thinking', text: 'Checking labels.' });
    publish({ kind: 'text', text: 'Two labels need work.' });
    publish({ kind: 'run_finished', status: 'succeeded' });
    finishDone({ status: 'succeeded' });
    await waitForNextTick();

    expect(state.service.get('run-1')).toMatchObject({ status: 'succeeded' });
    const replay: MapDesignRunEvent[] = [];
    state.service.subscribe('run-1', (event) => replay.push(event));
    expect(replay.filter((event) => event.type === 'event_snapshot').at(-1)).toMatchObject({
      events: [
        { kind: 'thinking', text: 'Checking labels.' },
        { kind: 'text', text: 'Two labels need work.' },
        { kind: 'run_finished', status: 'succeeded' },
      ],
    });
  });

  it('replays only the latest authoritative snapshot to a late subscriber', async () => {
    const nativeToolRegistry: MapDesignNativeToolRegistry = {
      definitions: () => [],
      call: vi.fn(),
    };
    let publish!: (event: MapAgentEvent) => void;
    let finishDone!: (value: { status: 'succeeded' }) => void;
    const done = new Promise<{ status: 'succeeded' }>((resolve) => { finishDone = resolve; });
    const adapter: MapAgentAdapter = {
      id: 'codex',
      capabilities: { nativeMapTools: true, publicReasoningSummary: true },
      startMapRun: vi.fn(async (_input, _tools, onEvent) => {
        publish = onEvent;
        return { done, cancel: async () => undefined };
      }),
    };
    const state = nativeRunFixture({ adapter, nativeToolRegistry });
    await state.service.start({
      projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Stream the analysis.',
      runtimeRevision: 0, clientRequestId: 'request-replay',
      userMessageId: 'user-replay', assistantMessageId: 'assistant-replay',
    });

    publish({ kind: 'thinking', text: 'Inspecting.' });
    state.service.subscribe('run-1', () => undefined)();
    publish({ kind: 'text', text: 'Result.' });

    const replay: MapDesignRunEvent[] = [];
    const unsubscribe = state.service.subscribe('run-1', (event) => replay.push(event));
    expect(replay).toEqual([expect.objectContaining({
      type: 'event_snapshot',
      events: [
        { kind: 'thinking', text: 'Inspecting.' },
        { kind: 'text', text: 'Result.' },
      ],
    })]);

    unsubscribe();
    finishDone({ status: 'succeeded' });
    await waitForNextTick();
  });

  it('loads the conversation choice by runtime revision and persists resolved provenance before adapter start', async () => {
    const nativeToolRegistry: MapDesignNativeToolRegistry = {
      definitions: () => [],
      call: vi.fn(),
    };
    const adapter: MapAgentAdapter = {
      id: 'codex',
      capabilities: { nativeMapTools: true, publicReasoningSummary: true },
      startMapRun: vi.fn(async () => ({
        done: new Promise<never>(() => undefined),
        cancel: async () => undefined,
      })),
    };
    const runtimeChoice = {
      agentId: 'codex',
      model: 'saved-model',
      modelOrigin: 'custom' as const,
      reasoning: 'high',
      serviceTier: 'priority',
      revision: 7,
      updatedAt: '2026-09-02T01:00:00.000Z',
    };
    const resolvedRuntime = {
      agentId: 'codex',
      agentVersion: '0.123.0',
      model: 'resolved-model',
      modelOrigin: 'custom' as const,
      reasoning: 'xhigh',
      serviceTier: 'priority',
      adapter: 'codex-app-server',
    };
    const state = nativeRunFixture({
      adapter,
      nativeToolRegistry,
      runtimeChoice,
      resolvedRuntime,
      config: {
        read: () => ({
          agentModels: { codex: { model: 'config-must-not-win', reasoning: 'low', serviceTier: 'flex' } },
          byokProviders: { default: { protocol: 'openai', apiKey: 'persisted-secret', model: 'provider-must-not-win' } },
        }),
      },
    });

    await state.service.start({
      projectId: 'map-1',
      conversationId: 'conversation-1',
      prompt: 'Use the saved runtime.',
      runtimeRevision: 7,
      byokProvider: { protocol: 'openai', apiKey: 'request-only-secret' },
      clientRequestId: 'request-authoritative',
      userMessageId: 'user-authoritative',
      assistantMessageId: 'assistant-authoritative',
    });

    expect(state.requireCurrent).toHaveBeenCalledWith('map-1', 'conversation-1', 7);
    expect(state.resolveChoice).toHaveBeenCalledWith('codex', runtimeChoice);
    expect(state.getAgent).toHaveBeenCalledWith('codex');
    expect(state.appendMessage).toHaveBeenNthCalledWith(2, {
      runId: 'run-1',
      message: expect.objectContaining({
        id: 'assistant-authoritative',
        role: 'assistant',
        runtime: resolvedRuntime,
      }),
    });
    expect(adapter.startMapRun).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'resolved-model',
        reasoning: 'xhigh',
        serviceTier: 'priority',
        resumePrompt: 'Use the saved runtime.',
        byokProvider: { protocol: 'openai', apiKey: 'request-only-secret' },
        toolRuntime: expect.any(Object),
        toolCallback: expect.objectContaining({
          url: 'http://127.0.0.1:8787/api/map-design/tools',
          token: expect.stringMatching(/^odtt_/u),
          close: expect.any(Function),
        }),
      }),
      [],
      expect.any(Function),
    );
    expect(state.appendMessage.mock.invocationCallOrder[1])
      .toBeLessThan((adapter.startMapRun as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
    expect(state.service.getGrant('run-1')).toMatchObject({
      runId: 'run-1',
      projectId: 'map-1',
      conversationId: 'conversation-1',
      agentId: 'codex',
    });
    expect(state.service.getTrustedRun('run-1')).toEqual({
      runId: 'run-1',
      projectId: 'map-1',
      runtime: { id: 'codex', version: '0.123.0', adapter: 'codex-app-server' },
      model: { id: 'resolved-model', provider: 'codex' },
    });
    expect(JSON.stringify(state.appendMessage.mock.calls)).not.toContain('request-only-secret');
    const startMapRun = adapter.startMapRun as ReturnType<typeof vi.fn>;
    const adapterInput = startMapRun.mock.calls[0]?.[0] as MapRunInput;
    expect(adapterInput.toolCallback.url).not.toContain(adapterInput.toolCallback.token);
  });

  it('uses the normalized effective Agent for Run lookup while retaining the stored runtime revision guard', async () => {
    const adapter: MapAgentAdapter = {
      id: 'codex',
      capabilities: { nativeMapTools: true, publicReasoningSummary: true },
      startMapRun: vi.fn(async () => ({
        done: new Promise<never>(() => undefined),
        cancel: async () => undefined,
      })),
    };
    const runtimeChoice = {
      agentId: 'retired-agent',
      model: 'provider/retired',
      revision: 9,
      updatedAt: '2026-09-03T00:00:00.000Z',
    };
    const state = nativeRunFixture({
      adapter,
      nativeToolRegistry: { definitions: () => [], call: vi.fn() },
      runtimeChoice,
      resolvedRuntime: {
        agentId: 'codex',
        model: 'gpt-5.5',
        modelOrigin: 'catalog',
        adapter: 'codex-app-server',
      },
    });

    await state.service.start({
      projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Use the safe runtime.', runtimeRevision: 9,
      clientRequestId: 'request-normalized-agent', userMessageId: 'user-normalized-agent', assistantMessageId: 'assistant-normalized-agent',
    });

    expect(state.requireCurrent).toHaveBeenCalledWith('map-1', 'conversation-1', 9);
    expect(state.resolveChoice).toHaveBeenCalledWith('retired-agent', runtimeChoice);
    expect(state.getAgent).toHaveBeenCalledWith('codex');
    expect(adapter.startMapRun).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.5' }),
      [],
      expect.any(Function),
    );
  });

  it('keeps idempotency sensitive to runtimeRevision without consulting a changed choice', async () => {
    const adapter: MapAgentAdapter = {
      id: 'codex',
      capabilities: { nativeMapTools: true, publicReasoningSummary: true },
      startMapRun: async () => ({ done: new Promise(() => undefined), cancel: async () => undefined }),
    };
    const state = nativeRunFixture({
      adapter,
      nativeToolRegistry: { definitions: () => [], call: vi.fn() },
    });
    const request = {
      projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Inspect.', runtimeRevision: 0,
      clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1',
    };
    await state.service.start(request);

    await expect(state.service.start({ ...request, runtimeRevision: 1 }))
      .rejects.toBeInstanceOf(MapDesignRunConflictError);
    expect(state.requireCurrent).toHaveBeenCalledTimes(1);
  });

  it('revokes the callback grant if assistant provenance persistence fails before adapter start', async () => {
    const appendMessage = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('storage unavailable'); });
    const sdkToolRuntime = createSdkMapToolRuntime({ definitions: () => [], call: vi.fn() });
    const closeRun = vi.spyOn(sdkToolRuntime, 'closeRun');
    const state = nativeRunFixture({
      adapter: {
        id: 'codex',
        capabilities: { nativeMapTools: true, publicReasoningSummary: true },
        startMapRun: vi.fn(),
      },
      nativeToolRegistry: { definitions: () => [], call: vi.fn() },
      sdkToolRuntime,
      appendMessage,
    });

    await expect(state.service.start({
      projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Persist provenance.', runtimeRevision: 0,
      clientRequestId: 'request-persist', userMessageId: 'user-persist', assistantMessageId: 'assistant-persist',
    })).rejects.toThrow('storage unavailable');

    expect(closeRun).toHaveBeenCalledWith('run-1');
    expect(state.toolTokens.activeRunTokenCount('run-1')).toBe(0);
    expect(state.service.get('run-1')).toBeNull();
  });

  it('closes the SDK runtime and revokes the callback grant before publishing terminal events', async () => {
    let finishDone!: (value: { status: 'succeeded' }) => void;
    let publish!: (event: MapAgentEvent) => void;
    const done = new Promise<{ status: 'succeeded' }>((resolve) => { finishDone = resolve; });
    const adapter: MapAgentAdapter = {
      id: 'codex',
      capabilities: { nativeMapTools: true, publicReasoningSummary: true },
      startMapRun: async (_input, _tools, onEvent) => {
        publish = onEvent;
        return { done, cancel: async () => undefined };
      },
    };
    const sdkToolRuntime = createSdkMapToolRuntime({ definitions: () => [], call: vi.fn() });
    const closeRun = vi.spyOn(sdkToolRuntime, 'closeRun');
    const state = nativeRunFixture({
      adapter,
      nativeToolRegistry: { definitions: () => [], call: vi.fn() },
      sdkToolRuntime,
    });
    // The fixture owns its registry; observe lifecycle through the public grant and SDK close.
    const terminalState: Array<{ grantPresent: boolean; runtimeClosed: boolean }> = [];
    const run = await state.service.start({
      projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Finish.', runtimeRevision: 0,
      clientRequestId: 'request-close', userMessageId: 'user-close', assistantMessageId: 'assistant-close',
    });
    state.service.subscribe(run.runId, (event) => {
      if (event.type === 'run_finished') {
        terminalState.push({
          grantPresent: state.service.getGrant(run.runId) !== null
            && state.toolTokens.activeRunTokenCount(run.runId) > 0,
          runtimeClosed: closeRun.mock.calls.some(([runId]) => runId === run.runId),
        });
      }
    });
    finishDone({ status: 'succeeded' });
    await waitForNextTick();
    publish({ kind: 'text', text: 'late text' });

    expect(closeRun).toHaveBeenCalledWith('run-1');
    expect(terminalState).toEqual([{ grantPresent: false, runtimeClosed: true }]);
    expect(state.updateRunMessage.mock.calls.at(-1)?.[1]).not.toMatchObject({ content: 'late text' });
  });

  it('times out a silent native Run and closes authority before releasing the project lock', async () => {
    vi.useFakeTimers();
    let resolveDone!: (value: { status: 'canceled' }) => void;
    const done = new Promise<{ status: 'canceled' }>((resolve) => { resolveDone = resolve; });
    const cancel = vi.fn(async () => { resolveDone({ status: 'canceled' }); });
    const adapter: MapAgentAdapter = {
      id: 'codex',
      capabilities: { nativeMapTools: true, publicReasoningSummary: true },
      startMapRun: async () => ({ done, cancel }),
    };
    const sdkToolRuntime = createSdkMapToolRuntime({ definitions: () => [], call: vi.fn() });
    const closeRun = vi.spyOn(sdkToolRuntime, 'closeRun');
    const state = nativeRunFixture({
      adapter,
      nativeToolRegistry: { definitions: () => [], call: vi.fn() },
      sdkToolRuntime,
      inactivityTimeoutMs: 50,
    });
    const terminalEvents: MapDesignRunEvent[] = [];
    try {
      const run = await state.service.start({
        projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Stay silent.', runtimeRevision: 0,
        clientRequestId: 'request-timeout', userMessageId: 'user-timeout', assistantMessageId: 'assistant-timeout',
      });
      state.service.subscribe(run.runId, (event) => {
        if (event.type === 'run_finished') terminalEvents.push(event);
      });

      await vi.advanceTimersByTimeAsync(51);

      expect(state.service.get(run.runId)).toMatchObject({
        status: 'failed',
        error: { code: 'RUN_TIMED_OUT', message: 'The local agent stopped responding.' },
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(closeRun).toHaveBeenCalledWith(run.runId);
      expect(state.toolTokens.activeRunTokenCount(run.runId)).toBe(0);
      expect(state.service.isProjectRunning('map-1')).toBe(false);
      expect(terminalEvents).toHaveLength(1);
    } finally {
      await state.service.shutdown();
      vi.useRealTimers();
    }
  });

  it.each([false, true])('keeps a timed-out execution locked and joins cleanup on shutdown (pending handshake: %s)', async (pendingHandshake) => {
    vi.useFakeTimers();
    let releaseStop!: () => void;
    let resolveDone!: (value: { status: 'canceled' }) => void;
    const stopping = new Promise<void>((resolve) => { releaseStop = resolve; });
    const done = new Promise<{ status: 'canceled' }>((resolve) => { resolveDone = resolve; });
    const cancel = vi.fn(async () => {
      resolveDone({ status: 'canceled' });
      await stopping;
    });
    const handle = { done, cancel };
    let resolveStart!: (value: typeof handle) => void;
    const handshake = new Promise<typeof handle>((resolve) => { resolveStart = resolve; });
    const startMapRun = vi.fn(async () => pendingHandshake ? handshake : handle);
    const state = nativeRunFixture({
      adapter: { id: 'codex', capabilities: { nativeMapTools: true, publicReasoningSummary: true }, startMapRun },
      nativeToolRegistry: { definitions: () => [], call: vi.fn() },
      inactivityTimeoutMs: 50,
    });
    const request = {
      projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Stay silent.', runtimeRevision: 0,
      clientRequestId: 'request-timeout', userMessageId: 'user-timeout', assistantMessageId: 'assistant-timeout',
    };
    const starting = state.service.start(request);
    let shutdown: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(startMapRun).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(51);
      expect(state.service.get('run-1')).toMatchObject({ status: 'failed', error: { code: 'RUN_TIMED_OUT' } });
      expect(state.toolTokens.activeRunTokenCount('run-1')).toBe(0);
      expect(state.service.isProjectRunning('map-1')).toBe(true);
      expect(state.service.isConversationRunning('conversation-1')).toBe(true);
      await expect(state.service.start({ ...request, clientRequestId: 'request-next' })).rejects.toBeInstanceOf(MapDesignProjectRunConflictError);

      let stopped = false;
      shutdown = state.service.shutdown().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      resolveStart(handle);
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledOnce();
      expect(stopped).toBe(false);

      releaseStop();
      await Promise.all([starting, shutdown]);
      expect(stopped).toBe(true);
      expect(state.service.isProjectRunning('map-1')).toBe(false);
      expect(state.service.isConversationRunning('conversation-1')).toBe(false);
      expect(state.service.get('run-1')?.status).toBe('failed');
    } finally {
      resolveStart(handle);
      releaseStop();
      await starting;
      await (shutdown ?? state.service.shutdown());
      vi.useRealTimers();
    }
  });

  it('retains timed-out executions until cleanup, then permits the next project run and durable replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'map-timeout-retention-'));
    const database = openMapDesignDatabase(root);
    vi.useFakeTimers();
    let releaseStop!: () => void;
    const stopping = new Promise<void>((resolve) => { releaseStop = resolve; });
    const startMapRun = vi.fn<MapAgentAdapter['startMapRun']>()
      .mockResolvedValueOnce({ done: stopping.then(() => ({ status: 'canceled' as const })), cancel: () => stopping })
      .mockResolvedValue({ done: Promise.resolve({ status: 'succeeded' }), cancel: async () => undefined });
    const store = createMapDesignLocalStore(database);
    store.createProject({ project: { projectId: 'map-1', title: 'Map', runtime: { agentId: 'codex' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Inspect', idempotencyKey: 'create' }, primaryConversationId: 'conversation-1', verifiedWorkingDirectory: null });
    const history = createMapRunHistory(database);
    let nextId = 0;
    const state = nativeRunFixture({
      store, runHistory: history, randomId: () => `run-${++nextId}`,
      adapter: { id: 'codex', capabilities: { nativeMapTools: true, publicReasoningSummary: true }, startMapRun },
      nativeToolRegistry: { definitions: () => [], call: vi.fn() },
      inactivityTimeoutMs: 50,
    });
    const request = {
      projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Stay silent.', runtimeRevision: 0,
      clientRequestId: 'request-timeout', userMessageId: 'user-timeout', assistantMessageId: 'assistant-timeout',
    };
    try {
      await state.service.start(request);
      await vi.advanceTimersByTimeAsync(51);
      expect(history.get('run-1')?.response.error?.code).toBe('RUN_TIMED_OUT');
      expect(state.service.get('run-1')?.status).toBe('failed');
      expect(state.service.isProjectRunning('map-1')).toBe(true);
      const next = { ...request, clientRequestId: 'request-next', userMessageId: 'user-next', assistantMessageId: 'assistant-next' };
      await expect(state.service.start(next)).rejects.toBeInstanceOf(MapDesignProjectRunConflictError);
      releaseStop();
      await state.service.cancel('run-1');
      expect(state.service.getGrant('run-1')).toBeNull();
      expect(state.service.isProjectRunning('map-1')).toBe(false);
      expect(await state.service.start(request)).toMatchObject({ runId: 'run-1', status: 'failed' });
      expect(startMapRun).toHaveBeenCalledOnce();
      expect(await state.service.start(next)).toMatchObject({ runId: 'run-2' });
      expect(startMapRun).toHaveBeenCalledTimes(2);
    } finally {
      releaseStop();
      await state.service.shutdown();
      vi.useRealTimers();
      closeMapDesignDatabase(database);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resets inactivity only for bounded adapter and callback progress', async () => {
    vi.useFakeTimers();
    let publish!: (event: MapAgentEvent) => void;
    let resolveDone!: (value: { status: 'canceled' }) => void;
    const done = new Promise<{ status: 'canceled' }>((resolve) => { resolveDone = resolve; });
    const adapter: MapAgentAdapter = {
      id: 'codex',
      capabilities: { nativeMapTools: true, publicReasoningSummary: true },
      startMapRun: async (_input, _tools, onEvent) => {
        publish = onEvent;
        return { done, cancel: async () => resolveDone({ status: 'canceled' }) };
      },
    };
    const state = nativeRunFixture({
      adapter,
      nativeToolRegistry: { definitions: () => [], call: vi.fn() },
      inactivityTimeoutMs: 50,
    });
    try {
      const run = await state.service.start({
        projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Report progress.', runtimeRevision: 0,
        clientRequestId: 'request-activity', userMessageId: 'user-activity', assistantMessageId: 'assistant-activity',
      });
      await vi.advanceTimersByTimeAsync(40);
      publish({ kind: 'status', label: 'analyzing' });
      await vi.advanceTimersByTimeAsync(40);
      publish({ kind: 'tool_use', id: 'tool-1', name: 'map_validate', summary: {} });
      await vi.advanceTimersByTimeAsync(40);
      state.service.noteActivity(run.runId);
      await vi.advanceTimersByTimeAsync(40);
      publish({ kind: 'tool_result', toolUseId: 'tool-1', status: 'succeeded', summary: { valid: true } });
      await vi.advanceTimersByTimeAsync(40);
      expect(state.service.get(run.runId)?.status).toBe('running');

      publish({ kind: 'tool_result', toolUseId: 'orphan', status: 'succeeded', summary: {} });
      await vi.advanceTimersByTimeAsync(11);
      expect(state.service.get(run.runId)).toMatchObject({ status: 'failed', error: { code: 'RUN_TIMED_OUT' } });
    } finally {
      await state.service.shutdown();
      vi.useRealTimers();
    }
  });

  it.each(['cancel', 'shutdown'] as const)('lets %s win a watchdog deadline race exactly once', async (action) => {
    vi.useFakeTimers();
    let resolveDone!: (value: { status: 'canceled' }) => void;
    const done = new Promise<{ status: 'canceled' }>((resolve) => { resolveDone = resolve; });
    const cancel = vi.fn(async () => { resolveDone({ status: 'canceled' }); });
    const adapter: MapAgentAdapter = {
      id: 'codex',
      capabilities: { nativeMapTools: true, publicReasoningSummary: true },
      startMapRun: async () => ({ done, cancel }),
    };
    const state = nativeRunFixture({
      adapter,
      nativeToolRegistry: { definitions: () => [], call: vi.fn() },
      inactivityTimeoutMs: 50,
    });
    const events: MapDesignRunEvent[] = [];
    try {
      const run = await state.service.start({
        projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Race.', runtimeRevision: 0,
        clientRequestId: `request-${action}`, userMessageId: `user-${action}`, assistantMessageId: `assistant-${action}`,
      });
      state.service.subscribe(run.runId, (event) => {
        if (event.type === 'run_finished') events.push(event);
      });
      await vi.advanceTimersByTimeAsync(49);
      const operation = action === 'cancel'
        ? state.service.cancel(run.runId)
        : state.service.shutdown();
      await vi.advanceTimersByTimeAsync(1);
      await operation;

      expect(state.service.get(run.runId)?.status).toBe('canceled');
      expect(cancel).toHaveBeenCalledOnce();
      expect(events).toHaveLength(1);
    } finally {
      await state.service.shutdown();
      vi.useRealTimers();
    }
  });

  it('preserves a safe native failure from done after the adapter emits its terminal event', async () => {
    const nativeToolRegistry: MapDesignNativeToolRegistry = {
      definitions: () => [],
      call: vi.fn(),
    };
    let publish!: (event: MapAgentEvent) => void;
    let finishDone!: (value: {
      status: 'failed';
      error: { code: string; message: string };
    }) => void;
    const done = new Promise<{
      status: 'failed';
      error: { code: string; message: string };
    }>((resolve) => {
      finishDone = resolve;
    });
    const adapter: MapAgentAdapter = {
      id: 'codex',
      capabilities: { nativeMapTools: true, publicReasoningSummary: true },
      startMapRun: async (_input, _tools, onEvent) => {
        publish = onEvent;
        return { done, cancel: async () => undefined };
      },
    };
    const state = nativeRunFixture({ adapter, nativeToolRegistry });

    await state.service.start({
      projectId: 'map-1',
      conversationId: 'conversation-1',
      prompt: 'Inspect.',
      agentId: 'codex',
      clientRequestId: 'request-1',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
    });
    publish({ kind: 'run_finished', status: 'failed' });
    finishDone({
      status: 'failed',
      error: {
        code: 'RUN_FAILED',
        message: 'The Codex app-server connection ended unexpectedly.',
      },
    });
    await waitForNextTick();

    expect(state.service.get('run-1')).toMatchObject({
      status: 'failed',
      error: {
        code: 'RUN_FAILED',
        message: 'The Codex app-server connection ended unexpectedly.',
      },
    });
  });

  it('delegates cancellation to the native handle without touching a CLI process', async () => {
    const nativeToolRegistry: MapDesignNativeToolRegistry = {
      definitions: () => [],
      call: vi.fn(),
    };
    let finishDone!: (value: { status: 'canceled' }) => void;
    const done = new Promise<{ status: 'canceled' }>((resolve) => { finishDone = resolve; });
    const cancel = vi.fn(async () => { finishDone({ status: 'canceled' }); });
    const adapter: MapAgentAdapter = {
      id: 'codex',
      capabilities: { nativeMapTools: true, publicReasoningSummary: true },
      startMapRun: async () => ({ done, cancel }),
    };
    const state = nativeRunFixture({ adapter, nativeToolRegistry });
    await state.service.start({
      projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Cancel.', agentId: 'codex',
      clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1',
    });

    await expect(state.service.cancel('run-1')).resolves.toEqual({ runId: 'run-1', status: 'canceled' });

    expect(cancel).toHaveBeenCalledOnce();
    expect(state.spawn).not.toHaveBeenCalled();
    expect(state.service.get('run-1')).toMatchObject({ status: 'canceled' });
  });

  it('persists a preview result that becomes durable while cancellation is waiting', async () => {
    const nativeToolRegistry: MapDesignNativeToolRegistry = {
      definitions: () => [],
      call: vi.fn(),
    };
    let publish!: (event: MapAgentEvent) => void;
    let finishDone!: (value: { status: 'succeeded' }) => void;
    let releasePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => { releasePersistence = resolve; });
    const done = new Promise<{ status: 'succeeded' }>((resolve) => { finishDone = resolve; });
    const adapter: MapAgentAdapter = {
      id: 'codex',
      capabilities: { nativeMapTools: true, publicReasoningSummary: true },
      startMapRun: async (_input, _tools, onEvent) => {
        publish = onEvent;
        return {
          done,
          cancel: async () => {
            await persistence;
            publish({
              kind: 'tool_result',
              toolUseId: 'preview-call',
              status: 'succeeded',
              summary: { previewId: 'preview-1' },
            });
            finishDone({ status: 'succeeded' });
          },
        };
      },
    };
    const state = nativeRunFixture({ adapter, nativeToolRegistry });
    await state.service.start({
      projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Preview.', agentId: 'codex',
      clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1',
    });
    publish({ kind: 'tool_use', id: 'preview-call', name: 'map_render_preview', summary: {} });

    const cancellation = state.service.cancel('run-1');
    let settled = false;
    void cancellation.then(() => { settled = true; });
    await waitForNextTick();
    expect(settled).toBe(false);
    releasePersistence();

    await expect(cancellation).resolves.toMatchObject({ runId: 'run-1', status: 'succeeded' });
    expect(state.service.get('run-1')).toMatchObject({ status: 'succeeded' });
    expect(state.updateRunMessage.mock.calls.at(-1)?.[1]).toMatchObject({
      runStatus: 'succeeded',
      events: [
        { kind: 'tool_use', id: 'preview-call', name: 'map_render_preview' },
        { kind: 'tool_result', toolUseId: 'preview-call', status: 'succeeded' },
        { kind: 'run_finished', status: 'succeeded' },
      ],
    });
  });

  it.each([
    ['adapter factory', { adapter: null, nativeToolRegistry: { definitions: () => [], call: vi.fn() } as MapDesignNativeToolRegistry }],
    ['native registry', { adapter: {
      id: 'codex',
      capabilities: { nativeMapTools: true, publicReasoningSummary: true },
      startMapRun: vi.fn(),
    } as MapAgentAdapter }],
  ])('fails closed when the concrete %s is unavailable and never falls back to codex exec', async (_name, options) => {
    const state = nativeRunFixture(options);

    await expect(state.service.start({
      projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Inspect.', agentId: 'codex',
      clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1',
    })).rejects.toBeInstanceOf(MapDesignRunRequestError);

    expect(state.service.get('run-1')).toBeNull();
    expect(state.buildArgs).not.toHaveBeenCalled();
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'Kimi ACP',
      agent: {
        id: 'kimi',
        streamFormat: 'acp-json-rpc',
        mapDesign: { nativeToolAdapter: null, publicReasoningSummary: true },
      },
    },
    {
      name: 'BYOK OpenCode provider-functions',
      agent: {
        id: 'byok-opencode',
        streamFormat: 'json-event-stream',
        eventParser: 'opencode',
        mapDesign: { nativeToolAdapter: null, publicReasoningSummary: false },
      },
    },
    {
      name: 'an undeclared injected runtime',
      agent: {
        id: 'unregistered-runtime',
        streamFormat: 'json-event-stream',
        eventParser: 'opencode',
      },
    },
  ])('does not select or spawn $name when its native Map adapter is unavailable', async ({ agent }) => {
    const state = unsupportedNativeRunFixture(agent);

    await expect(state.service.start({
      projectId: 'map-1',
      conversationId: 'conversation-1',
      prompt: 'Inspect the map.',
      agentId: agent.id,
      clientRequestId: `request-${agent.id}`,
      userMessageId: `user-${agent.id}`,
      assistantMessageId: `assistant-${agent.id}`,
    })).rejects.toBeInstanceOf(MapDesignRunRequestError);

    expect(state.service.get('run-1')).toBeNull();
    expect(state.getMapAgent).toHaveBeenCalledWith(agent.id);
    expect(state.appendMessage).not.toHaveBeenCalled();
    expect(state.mint).not.toHaveBeenCalled();
    expect(state.getContext).not.toHaveBeenCalled();
    expect(state.stageSkill).not.toHaveBeenCalled();
    expect(state.buildArgs).not.toHaveBeenCalled();
    expect(state.spawn).not.toHaveBeenCalled();
  });
});


it('evicts completed runs from memory while preserving durable replay, SSE and provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'map-run-history-')); const database = openMapDesignDatabase(root);
  try {
    const store = createMapDesignLocalStore(database);
    store.createProject({ project: { projectId: 'map-1', title: 'Map', runtime: { agentId: 'codex' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Inspect', idempotencyKey: 'create' }, primaryConversationId: 'conversation-1', verifiedWorkingDirectory: null });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.kill = () => true; child.pid = 4321;
    const history = createMapRunHistory(database);
    const spawn = vi.fn(() => child);
    const service = createMapDesignRunService({ store, runHistory: history, retainedRunLimit: 0,
      agents: { get: () => ({ id: 'codex', bin: 'codex', streamFormat: 'json-event-stream', eventParser: 'codex', buildArgs: () => ['exec'] }), spawn, stageSkill: async () => undefined },
      toolTokens: new ToolTokenRegistry(), dataDir: root, projectRoot: root, daemonUrl: () => 'http://localhost', mapContext: { getContext: async () => ({}) }, randomId: () => 'run-history',
    });
    const request = { projectId: 'map-1', conversationId: 'conversation-1', prompt: 'Inspect', agentId: 'codex', clientRequestId: 'request-history', userMessageId: 'user-history', assistantMessageId: 'assistant-history' };
    const run = await service.start(request);
    child.stdout.write('{"type":"turn.started"}\n');
    child.stdout.write('{"type":"item.completed","item":{"id":"message","type":"agent_message","text":"Inspection complete."}}\n');
    child.stdout.end(); child.emit('close', 0); await waitForNextTick();
    expect(service.getGrant(run.runId)).toBeNull();
    expect(service.get(run.runId)?.status).toBe('succeeded');
    expect(await service.start(request)).toMatchObject({ runId: run.runId, status: 'succeeded' }); expect(spawn).toHaveBeenCalledOnce();
    await expect(service.start({ ...request, prompt: 'Different' })).rejects.toThrow(MapDesignRunConflictError);
    const events: MapDesignRunEvent[] = []; service.subscribe(run.runId, (event) => events.push(event));
    expect(events.map((event) => event.type)).toEqual(['message_completed', 'run_finished']);
    expect(service.getTrustedRun(run.runId)).toMatchObject({ runId: run.runId, runtime: { id: 'codex' } });
    const reopened = createMapRunHistory(database);
    expect(reopened.findRequest('request-history')?.response.status).toBe('succeeded');
    expect(reopened.get(run.runId)?.message?.content).toContain('Inspection complete.');
    await service.shutdown();
  } finally { closeMapDesignDatabase(database); rmSync(root, { recursive: true, force: true }); }
});
