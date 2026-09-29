// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMapDesignConversation } from '../../../src/map-design/chat/useMapDesignConversation';

function deferredResponse() {
  let resolveResponse: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => { resolveResponse = resolve; });
  return { promise, resolve: (response: Response) => resolveResponse?.(response) };
}

function conversationResponse(id: string, updatedAt = '2026-09-29T00:00:00.000Z', content = '') {
  const messages = content ? [{
    id: 'message-1', conversationId: id, content, role: 'assistant', events: [],
    runStatus: 'completed', startedAt: 1, endedAt: 2,
  }] : [];
  return new Response(JSON.stringify({ id, projectId: 'project-1', createdAt: updatedAt, updatedAt, activeRun: null, messages }), {
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('conversation refresh lifecycle', () => {
  it('coalesces poll updates while allowing slow requests to finish and then loads the latest messages', async () => {
    // Given a conversation response slower than several session polls.
    const first = deferredResponse();
    const latest = deferredResponse();
    const fetch = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
    const view = renderHook(({ session }) => useMapDesignConversation('project-1', 'conversation-1', session), {
      initialProps: { session: { revision: 1 } },
    });
    const signal = fetch.mock.calls[0]?.[1]?.signal;

    // When multiple session updates arrive before the request finishes.
    for (let index = 0; index < 5; index += 1) view.rerender({ session: { revision: 1 } });

    // Then one request survives and one trailing refresh retrieves later content.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    await act(async () => { first.resolve(conversationResponse('conversation-1')); });
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.conversation?.id).toBe('conversation-1');
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => { latest.resolve(conversationResponse('conversation-1', '2026-09-29T00:00:05.000Z', 'Updated message')); });
    expect(view.result.current.conversation?.updatedAt).toBe('2026-09-29T00:00:05.000Z');
    expect(view.result.current.conversation?.messages[0]?.content).toBe('Updated message');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('aborts the previous scope and ignores its late response and queued refresh', async () => {
    // Given a pending response with a queued refresh.
    const previous = deferredResponse();
    const current = deferredResponse();
    const fetch = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    const view = renderHook(({ id, refresh }) => useMapDesignConversation('project-1', id, refresh), {
      initialProps: { id: 'conversation-1', refresh: 0 },
    });
    view.rerender({ id: 'conversation-1', refresh: 1 });
    const signal = fetch.mock.calls[0]?.[1]?.signal;

    // When selection changes and the old response arrives after the new response.
    view.rerender({ id: 'conversation-2', refresh: 1 });
    expect(view.result.current.conversation).toBeNull();
    expect(view.result.current.loading).toBe(true);
    await act(async () => { current.resolve(conversationResponse('conversation-2')); });
    await act(async () => { previous.resolve(conversationResponse('conversation-1')); });

    // Then the previous scope cannot overwrite the selected conversation.
    expect(signal?.aborted).toBe(true);
    expect(view.result.current.conversation?.id).toBe('conversation-2');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('cancels pending and queued requests on unmount', async () => {
    // Given a pending request and another refresh.
    const pending = deferredResponse();
    const fetch = vi.spyOn(globalThis, 'fetch').mockReturnValue(pending.promise);
    const view = renderHook(({ refresh }) => useMapDesignConversation('project-1', 'conversation-1', refresh), {
      initialProps: { refresh: 0 },
    });
    view.rerender({ refresh: 1 });
    const signal = fetch.mock.calls[0]?.[1]?.signal;

    // When the hook unmounts before a response arrives.
    view.unmount();
    await act(async () => { pending.resolve(conversationResponse('conversation-1')); });

    // Then it cancels the request without starting the queued refresh.
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('clears failures when disabled and starts loading again when re-enabled', async () => {
    // Given a failed initial load.
    const pending = deferredResponse();
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('offline')).mockReturnValueOnce(pending.promise);
    const view = renderHook(({ enabled }) => useMapDesignConversation('project-1', 'conversation-1', 0, enabled), {
      initialProps: { enabled: true },
    });
    await act(async () => {});
    expect(view.result.current.failure).toEqual({ operation: 'load' });

    // When loading is disabled and then re-enabled.
    view.rerender({ enabled: false });
    expect(view.result.current.failure).toBeNull();
    expect(view.result.current.loading).toBe(false);
    view.rerender({ enabled: true });

    // Then the new request shows loading until it completes.
    expect(view.result.current.loading).toBe(true);
    await act(async () => { pending.resolve(conversationResponse('conversation-1')); });
    expect(view.result.current.conversation?.id).toBe('conversation-1');
    expect(view.result.current.loading).toBe(false);
  });
});
