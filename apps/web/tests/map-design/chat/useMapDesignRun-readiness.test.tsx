// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMapDesignRun } from '../../../src/map-design/chat/useMapDesignRun';

const run = { runId: 'run-1', projectId: 'map-1', conversationId: 'conversation-1', status: 'running' };
const conversation = { id: 'conversation-1', projectId: 'map-1', createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z', messages: [] };
const options = { projectId: 'map-1', conversationId: 'conversation-1', runtime: { revision: 0, agentId: 'codex' } };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

describe('run queue readiness', () => {
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
