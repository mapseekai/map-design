// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMapDesignRun } from '../../../src/map-design/chat/useMapDesignRun';
import { useQueuedMapMessages } from '../../../src/map-design/chat/useQueuedMapMessages';

const run = { runId: 'run-1', projectId: 'map-1', conversationId: 'conversation-1', status: 'running' };
const conversation = { id: 'conversation-1', projectId: 'map-1', createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z', messages: [] };
const options = { projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'codex' } };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('run queue readiness', () => {
  it('recovers through a transient polling failure and releases the next turn after a disconnected run completes', async () => {
    vi.useFakeTimers();
    let reads = 0;
    let starts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/runs') return Promise.resolve(json({ ...run, runId: `run-${++starts}` }));
      if (url.endsWith('/events')) return Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.close(); } })));
      if (url === '/api/runs/run-1') {
        reads++;
        if (reads === 2) return Promise.reject(new Error('temporarily offline'));
        return Promise.resolve(json({ ...run, status: reads < 3 ? 'running' : 'succeeded' }));
      }
      return Promise.resolve(json(conversation));
    });
    const { result, unmount } = renderHook(() => useMapDesignRun(options));
    try {
      await act(async () => { await result.current.send('First'); });
      expect(reads).toBe(1);
      expect(result.current.ready).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(result.current.error).toBe('temporarily offline');
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(result.current.status).toBe('succeeded');
      expect(result.current.error).toBeNull();
      expect(result.current.ready).toBe(true);
      expect(reads).toBe(3);
      await act(async () => { expect(await result.current.send('Second')).toBe(true); });
    } finally {
      unmount();
    }
  });

  it('stops recovery polling when the hook unmounts', async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/events')) return Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.close(); } })));
      return Promise.resolve(json(url.startsWith('/api/runs') ? run : conversation));
    });
    const { result, unmount } = renderHook(() => useMapDesignRun(options));
    await act(async () => { await result.current.send('First'); });
    unmount();
    const calls = fetch.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('keeps listening after cancellation fails (cancel requested before acceptance: %s)', async (cancelBeforeAcceptance) => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let resolveStart!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/runs' && cancelBeforeAcceptance) return new Promise<Response>((resolve) => { resolveStart = resolve; });
      if (url.endsWith('/events')) return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } })));
      if (url.endsWith('/cancel')) return Promise.reject(new Error('cancel failed'));
      return Promise.resolve(json(url.startsWith('/api/runs') ? run : conversation));
    });
    const { result, unmount } = renderHook(() => useMapDesignRun(options));
    try {
      let sent!: Promise<boolean>;
      await act(async () => { sent = result.current.send('First'); });
      await act(async () => {
        const canceled = result.current.cancel();
        if (cancelBeforeAcceptance) resolveStart(json(run));
        await Promise.all([sent, canceled]);
      });
      expect(result.current.ready).toBe(false);
      await act(async () => {
        streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'run_finished', run: { ...run, status: 'succeeded' } })}\n\n`));
        streamController.close();
      });
      expect(result.current.status).toBe('succeeded');
      expect(result.current.ready).toBe(true);
    } finally {
      unmount();
    }
  });

  it('dispatches the next queued message exactly once after polling observes completion', async () => {
    vi.useFakeTimers();
    const prompts: string[] = [];
    let reads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/runs') {
        prompts.push((JSON.parse(String(init?.body)) as { prompt: string }).prompt);
        return Promise.resolve(json({ ...run, runId: `run-${prompts.length}` }));
      }
      if (url === '/api/runs/run-1/events') return Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.close(); } })));
      if (url.endsWith('/events')) return Promise.resolve(new Response(new ReadableStream<Uint8Array>()));
      if (url === '/api/runs/run-1') return Promise.resolve(json({ ...run, status: ++reads === 1 ? 'running' : 'succeeded' }));
      return Promise.resolve(json(conversation));
    });
    const { result, unmount } = renderHook(() => {
      const currentRun = useMapDesignRun(options);
      const queue = useQueuedMapMessages({ ...currentRun, blocked: false, send: (message) => currentRun.send(message.prompt) });
      return { currentRun, queue };
    });
    try {
      await act(async () => { await result.current.currentRun.send('First'); });
      await act(async () => { result.current.queue.enqueue('Second'); });
      expect(prompts).toEqual(['First']);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(prompts).toEqual(['First', 'Second']);
      expect(result.current.queue.items).toEqual([]);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(prompts).toEqual(['First', 'Second']);
    } finally {
      unmount();
    }
  });

  it('ignores a stale running response when the stream finishes during cancellation recovery', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let resolveStatus!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/events')) return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } })));
      if (url.endsWith('/cancel')) return Promise.reject(new Error('cancel failed'));
      if (url === '/api/runs/run-1') return new Promise<Response>((resolve) => { resolveStatus = resolve; });
      return Promise.resolve(json(url === '/api/runs' ? run : conversation));
    });
    const { result, unmount } = renderHook(() => useMapDesignRun(options));
    try {
      await act(async () => { await result.current.send('First'); });
      let canceled!: Promise<void>;
      await act(async () => { canceled = result.current.cancel(); });
      await act(async () => {
        streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'run_finished', run: { ...run, status: 'succeeded' } })}\n\n`));
        streamController.close();
      });
      await act(async () => { resolveStatus(json(run)); await canceled; });
      expect(result.current.status).toBe('succeeded');
      expect(result.current.ready).toBe(true);
    } finally {
      unmount();
    }
  });

  it('assigns distinct request and message IDs to independent clients sending in the same millisecond', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000);
    const requests: Array<Record<string, string>> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) === '/api/runs') {
        requests.push(JSON.parse(String(init?.body)) as Record<string, string>);
        return Promise.resolve(json({ ...run, runId: `run-${requests.length}` }));
      }
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>()));
    });
    const first = renderHook(() => useMapDesignRun(options));
    const second = renderHook(() => useMapDesignRun(options));
    try {
      await act(async () => { await Promise.all([first.result.current.send('First'), second.result.current.send('Second')]); });
      expect(requests).toHaveLength(2);
      for (const field of ['clientRequestId', 'userMessageId', 'assistantMessageId']) {
        expect(requests[0]![field]).not.toBe(requests[1]![field]);
      }
    } finally {
      first.unmount();
      second.unmount();
    }
  });

  it('releases the next turn only after the terminal stream relinquishes its send lock', async () => {
    // Given an accepted run with a stream that remains open after its terminal event.
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => Promise.resolve(String(input) === '/api/runs'
      ? json(run) : new Response(stream)));
    const { result } = renderHook(() => useMapDesignRun(options));
    expect(result.current.ready).toBe(true);
    await act(async () => { await result.current.send('First'); });
    expect(result.current.ready).toBe(false);

    // When a terminal event arrives before the stream closes.
    await act(async () => { streamController?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'run_finished', run: { ...run, status: 'succeeded' } })}\n\n`)); });

    // Then presentation is terminal, but the queued turn must still wait for cleanup.
    expect(result.current.sending).toBe(false);
    expect(result.current.ready).toBe(false);
    await act(async () => { streamController?.close(); });
    expect(result.current.ready).toBe(true);
  });

  it('becomes ready again when a pending start is rejected', async () => {
    // Given a start request awaiting the server.
    let rejectStart: ((error: Error) => void) | undefined;
    const pending = new Promise<Response>((_resolve, reject) => { rejectStart = reject; });
    vi.spyOn(globalThis, 'fetch').mockReturnValue(pending);
    const { result } = renderHook(() => useMapDesignRun(options));
    let sent: Promise<boolean> | undefined;
    await act(async () => { sent = result.current.send('First'); });
    expect(result.current.ready).toBe(false);

    // When the start fails before being accepted.
    await act(async () => { rejectStart?.(new Error('offline')); await sent; });

    // Then the next explicit dispatch can safely retry.
    expect(result.current.ready).toBe(true);
    expect(result.current.sending).toBe(false);
  });

  it.each(['running', 'canceled'])('keeps cancellation readiness consistent with recovered server status %s', async (status) => {
    // Given an active run whose cancellation request fails.
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/runs') return Promise.resolve(json(run));
      if (url.endsWith('/events')) return Promise.resolve(new Response(stream));
      if (url.endsWith('/cancel')) return Promise.reject(new Error('cancel failed'));
      return Promise.resolve(json(url === '/api/runs/run-1' ? { ...run, status } : conversation));
    });
    const { result, unmount } = renderHook(() => useMapDesignRun(options));
    await act(async () => { await result.current.send('First'); });

    // When cancellation reconciles with the authoritative run status.
    await act(async () => { await result.current.cancel(); streamController?.close(); });

    // Then only a terminal server run allows another queued turn.
    expect(result.current.ready).toBe(status === 'canceled');
    if (status === 'running') await act(async () => { expect(await result.current.send('Second')).toBe(false); });
    unmount();
  });

  it('keeps a newer run locked when a canceled stream finishes late', async () => {
    let oldStream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let starts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/runs') return Promise.resolve(json({ ...run, runId: `run-${++starts}` }));
      if (url === '/api/runs/run-1/events') return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { oldStream = controller; } })));
      if (url.endsWith('/events')) return Promise.resolve(new Response(new ReadableStream<Uint8Array>()));
      if (url.endsWith('/cancel')) return Promise.resolve(json({ ...run, status: 'canceled' }));
      return Promise.resolve(json(conversation));
    });
    const { result, unmount } = renderHook(() => useMapDesignRun(options));
    await act(async () => { await result.current.send('First'); });
    await act(async () => { await result.current.cancel(); });
    expect(result.current.ready).toBe(true);
    await act(async () => { expect(await result.current.send('Second')).toBe(true); });

    await act(async () => {
      oldStream?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'run_finished', run: { ...run, status: 'canceled' } })}\n\n`));
      oldStream?.close();
    });

    expect(result.current.runId).toBe('run-2');
    expect(result.current.status).toBe('running');
    expect(result.current.ready).toBe(false);
    await act(async () => { expect(await result.current.send('Third')).toBe(false); });
    unmount();
  });
});
