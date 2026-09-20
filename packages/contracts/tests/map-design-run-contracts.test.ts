import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  MapDesignMessageSchema,
  MapDesignRunEventSchema,
  PersistedMapAgentEventSchema,
  StartMapDesignRunRequestSchema,
  type CancelMapDesignRunResponse,
  type MapAgentCapability,
  type MapDesignConversation,
  type MapDesignMessage,
  type MapDesignMessageRole,
  type MapDesignRunEvent,
  type MapDesignRunResponse,
  type MapDesignRunStatus,
  type MapRunStatus,
  type PersistedMapAgentEvent,
  type StartMapDesignRunRequest,
} from '../src/index';

type Equal<Actual, Expected> = (
  <Value>() => Value extends Actual ? 1 : 2
) extends <Value>() => Value extends Expected ? 1 : 2
  ? (<Value>() => Value extends Expected ? 1 : 2) extends <Value>() => Value extends Actual ? 1 : 2
    ? true
    : false
  : false;
type Expect<T extends true> = T;
type ExactKeys<Shape, Keys extends PropertyKey> = Equal<keyof Shape, Keys>;

type _MapDesignMessageRoleValues = Expect<Equal<MapDesignMessageRole, 'user' | 'assistant' | 'system'>>;
type _MapAgentCapabilityKeys = Expect<
  ExactKeys<MapAgentCapability, 'nativeMapTools' | 'publicReasoningSummary' | 'reason'>
>;
type _MapDesignMessageKeys = Expect<
  ExactKeys<
    MapDesignMessage,
    'id' | 'conversationId' | 'role' | 'content' | 'events' | 'runStatus' | 'startedAt' | 'endedAt' | 'runtime'
  >
>;
type _MapDesignRunStatusValues = Expect<
  Equal<MapDesignRunStatus, 'queued' | 'running' | 'awaiting_input' | 'succeeded' | 'failed' | 'canceled'>
>;
type _MapRunStatusValues = Expect<
  Equal<MapRunStatus, 'queued' | 'running' | 'awaiting_input' | 'succeeded' | 'failed' | 'canceled'>
>;
type _MapDesignRunResponseKeys = Expect<
  ExactKeys<
    MapDesignRunResponse,
    'runId' | 'projectId' | 'conversationId' | 'status' | 'startedAt' | 'finishedAt' | 'error'
  >
>;
type _CancelMapDesignRunResponseKeys = Expect<ExactKeys<CancelMapDesignRunResponse, 'runId' | 'status'>>;
type _CancelMapDesignRunResponseStatus = Expect<Equal<CancelMapDesignRunResponse['status'], 'canceled'>>;
type _MapDesignRunEventTypes = Expect<
  Equal<MapDesignRunEvent['type'], 'event_snapshot' | 'message_completed' | 'run_finished' | 'error'>
>;
type _EventSnapshotKeys = Expect<
  ExactKeys<Extract<MapDesignRunEvent, { type: 'event_snapshot' }>, 'type' | 'runId' | 'messageId' | 'events'>
>;
type _MessageCompletedEventKeys = Expect<
  ExactKeys<Extract<MapDesignRunEvent, { type: 'message_completed' }>, 'type' | 'runId' | 'message'>
>;
type _RunFinishedEventKeys = Expect<ExactKeys<Extract<MapDesignRunEvent, { type: 'run_finished' }>, 'type' | 'run'>>;
type _ErrorEventKeys = Expect<
  ExactKeys<Extract<MapDesignRunEvent, { type: 'error' }>, 'type' | 'runId' | 'error'>
>;
type _ToolResultStatus = Expect<Equal<
  Extract<PersistedMapAgentEvent, { kind: 'tool_result' }>['status'],
  'succeeded' | 'failed' | 'canceled'
>>;

const capability: MapAgentCapability = {
  nativeMapTools: true,
  publicReasoningSummary: true,
};

const events: PersistedMapAgentEvent[] = [
  { kind: 'status', label: 'analyzing' },
  { kind: 'thinking', text: 'I will inspect the road hierarchy.' },
  { kind: 'tool_use', id: 'call-1', name: 'map_inspect', summary: { target: 'root' } },
  { kind: 'tool_result', toolUseId: 'call-1', status: 'succeeded', summary: { returned: 12 } },
  { kind: 'text', text: 'The map is ready.' },
  { kind: 'run_finished', status: 'succeeded' },
];

