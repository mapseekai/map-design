// @vitest-environment jsdom

import type { MapDesignMessage, PersistedMapAgentEvent } from '@mapseekai/contracts';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMapDesignRun } from '../../../src/map-design/chat/useMapDesignRun';
import { I18nProvider } from '../../../src/i18n';

const run = { runId: 'run-1', projectId: 'map-1', conversationId: 'conversation-1', status: 'running' as const };
const conversation = { id: 'conversation-1', projectId: 'map-1', createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z', messages: [], activeRun: null };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function sse(events: { type: string; [key: string]: unknown }[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) {
    for (const event of events) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

function completedMessage(
  id: string,
  content: string,
  events: PersistedMapAgentEvent[],
  status: 'succeeded' | 'failed' | 'canceled' = 'succeeded',
): MapDesignMessage {
  return {
    id,
    conversationId: 'conversation-1',
    role: 'assistant',
    content,
    events,
    runStatus: status,
    startedAt: 1_788_100_000_000,
    endedAt: 1_788_100_002_000,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('useMapDesignRun', () => {
  it('sends screenshot identities without client image bytes and retains optimistic thumbnails', async () => {
    let posted: unknown;
    const screenshots = [{ id: 'a'.repeat(64), projectId: 'map-1', draftRevision: 2, styleHash: 'b'.repeat(64), width: 1, height: 1,
      capturedAt: '2026-09-08T00:00:00.000Z', viewport: { center: [0, 0] as [number, number], zoom: 1, bearing: 0, pitch: 0 } }];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) === '/api/runs') { posted = JSON.parse(String(init?.body)); return Promise.resolve(json(run, 202)); }
      return Promise.resolve(sse([{ type: 'run_finished', run: { ...run, status: 'succeeded' } }]));
    });
    const { result } = renderHook(() => useMapDesignRun({ conversation, projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'codex' } }));
    await act(async () => { expect(await result.current.send('Explain this map', undefined, screenshots)).toBe(true); });
    expect(posted).toMatchObject({ screenshotIds: [screenshots[0]!.id] });
    expect(posted).not.toHaveProperty('images');
    expect(result.current.messages.find((message) => message.role === 'user')).toMatchObject({ screenshots });
  });

  it('sends text attachment IDs and retains file metadata in the user message', async () => {
    let posted: unknown;
    const attachments = [{ id: 'c'.repeat(64), projectId: 'map-1', fileName: 'points.csv', mediaType: 'text/plain' as const,
      byteLength: 14, createdAt: '2026-09-09T00:00:00.000Z' }];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) === '/api/runs') { posted = JSON.parse(String(init?.body)); return Promise.resolve(json(run, 202)); }
      return Promise.resolve(sse([{ type: 'run_finished', run: { ...run, status: 'succeeded' } }]));
    });
    const { result } = renderHook(() => useMapDesignRun({ conversation, projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'codex' } }));
    await act(async () => { expect(await result.current.send('Analyze the file', undefined, undefined, attachments)).toBe(true); });
    expect(posted).toMatchObject({ attachmentIds: [attachments[0]!.id] });
    expect(posted).not.toHaveProperty('contentBase64');
    expect(result.current.messages.find((message) => message.role === 'user')).toMatchObject({ attachments });
  });

  it.each([
    ['The Codex turn failed before completion.', '运行未能完成。请重试。'],
    ['The Codex app-server connection ended unexpectedly.', '运行连接意外中断。请重试。'],
    ['A specific safe failure detail.', 'A specific safe failure detail.'],
  ])('localizes generic terminal run errors without replacing specific details: %s', async (message, expected) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => String(input) === '/api/runs' ? Promise.resolve(json(run, 202))
      : Promise.resolve(sse([{ type: 'run_finished', run: { ...run, status: 'failed', error: { code: 'RUN_FAILED', message } } }])));
    const { result } = renderHook(() => useMapDesignRun({ conversation, projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'codex' } }),
      { wrapper: ({ children }: { children: ReactNode }) => <I18nProvider initial="zh-CN">{children}</I18nProvider> });
    await act(async () => { await result.current.send('继续'); });
    await waitFor(() => expect(result.current.error).toBe(expected));
  });

  it('localizes unsupported image failures from the stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => String(input) === '/api/runs' ? Promise.resolve(json(run, 202))
      : Promise.resolve(sse([{ type: 'run_finished', run: { ...run, status: 'failed', error: { code: 'IMAGE_INPUT_UNSUPPORTED', message: 'raw adapter failure' } } }])));
    const { result } = renderHook(() => useMapDesignRun({ conversation, projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'deepseek-harness' } }),
      { wrapper: ({ children }: { children: ReactNode }) => <I18nProvider initial="zh-CN">{children}</I18nProvider> });
    await act(async () => { await result.current.send('看这张图'); });
    await waitFor(() => expect(result.current.error).toBe('此智能体不支持读取图片，请选择支持截图的智能体。'));
  });

  it('submits versioned comment references through the same conversation run', async () => {
    let posted: unknown;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) === '/api/runs') { posted = JSON.parse(String(init?.body)); return Promise.resolve(json(run, 202)); }
      return Promise.resolve(sse([{ type: 'run_finished', run: { ...run, status: 'succeeded' } }]));
    });
    const { result } = renderHook(() => useMapDesignRun({ conversation, projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 7, agentId: 'codex' } }));
    const commentRefs = [{ id: 'comment-1', version: 2 }, { id: 'comment-2', version: 1 }];
    await act(async () => { expect(await result.current.send('Apply selected comments', commentRefs)).toBe(true); });
    expect(posted).toMatchObject({ conversationId: 'conversation-1', runtimeRevision: 7, commentRefs });
  });
  it('posts only the persisted runtime revision and non-authority Run fields', async () => {
    let posted: unknown;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/runs' && init?.method === 'POST') {
        posted = JSON.parse(String(init.body));
        return Promise.resolve(json(run, 202));
      }
      if (url === '/api/runs/run-1/events') {
        return Promise.resolve(sse([{ type: 'run_finished', run: { ...run, status: 'succeeded' } }]));
      }
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });
    const { result } = renderHook(() => useMapDesignRun({ conversation,
      projectId: 'map-1',
      conversationId: 'conversation-1',
      runtime: {
        revision: 7,
        agentId: 'codex',
        model: 'client-must-not-send',
        reasoning: 'high',
        serviceTier: 'priority',
      },
    }));

    await act(async () => { await result.current.send('Review park colors'); });

    expect(posted).toEqual({
      projectId: 'map-1',
      conversationId: 'conversation-1',
      prompt: 'Review park colors',
      runtimeRevision: 7,
      clientRequestId: expect.stringMatching(/^map-run-/u),
      userMessageId: expect.stringMatching(/^map-user-/u),
      assistantMessageId: expect.stringMatching(/^map-assistant-/u),
    });
  });

  it('keeps stale send callbacks from starting a run after the view becomes read-only', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No run should start.'));
    const { result, rerender } = renderHook(
      ({ readOnly }) => useMapDesignRun({ conversation,
        projectId: 'map-1',
        conversationId: 'conversation-1',
        runtime: { revision: 0, agentId: 'claude' },
        readOnly,
        viewedRevision: 1,
        readOnlyReason: 'Viewing revision 1 is read only.',
      }),
      { initialProps: { readOnly: false } },
    );
    const staleSend = result.current.send;

    rerender({ readOnly: true });
    await act(async () => { await expect(staleSend('Change the historical style')).resolves.toBe(false); });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Viewing revision 1 is read only.');
  });

  it('notifies the summary owner after the daemon accepts a run start', async () => {
    const onStartAccepted = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/runs' && init?.method === 'POST') return Promise.resolve(json(run, 202));
      if (url === '/api/runs/run-1/events') return Promise.resolve(sse([{ type: 'run_finished', run: { ...run, status: 'succeeded' } }]));
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });
    const { result } = renderHook(() => useMapDesignRun({ conversation,
      projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'claude' }, onStartAccepted,
    }));

    await act(async () => { await result.current.send('Review park colors'); });

    expect(onStartAccepted).toHaveBeenCalledOnce();
  });

  it('does not notify the summary owner when the daemon rejects a run start', async () => {
    const onStartAccepted = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useMapDesignRun({ conversation,
      projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'claude' }, onStartAccepted,
    }));

    await act(async () => { await expect(result.current.send('Review park colors')).resolves.toBe(false); });

    expect(onStartAccepted).not.toHaveBeenCalled();
  });

  it('localizes an invalid run-start response instead of rendering the daemon English message', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) === '/api/runs' && init?.method === 'POST') {
        return Promise.resolve(json({ error: { code: 'INVALID_INPUT', message: 'The map run request is invalid.' } }, 400));
      }
      return Promise.reject(new Error(`Unexpected request ${String(input)}`));
    });
    const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider initial="zh-CN">{children}</I18nProvider>;
    const { result } = renderHook(() => useMapDesignRun({ conversation,
      projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'codex' },
    }), { wrapper });

    await act(async () => { await expect(result.current.send('Review labels')).resolves.toBe(false); });

    expect(result.current.error).toBe('无法启动地图运行。');
  });

  it('localizes a typed tool-loop terminal error from the run stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/runs' && init?.method === 'POST') return Promise.resolve(json(run, 202));
      if (url === '/api/runs/run-1/events') {
        return Promise.resolve(sse([{
          type: 'run_finished',
          run: {
            ...run,
            status: 'failed',
            error: {
              code: 'TOOL_LOOP_DETECTED',
              message: 'Repeated invalid map tool calls were stopped.',
            },
          },
        }]));
      }
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <I18nProvider initial="zh-CN">{children}</I18nProvider>
    );
    const { result } = renderHook(() => useMapDesignRun({ conversation,
      projectId: 'map-1',
      conversationId: 'conversation-1',
      runtime: { revision: 0, agentId: 'codex' },
    }), { wrapper });

    await act(async () => { await result.current.send('修复标签'); });
    await waitFor(() => expect(result.current.status).toBe('failed'));

    expect(result.current.error).toBe('已停止重复的无效地图工具调用。');
  });

  it('reconciles a disconnected run against its selected conversation rather than the primary alias', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/runs' && init?.method === 'POST') return Promise.resolve(json({ runId: 'run-1', projectId: 'map-1', conversationId: 'conversation-2', status: 'running' }, 202));
      if (url === '/api/runs/run-1/events') return Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } }));
      if (url === '/api/runs/run-1') return Promise.resolve(json({ runId: 'run-1', projectId: 'map-1', conversationId: 'conversation-2', status: 'running' }));
      if (url === '/api/map-design/projects/map-1/conversations/conversation-2') return Promise.resolve(json(conversation));
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });
    const { result } = renderHook(() => useMapDesignRun({ conversation: { ...conversation, id: 'conversation-2' }, projectId: 'map-1', conversationId: 'conversation-2', runtime: { revision: 0, agentId: 'claude' } }));

    await act(async () => { await result.current.send('Inspect stream'); });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(
      '/api/map-design/projects/map-1/conversations/conversation-2', expect.anything(),
    ));
  });

  it('replaces the assistant event array from every authoritative event_snapshot', async () => {
    const encoder = new TextEncoder();
    let assistantMessageId = '';
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/runs' && init?.method === 'POST') {
        assistantMessageId = (JSON.parse(String(init.body)) as { assistantMessageId: string }).assistantMessageId;
        return Promise.resolve(json(run, 202));
      }
      if (url === '/api/runs/run-1/events') return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });
    const { result, unmount } = renderHook(() => useMapDesignRun({ conversation, projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'claude' } }));

    await act(async () => { await result.current.send('Review hierarchy'); });
    await act(async () => {
      streamController?.enqueue(encoder.encode(`data: ${JSON.stringify({
        type: 'event_snapshot', runId: 'run-1', messageId: assistantMessageId,
        events: [{ kind: 'thinking', text: 'First public summary.' }, { kind: 'text', text: 'First answer.' }],
      })}\n\n`));
    });
    await waitFor(() => expect(result.current.messages.find((message) => message.id === assistantMessageId)?.events).toEqual([
      { kind: 'thinking', text: 'First public summary.' },
      { kind: 'text', text: 'First answer.' },
    ]));

    await act(async () => {
      streamController?.enqueue(encoder.encode(`data: ${JSON.stringify({
        type: 'event_snapshot', runId: 'run-1', messageId: assistantMessageId,
        events: [{ kind: 'status', label: 'validating' }, { kind: 'thinking', text: 'Replacement public summary.' }],
      })}\n\n`));
    });
    await waitFor(() => expect(result.current.messages.find((message) => message.id === assistantMessageId)?.events).toEqual([
      { kind: 'status', label: 'validating' },
      { kind: 'thinking', text: 'Replacement public summary.' },
    ]));
    expect(result.current.messages.find((message) => message.id === assistantMessageId)?.events).not.toContainEqual(
      expect.objectContaining({ text: 'First public summary.' }),
    );
    unmount();
  });

  it('applies one stream read in transport order while committing React state once', async () => {
    const encoder = new TextEncoder();
    let assistantMessageId = '';
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/runs' && init?.method === 'POST') {
        assistantMessageId = (JSON.parse(String(init.body)) as { assistantMessageId: string }).assistantMessageId;
        return Promise.resolve(json(run, 202));
      }
      if (url === '/api/runs/run-1/events') {
        return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
      }
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });
    const { result, unmount } = renderHook(() => useMapDesignRun({ conversation,
      projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'claude' },
    }));

    await act(async () => { await result.current.send('Review hierarchy'); });
    const frames = [
      {
        type: 'event_snapshot', runId: 'run-1', messageId: assistantMessageId,
        events: [{ kind: 'thinking', text: 'First snapshot.' }],
      },
      {
        type: 'message_completed', runId: 'run-1',
        message: completedMessage(assistantMessageId, 'Interim answer.', [{ kind: 'text', text: 'Interim event.' }]),
      },
      {
        type: 'event_snapshot', runId: 'run-1', messageId: assistantMessageId,
        events: [{ kind: 'thinking', text: 'Last snapshot.' }],
      },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
    await act(async () => { streamController?.enqueue(encoder.encode(frames)); });

    await waitFor(() => expect(
      result.current.messages.find((message) => message.id === assistantMessageId),
    ).toMatchObject({
      content: 'Interim answer.',
      events: [{ kind: 'thinking', text: 'Last snapshot.' }],
    }));
    unmount();
  });

  it('applies one event-only run sequence and lets message_completed replace terminal metadata', async () => {
    const events: PersistedMapAgentEvent[] = [
      { kind: 'status', label: 'analyzing' },
      { kind: 'thinking', text: 'Checking labels.' },
      { kind: 'tool_use', id: 'tool-1', name: 'map_inspect', summary: { target: 'labels' } },
      { kind: 'tool_result', toolUseId: 'tool-1', status: 'succeeded', summary: { changed: 4 } },
      { kind: 'text', text: 'Adjusting labels' },
      { kind: 'run_finished', status: 'succeeded' },
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/runs' && init?.method === 'POST') return Promise.resolve(json(run, 202));
      if (url === '/api/runs/run-1/events') return Promise.resolve(sse([
        { type: 'event_snapshot', runId: 'run-1', messageId: 'assistant-1', events: events.slice(0, -1) },
        { type: 'message_completed', runId: 'run-1', message: completedMessage('assistant-1', 'Adjusting labels', events) },
        { type: 'run_finished', run: { ...run, status: 'succeeded' } },
      ]));
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });

    const { result } = renderHook(() => useMapDesignRun({ conversation, projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'claude' } }));
    await act(async () => { await result.current.send('Adjust labels'); });
    await waitFor(() => expect(result.current.status).toBe('succeeded'));
    const assistant = result.current.messages.find((message) => message.id === 'assistant-1');
    expect(assistant?.content).toBe('Adjusting labels');
    expect(assistant?.runStatus).toBe('succeeded');
    expect(assistant?.endedAt).toBe(1_788_100_002_000);
    expect(assistant?.events).toEqual(events);
  });

  it('accepts bounded snapshots and ignores an invalid 81-entry replacement', async () => {
    let assistantMessageId = '';
    const boundedEvents = Array.from({ length: 80 }, () => ({ kind: 'status' as const, label: 'analyzing' as const }));
    const oversizedEvents = [...boundedEvents, { kind: 'status' as const, label: 'validating' as const }];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/runs' && init?.method === 'POST') {
        assistantMessageId = (JSON.parse(String(init.body)) as { assistantMessageId: string }).assistantMessageId;
        return Promise.resolve(json(run, 202));
      }
      if (url === '/api/runs/run-1/events') return Promise.resolve(sse([
        { type: 'event_snapshot', runId: 'run-1', messageId: assistantMessageId, events: boundedEvents },
        { type: 'event_snapshot', runId: 'run-1', messageId: assistantMessageId, events: oversizedEvents },
        { type: 'run_finished', run: { ...run, status: 'succeeded' } },
      ]));
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });
    const { result } = renderHook(() => useMapDesignRun({ conversation, projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'claude' } }));

    await act(async () => { await result.current.send('Review bounded events'); });
    await waitFor(() => expect(result.current.status).toBe('succeeded'));

    const events = result.current.messages.find((message) => message.id === assistantMessageId)?.events;
    expect(events).toHaveLength(80);
    expect(events).toEqual(boundedEvents);
    expect(new TextEncoder().encode(JSON.stringify(events)).byteLength).toBeLessThanOrEqual(65_536);
  });

  it('accepts after the run starts and rejects a second send while that run is active', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/runs' && init?.method === 'POST') return Promise.resolve(json(run, 202));
      if (url === '/api/runs/run-1/events') return Promise.resolve(new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } }));
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });
    const { result, unmount } = renderHook(() => useMapDesignRun({ conversation, projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'claude' } }));

    await act(async () => expect(await result.current.send('Adjust labels')).toBe(true));
    await act(async () => expect(await result.current.send('Another adjustment')).toBe(false));
    unmount();
  });

  it('returns false and releases the form send lock when starting the run fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useMapDesignRun({ conversation, projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'claude' } }));
    await act(async () => expect(await result.current.send('Adjust labels')).toBe(false));
    await act(async () => expect(await result.current.send('Try again')).toBe(false));
  });

  it('keeps the submitted turn out of messages until the server accepts the run', async () => {
    let resolveStart: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/runs' && init?.method === 'POST') return new Promise<Response>((resolve) => { resolveStart = resolve; });
      if (url === '/api/runs/run-1/events') return Promise.resolve(new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } }));
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });
    const { result, unmount } = renderHook(() => useMapDesignRun({ conversation, projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'claude' } }));

    let sent: Promise<boolean> | undefined;
    await act(async () => { sent = result.current.send('Adjust labels'); await Promise.resolve(); });
    expect(result.current.sending).toBe(true);
    expect(result.current.messages).toEqual([]);

    await act(async () => { resolveStart?.(json(run, 202)); expect(await sent).toBe(true); });
    expect(result.current.messages).toMatchObject([
      { role: 'user', content: 'Adjust labels', events: [{ kind: 'text', text: 'Adjust labels' }] },
      { role: 'assistant', content: '', events: [], runStatus: 'running' },
    ]);
    unmount();
  });

  it('drops the submitted turn and releases the send lock when the server rejects it', async () => {
    let rejectStart: ((error: Error) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) === '/api/runs' && init?.method === 'POST') return new Promise<Response>((_resolve, reject) => { rejectStart = reject; });
      return Promise.reject(new Error(`Unexpected request ${String(input)}`));
    });
    const { result } = renderHook(() => useMapDesignRun({ conversation, projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'claude' } }));

    let sent: Promise<boolean> | undefined;
    await act(async () => { sent = result.current.send('Adjust labels'); await Promise.resolve(); });
    expect(result.current.messages).toEqual([]);
    await act(async () => { rejectStart?.(new Error('offline')); expect(await sent).toBe(false); });
    expect(result.current.sending).toBe(false);
    expect(result.current.messages).toEqual([]);
  });

  it('remembers a queued cancellation and sends one cancel after the run start is accepted', async () => {
    let resolveStart: ((response: Response) => void) | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/runs' && init?.method === 'POST') {
        return new Promise<Response>((resolve) => { resolveStart = resolve; });
      }
      if (url === '/api/runs/run-1/events') {
        return Promise.resolve(new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } }));
      }
      if (url === '/api/runs/run-1/cancel' && init?.method === 'POST') {
        return Promise.resolve(json({ runId: 'run-1', status: 'canceled' }));
      }
      if (url === '/api/map-design/projects/map-1/conversations/conversation-1') {
        return Promise.resolve(json(conversation));
      }
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });
    const { result } = renderHook(() => useMapDesignRun({ conversation,
      projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'codex' },
    }));

    let sent: Promise<boolean> | undefined;
    let firstCancel: Promise<void> | undefined;
    let secondCancel: Promise<void> | undefined;
    await act(async () => {
      sent = result.current.send('Adjust labels');
      await Promise.resolve();
      firstCancel = result.current.cancel();
      secondCancel = result.current.cancel();
      await Promise.resolve();
    });
    expect(fetchSpy.mock.calls.filter(([input]) => String(input) === '/api/runs/run-1/cancel')).toHaveLength(0);

    await act(async () => {
      resolveStart?.(json(run, 202));
      await sent;
      await Promise.all([firstCancel, secondCancel]);
    });

    expect(fetchSpy.mock.calls.filter(([input]) => String(input) === '/api/runs/run-1/cancel')).toHaveLength(1);
    expect(result.current.status).toBe('canceled');
  });

  it('reconciles the authoritative canceled message after aborting its live stream', async () => {
    let assistantMessageId = '';
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const canceledEvents: PersistedMapAgentEvent[] = [
      { kind: 'status', label: 'analyzing' },
      { kind: 'text', text: 'Working' },
      { kind: 'run_finished', status: 'canceled' },
    ];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/runs' && init?.method === 'POST') {
        assistantMessageId = (JSON.parse(String(init.body)) as { assistantMessageId: string }).assistantMessageId;
        return Promise.resolve(json(run, 202));
      }
      if (url === '/api/runs/run-1/events') return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; },
      }), { headers: { 'content-type': 'text/event-stream' } }));
      if (url === '/api/runs/run-1/cancel' && init?.method === 'POST') return Promise.resolve(json({ runId: 'run-1', status: 'canceled' }));
      if (url === '/api/map-design/projects/map-1/conversations/conversation-1') return Promise.resolve(json({
        ...conversation,
        messages: [completedMessage(assistantMessageId, 'Working', canceledEvents, 'canceled')],
      }));
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });
    const { result, unmount } = renderHook(() => useMapDesignRun({ conversation, projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'claude' } }));
    await act(async () => { await result.current.send('Adjust labels'); });
    expect(result.current.status).toBe('running');
    await act(async () => { await result.current.cancel(); });

    expect(fetchSpy).toHaveBeenCalledWith('/api/map-design/projects/map-1/conversations/conversation-1', expect.anything());
    expect(result.current.status).toBe('canceled');
    expect(result.current.messages.find((message) => message.id === assistantMessageId)).toMatchObject({
      runStatus: 'canceled',
      endedAt: 1_788_100_002_000,
      events: canceledEvents,
    });
    await act(async () => { streamController?.close(); });
    unmount();
  });

  it('aborts the active stream when unmounted', async () => {
    let streamSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/runs' && init?.method === 'POST') return Promise.resolve(json(run, 202));
      if (url === '/api/runs/run-1/events') {
        streamSignal = init?.signal ?? undefined;
        return Promise.resolve(new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } }));
      }
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });
    const { result, unmount } = renderHook(() => useMapDesignRun({ conversation, projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'claude' } }));
    await act(async () => { void result.current.send('Adjust labels'); await Promise.resolve(); });
    await waitFor(() => expect(streamSignal).toBeDefined());
    unmount();
    expect(streamSignal?.aborted).toBe(true);
  });
});