const message = {
  id: 'assistant-1',
  conversationId: 'conversation-1',
  role: 'assistant',
  content: 'The map is ready.',
  events,
  runStatus: 'succeeded',
  startedAt: 1_788_100_000_000,
  endedAt: 1_788_100_002_000,
} satisfies MapDesignMessage;

describe('MapDesign run contracts', () => {
  it('accepts an ordered native-agent event snapshot without legacy activity fields', () => {
    expect(capability).toEqual({ nativeMapTools: true, publicReasoningSummary: true });
    expect(events.map((event) => event.kind)).toEqual([
      'status',
      'thinking',
      'tool_use',
      'tool_result',
      'text',
      'run_finished',
    ]);
    expect(MapDesignMessageSchema.parse(message)).not.toHaveProperty('activity');
  });

  it('accepts an explicit canceled tool result as terminal tool evidence', () => {
    const canceled = {
      kind: 'tool_result',
      toolUseId: 'call-canceled',
      status: 'canceled',
      summary: { retryable: false },
    };

    expect(PersistedMapAgentEventSchema.parse(canceled)).toEqual(canceled);
  });

  it('rejects removed activity and tool call payloads', () => {
    expect(() => MapDesignMessageSchema.parse({ ...message, activity: [] })).toThrow();
    expect(() => MapDesignMessageSchema.parse({ ...message, toolCalls: [] })).toThrow();
  });

  it('rejects unsafe native-agent event payloads', () => {
    expect(() => MapDesignMessageSchema.parse({
      ...message,
      events: [{ kind: 'tool_use', id: 'call-1', name: 'map_inspect', summary: { path: '/Users/zhang/.ssh/id_ed25519' } }],
    })).toThrow();
    expect(() => MapDesignMessageSchema.parse({ ...message, events: Array.from({ length: 81 }, () => events[0]) })).toThrow();
    expect(() => MapDesignMessageSchema.parse({ ...message, content: 'x'.repeat(65_536) })).toThrow();
  });

  it('rejects raw absolute paths in safe-summary keys and embedded values', () => {
    const unsafeSummaries = [
      { '/Users/zhang/.ssh/id_ed25519': 'root' },
      { target: 'Inspect /Users/zhang/.ssh/id_ed25519 before continuing.' },
      { '\\\\server\\share\\map.json': 'root' },
      { target: 'Inspect \\\\server\\share\\map.json before continuing.' },
      { 'C:\\Users\\zhang\\map.json': 'root' },
      { target: 'Inspect C:\\Users\\zhang\\map.json before continuing.' },
    ];

    for (const summary of unsafeSummaries) {
      expect(() => MapDesignMessageSchema.parse({
        ...message,
        events: [{ kind: 'tool_use', id: 'call-1', name: 'map_inspect', summary }],
      })).toThrow();
    }
  });

  it('distinguishes Unix absolute paths from safe slash-delimited summary strings', () => {
    const unsafeUnixPaths = ['/', '//', '/ private', '/tmp', '//tmp', 'prefix /tmp/file suffix'];
    const safeSummaryStrings = ['roads/primary', '1/2', 'map-design:roads/primary'];

    for (const path of unsafeUnixPaths) {
      expect(() => MapDesignMessageSchema.parse({
        ...message,
        events: [{ kind: 'tool_use', id: 'call-1', name: 'map_inspect', summary: { target: path } }],
      })).toThrow();
      expect(() => MapDesignMessageSchema.parse({
        ...message,
        events: [{ kind: 'tool_use', id: 'call-1', name: 'map_inspect', summary: { [path]: 'safe' } }],
      })).toThrow();
    }

    for (const value of safeSummaryStrings) {
      const parsed = MapDesignMessageSchema.parse({
        ...message,
        events: [{ kind: 'tool_use', id: 'call-1', name: 'map_inspect', summary: { [value]: value } }],
      });

      expect(parsed.events).toHaveLength(1);
    }
  });

  it('rejects oversized event snapshots at the SSE boundary', () => {
    expect(MapDesignRunEventSchema).toBeDefined();
    expect(() => MapDesignRunEventSchema.parse({
      type: 'event_snapshot',
      runId: 'run-1',
      messageId: 'assistant-1',
      events: Array.from({ length: 81 }, () => events[0]),
    })).toThrow();
    expect(() => MapDesignRunEventSchema.parse({
      type: 'event_snapshot',
      runId: 'run-1',
      messageId: 'assistant-1',
      events: [{ kind: 'text', text: 'x'.repeat(65_536) }],
    })).toThrow();
  });

  it('retains only the daemon-selected runtime revision for a run request', () => {
    const request: StartMapDesignRunRequest = {
      projectId: 'map-123',
      conversationId: 'conversation-123',
      prompt: 'Reduce road casing contrast.',
      runtimeRevision: 3,
      byokProvider: {
        protocol: 'anthropic',
        apiKey: 'test-key',
      },
      locale: 'zh-CN',
      clientRequestId: 'request-123',
      userMessageId: 'message-user-123',
      assistantMessageId: 'message-assistant-123',
    };

    expect(request.projectId).toBe('map-123');
    expect('agentId' in request).toBe(false);
    expect('model' in request).toBe(false);
    expect('reasoning' in request).toBe(false);
    expect('serviceTier' in request).toBe(false);
    expect('mediaExecution' in request).toBe(false);
    expect('workspace' in request).toBe(false);
  });

  it('carries the optional historical revision selected by the Studio view', () => {
    const currentRun: StartMapDesignRunRequest = {
      projectId: 'map-123',
      conversationId: 'conversation-123',
      prompt: 'Reduce road casing contrast.',
      runtimeRevision: 3,
      clientRequestId: 'request-123',
      userMessageId: 'message-user-123',
      assistantMessageId: 'message-assistant-123',
    };
    const historicalRun: StartMapDesignRunRequest = { ...currentRun, viewedRevision: 1 };

    expect(currentRun.viewedRevision).toBeUndefined();
    expect(historicalRun.viewedRevision).toBe(1);
    expectTypeOf<StartMapDesignRunRequest['viewedRevision']>().toEqualTypeOf<number | undefined>();
  });

  // Mutation caught: accepting client-selected runtime authority, omitting the CAS revision, or allowing unknown request fields.
  it('strictly accepts only the daemon-selected runtime revision', () => {
    const request = {
      projectId: 'project-1',
      conversationId: 'conversation-1',
      prompt: 'darken',
      runtimeRevision: 3,
      clientRequestId: 'request-1',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
    };

    expect(StartMapDesignRunRequestSchema.parse(request)).not.toHaveProperty('agentId');
    expect(() => StartMapDesignRunRequestSchema.parse({ ...request, runtimeRevision: -1 })).toThrow();
    expect(() => StartMapDesignRunRequestSchema.parse({ ...request, runtimeRevision: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => StartMapDesignRunRequestSchema.parse({ ...request, viewedRevision: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => StartMapDesignRunRequestSchema.parse({ ...request, agentId: 'opencode' })).toThrow();
    expect(() => StartMapDesignRunRequestSchema.parse({
      ...request,
      byokProvider: { protocol: 'openai', apiKey: 'test-key', model: 'openai/gpt-5.6-terra' },
    })).toThrow();
  });

  it('uses event snapshots in the run stream and completed message payload', () => {
    const conversation = {
      id: 'conversation-123',
      projectId: 'map-123',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
      messages: [message],
    } satisfies MapDesignConversation;
    const response = {
      runId: 'run-123',
      projectId: 'map-123',
      conversationId: 'conversation-123',
      status: 'succeeded',
      startedAt: '2026-08-24T00:00:00.000Z',
      finishedAt: '2026-08-24T00:00:01.000Z',
    } satisfies MapDesignRunResponse;
    const canceled = { runId: 'run-123', status: 'canceled' } satisfies CancelMapDesignRunResponse;
    const streamEvents = [
      { type: 'event_snapshot', runId: 'run-123', messageId: 'assistant-1', events },
      { type: 'message_completed', runId: 'run-123', message },
      { type: 'run_finished', run: response },
      { type: 'error', runId: 'run-123', error: { code: 'RUN_FAILED', message: 'Run failed.' } },
    ] satisfies MapDesignRunEvent[];

    expect(Object.keys(conversation).sort()).toEqual(['createdAt', 'id', 'messages', 'projectId', 'updatedAt']);
    expect(Object.keys(canceled).sort()).toEqual(['runId', 'status']);
    expect(streamEvents).toHaveLength(4);
  });
});
