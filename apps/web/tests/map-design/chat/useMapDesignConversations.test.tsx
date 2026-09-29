// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError, listMapDesignConversations } from '../../../src/api/client';
import { I18nProvider } from '../../../src/i18n';
import { useMapDesignConversations } from '../../../src/map-design/chat/useMapDesignConversations';
import { useMapDesignConversation } from '../../../src/map-design/chat/useMapDesignConversation';

const first = {
  conversationId: 'conversation-1', projectId: 'project-1', title: 'First conversation',
  titleIsDefault: false,
  messageCount: 2, createdAt: '2026-08-27T00:00:00.000Z', lastActivityAt: '2026-08-27T00:01:00.000Z', runState: 'idle' as const,
};
const newest = {
  conversationId: 'conversation-2', projectId: 'project-1', title: 'Newest conversation',
  titleIsDefault: false,
  messageCount: 0, createdAt: '2026-08-27T00:02:00.000Z', lastActivityAt: '2026-08-27T00:02:00.000Z', runState: 'running' as const,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function localeWrapper(locale: 'ar' | 'de' | 'fa') {
  return function LocaleWrapper({ children }: { children: ReactNode }) {
    return <I18nProvider initial={locale}>{children}</I18nProvider>;
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('useMapDesignConversations', () => {
  it('switches away from a deleted conversation and clears the URL after the last deletion', async () => {
    window.history.replaceState({}, '', '/projects/project-1?conversation=conversation-1');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => init?.method === 'DELETE'
      ? new Response(null, { status: 204 }) : json({ conversations: [first, { ...newest, runState: 'idle' }] }));
    const view = renderHook(() => useMapDesignConversations('project-1', 'conversation-1'));
    await waitFor(() => expect(view.result.current.selected?.conversationId).toBe('conversation-1'));
    await act(async () => { expect(await view.result.current.remove('conversation-1')).toBe(true); });
    await waitFor(() => expect(view.result.current.selected?.conversationId).toBe('conversation-2'));
    expect(window.location.search).toBe('?conversation=conversation-2');
    expect(view.result.current.notice).toBeNull();
    await act(async () => { await view.result.current.remove('conversation-2'); });
    await waitFor(() => expect(view.result.current.selected).toBeNull());
    expect(window.location.search).toBe('');
    expect(view.result.current.conversations).toHaveLength(0);
  });

  it('preserves the selection when deletion fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => init?.method === 'DELETE'
      ? json({ error: { code: 'RUNTIME_CONFLICT', message: 'running' } }, 409) : json({ conversations: [first] }));
    const view = renderHook(() => useMapDesignConversations('project-1', 'conversation-1'));
    await waitFor(() => expect(view.result.current.selected).not.toBeNull());
    await act(async () => { await expect(view.result.current.remove('conversation-1')).rejects.toMatchObject({ code: 'RUNTIME_CONFLICT' }); });
    expect(view.result.current.selected?.conversationId).toBe('conversation-1');
    expect(view.result.current.conversations).toHaveLength(1);
  });

  it('refreshes active summaries after completion so map editing is not left locked', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ conversations: [newest] }))
      .mockResolvedValue(json({ conversations: [{ ...newest, runState: 'idle' }] }));
    const view = renderHook(() => useMapDesignConversations('project-1', 'conversation-2'));
    await act(async () => { await Promise.resolve(); });
    expect(view.result.current.conversations[0]?.runState).toBe('running');
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(view.result.current.conversations[0]?.runState).toBe('idle');
    const calls = vi.mocked(fetch).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  });

  it('retries a retained create receipt after a historical transition aborts its lost response', async () => {
    let resolveLostResponse: ((response: Response) => void) | undefined;
    let resolveRetry: ((response: Response) => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    const createBodies: string[] = [];
    let createAttempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) !== '/api/map-design/projects/project-1/conversations') return Promise.reject(new Error('unexpected request'));
      if (init?.method === 'POST') {
        createAttempts += 1;
        createBodies.push(String(init.body));
        if (createAttempts === 1) {
          firstSignal = init.signal ?? undefined;
          return new Promise<Response>((resolve) => { resolveLostResponse = resolve; });
        }
        return new Promise<Response>((resolve) => { resolveRetry = resolve; });
      }
      return Promise.resolve(json({ conversations: [first] }));
    });
    const view = renderHook(({ readOnly }) => useMapDesignConversations('project-1', null, readOnly), {
      initialProps: { readOnly: false },
    });
    await waitFor(() => expect(view.result.current.selected?.conversationId).toBe('conversation-1'));

    let initialCreate: Promise<void> | undefined;
    await act(async () => { initialCreate = view.result.current.create(); await Promise.resolve(); });
    expect(createAttempts).toBe(1);
    view.rerender({ readOnly: true });
    expect(firstSignal?.aborted).toBe(true);
    await waitFor(() => expect(view.result.current.failure).toEqual({ operation: 'create' }));

    await act(async () => {
      resolveLostResponse?.(json({ conversation: newest }, 201));
      await initialCreate;
    });
    view.rerender({ readOnly: false });
    let retry: Promise<void> | undefined;
    await act(async () => { retry = view.result.current.retry(); await Promise.resolve(); });
    expect(createAttempts).toBe(2);
    expect(createBodies[1]).toBe(createBodies[0]);

    await act(async () => {
      resolveRetry?.(json({ conversation: newest }, 201));
      await retry;
    });
    expect(view.result.current.conversations.filter(({ conversationId }) => conversationId === newest.conversationId)).toHaveLength(1);
    expect(view.result.current.selected?.conversationId).toBe(newest.conversationId);
  });

  it('blocks stale create and create-retry handlers before they can POST after historical mode begins', async () => {
    let postCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) !== '/api/map-design/projects/project-1/conversations') return Promise.reject(new Error('unexpected request'));
      if (init?.method === 'POST') {
        postCount += 1;
        return Promise.reject(new Error('create unavailable'));
      }
      return Promise.resolve(json({ conversations: [first] }));
    });
    const view = renderHook(({ readOnly }) => useMapDesignConversations('project-1', null, readOnly), {
      initialProps: { readOnly: false },
    });
    await waitFor(() => expect(view.result.current.selected?.conversationId).toBe('conversation-1'));

    await act(async () => { await view.result.current.create(); });
    await waitFor(() => expect(view.result.current.failure).toEqual({ operation: 'create' }));
    const staleCreate = view.result.current.create;
    const staleRetry = view.result.current.retry;
    view.rerender({ readOnly: true });
    await act(async () => { await staleCreate(); await staleRetry(); });

    expect(postCount).toBe(1);
  });
  it('rejects a collection response with an invalid run state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ conversations: [{ ...first, runState: 'queued' }] }));

    await expect(listMapDesignConversations('project-1')).rejects.toMatchObject({
      message: 'The local daemon returned an invalid response.',
    });
  });

  it('rejects summaries that omit the explicit default-title state', async () => {
    const { titleIsDefault: _omitted, ...withoutDefaultState } = first;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ conversations: [withoutDefaultState] }));

    await expect(listMapDesignConversations('project-1')).rejects.toMatchObject({
      message: 'The local daemon returned an invalid response.',
    });
  });

  it('localizes a real initial list Error and retries without changing unrelated URL state', async () => {
    window.history.replaceState({}, '', '/studio?panel=map#chat');
    let attempts = 0;
    let resolveRetry: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('daemon unavailable'))
        : new Promise<Response>((resolve) => { resolveRetry = resolve; });
    });

    const view = renderHook(() => useMapDesignConversations('project-1', null), { wrapper: localeWrapper('de') });
    await waitFor(() => expect(view.result.current.error).toBe('Die Unterhaltungen konnten nicht geladen werden.'));
    expect(view.result.current.failure).toEqual({ operation: 'list' });
    expect(view.result.current.error).not.toContain('daemon unavailable');
    expect(view.result.current.loading).toBe(false);
    const failedUrl = window.location.href;

    let retry: Promise<void> | undefined;
    await act(async () => { retry = view.result.current.retry(); await Promise.resolve(); });
    expect(view.result.current.loading).toBe(true);
    expect(view.result.current.error).toBeNull();
    await act(async () => { resolveRetry?.(json({ conversations: [first] })); await retry; });

    expect(view.result.current.selected?.conversationId).toBe('conversation-1');
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.loading).toBe(false);
    expect(window.location.href).toBe(`${failedUrl.split('?')[0]}?panel=map&conversation=conversation-1#chat`);
  });

  it('preserves selection through a refresh failure and clears the error after the next refresh succeeds', async () => {
    window.history.replaceState({}, '', '/studio?panel=map&conversation=missing#chat');
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      attempts += 1;
      if (attempts === 1) return Promise.resolve(json({ conversations: [first] }));
      if (attempts === 2) return Promise.reject(new Error('temporary outage'));
      return Promise.resolve(json({ conversations: [{ ...first, title: 'Promoted title', titleIsDefault: false }] }));
    });

    const view = renderHook(() => useMapDesignConversations('project-1', 'missing'));
    await waitFor(() => expect(view.result.current.selected?.conversationId).toBe('conversation-1'));
    const selectedBeforeFailure = view.result.current.selected;
    const fallbackNotice = view.result.current.notice;
    const selectedUrl = window.location.href;

    await act(async () => { await view.result.current.refresh(); });
    expect(view.result.current.error).toBe('The conversations could not be loaded.');
    expect(view.result.current.failure).toEqual({ operation: 'list' });
    expect(view.result.current.selected).toBe(selectedBeforeFailure);
    expect(view.result.current.notice).toBe(fallbackNotice);
    expect(window.location.href).toBe(selectedUrl);

    await act(async () => { await view.result.current.retry(); });
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.selected).toMatchObject({ title: 'Promoted title' });
    expect(view.result.current.notice).toBe(fallbackNotice);
    expect(window.location.href).toBe(selectedUrl);
  });

  it('creates a conversation before selecting it and writes the conversation query parameter', async () => {
    let resolveCreate: ((response: Response) => void) | undefined;
    const replaceState = vi.spyOn(window.history, 'replaceState');
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) === '/api/map-design/projects/project-1/conversations' && init?.method === undefined) {
        return Promise.resolve(json({ conversations: [first] }));
      }
      if (String(input) === '/api/map-design/projects/project-1/conversations' && init?.method === 'POST') {
        return new Promise<Response>((resolve) => { resolveCreate = resolve; });
      }
      return Promise.reject(new Error(`Unexpected request ${String(input)}`));
    });

    const view = renderHook(() => useMapDesignConversations('project-1', null));
    await waitFor(() => expect(view.result.current.selected?.conversationId).toBe('conversation-1'));
    expect(window.location.search).toBe('?conversation=conversation-1');
    expect(replaceState).toHaveBeenCalledTimes(1);

    let created: Promise<void> | undefined;
    await act(async () => { created = view.result.current.create(); await Promise.resolve(); });
    expect(view.result.current.selected?.conversationId).toBe('conversation-1');

    await act(async () => {
      resolveCreate?.(json({ conversation: newest }, 201));
      await created;
    });
    expect(view.result.current.selected?.conversationId).toBe('conversation-2');
    expect(window.location.search).toBe('?conversation=conversation-2');
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it('falls back from a missing deep link to the newest conversation, preserves other parameters, and announces it once', async () => {
    window.history.replaceState({}, '', '/studio?panel=map&conversation=missing#chat');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ conversations: [newest, first] }));

    const view = renderHook(() => useMapDesignConversations('project-1', 'missing'));
    await waitFor(() => expect(view.result.current.selected?.conversationId).toBe('conversation-2'));

    expect(view.result.current.notice).toBe('The requested conversation is unavailable. Showing the newest conversation.');
    expect(window.location.search).toBe('?panel=map&conversation=conversation-2');
    expect(window.location.hash).toBe('#chat');
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it('responds to browser history selection only when that conversation belongs to the fetched project list', async () => {
    window.history.replaceState({}, '', '/studio?conversation=conversation-1');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ conversations: [newest, first] }));

    const view = renderHook(() => useMapDesignConversations('project-1', 'conversation-1'));
    await waitFor(() => expect(view.result.current.selected?.conversationId).toBe('conversation-1'));

    window.history.pushState({}, '', '/studio?conversation=foreign-conversation');
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
    await waitFor(() => expect(view.result.current.selected?.conversationId).toBe('conversation-2'));
    expect(window.location.search).toBe('?conversation=conversation-2');
  });

  it('aborts a stale project list request before loading the next project', async () => {
    let firstSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) === '/api/map-design/projects/project-1/conversations') {
        firstSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }
      if (String(input) === '/api/map-design/projects/project-2/conversations') {
        return Promise.resolve(json({ conversations: [{ ...newest, projectId: 'project-2' }] }));
      }
      return Promise.reject(new Error(`Unexpected request ${String(input)}`));
    });

    const view = renderHook(({ projectId }) => useMapDesignConversations(projectId, null), {
      initialProps: { projectId: 'project-1' },
    });
    await waitFor(() => expect(firstSignal).toBeDefined());
    view.rerender({ projectId: 'project-2' });
    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    await waitFor(() => expect(view.result.current.selected?.projectId).toBe('project-2'));
  });

  it('replaces a stale selected summary with the authoritative server title after a refresh', async () => {
    let listRequests = 0;
    const provisional = { ...newest, title: 'New conversation', messageCount: 0, runState: 'idle' as const };
    const promoted = {
      ...provisional,
      title: 'Review park colors',
      messageCount: 1,
      lastActivityAt: '2026-08-27T00:03:00.000Z',
      runState: 'running' as const,
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input) !== '/api/map-design/projects/project-1/conversations') return Promise.reject(new Error(`Unexpected request ${String(input)}`));
      listRequests += 1;
      return Promise.resolve(json({ conversations: [listRequests === 1 ? provisional : promoted] }));
    });

    const view = renderHook(() => useMapDesignConversations('project-1', null));
    await waitFor(() => expect(view.result.current.selected?.title).toBe('New conversation'));

    await act(async () => { await view.result.current.refresh(); });

    expect(view.result.current.selected).toMatchObject({
      title: 'Review park colors', messageCount: 1, lastActivityAt: '2026-08-27T00:03:00.000Z', runState: 'running',
    });
  });

  it('aborts an authoritative refresh before a new project can receive its stale response', async () => {
    let resolveRefresh: ((response: Response) => void) | undefined;
    let refreshSignal: AbortSignal | undefined;
    let projectOneRequests = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/map-design/projects/project-1/conversations') {
        projectOneRequests += 1;
        if (projectOneRequests === 1) return Promise.resolve(json({ conversations: [first] }));
        refreshSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
      }
      if (url === '/api/map-design/projects/project-2/conversations') {
        return Promise.resolve(json({ conversations: [{ ...newest, projectId: 'project-2' }] }));
      }
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });

    const view = renderHook(({ projectId }) => useMapDesignConversations(projectId, null), {
      initialProps: { projectId: 'project-1' },
    });
    await waitFor(() => expect(view.result.current.selected?.conversationId).toBe('conversation-1'));

    let refresh: Promise<void> | undefined;
    await act(async () => { refresh = view.result.current.refresh(); await Promise.resolve(); });
    await waitFor(() => expect(refreshSignal).toBeDefined());
    view.rerender({ projectId: 'project-2' });
    await waitFor(() => expect(refreshSignal?.aborted).toBe(true));
    await waitFor(() => expect(view.result.current.selected?.projectId).toBe('project-2'));

    await act(async () => {
      resolveRefresh?.(json({ conversations: [{ ...first, title: 'Stale project one' }] }));
      await refresh;
    });
    expect(view.result.current.conversations).toEqual([{ ...newest, projectId: 'project-2' }]);
  });

  it('aborts the current authoritative refresh on unmount before a late response can replace summaries', async () => {
    let resolveRefresh: ((response: Response) => void) | undefined;
    let refreshSignal: AbortSignal | undefined;
    let listRequests = 0;
    const provisional = { ...newest, title: 'New conversation', messageCount: 0, runState: 'idle' as const };
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) !== '/api/map-design/projects/project-1/conversations') return Promise.reject(new Error(`Unexpected request ${String(input)}`));
      listRequests += 1;
      if (listRequests === 1) return Promise.resolve(json({ conversations: [provisional] }));
      refreshSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    });

    const view = renderHook(() => useMapDesignConversations('project-1', null));
    await waitFor(() => expect(view.result.current.selected?.title).toBe('New conversation'));
    let refresh: Promise<void> | undefined;
    await act(async () => { refresh = view.result.current.refresh(); await Promise.resolve(); });
    await waitFor(() => expect(refreshSignal).toBeDefined());

    view.unmount();
    expect(refreshSignal?.aborted).toBe(true);
    await act(async () => {
      resolveRefresh?.(json({ conversations: [{ ...provisional, title: 'Late title', messageCount: 1 }] }));
      await refresh;
    });
    expect(view.result.current.selected?.title).toBe('New conversation');
  });

  it('aborts an in-flight create when the project changes', async () => {
    let createSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/map-design/projects/project-1/conversations' && init?.method === undefined) {
        return Promise.resolve(json({ conversations: [first] }));
      }
      if (url === '/api/map-design/projects/project-1/conversations' && init?.method === 'POST') {
        createSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }
      if (url === '/api/map-design/projects/project-2/conversations') {
        return Promise.resolve(json({ conversations: [{ ...newest, projectId: 'project-2' }] }));
      }
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });

    const view = renderHook(({ projectId }) => useMapDesignConversations(projectId, null), {
      initialProps: { projectId: 'project-1' },
    });
    await waitFor(() => expect(view.result.current.selected?.conversationId).toBe('conversation-1'));
    await act(async () => { void view.result.current.create(); await Promise.resolve(); });
    await waitFor(() => expect(createSignal).toBeDefined());
    view.rerender({ projectId: 'project-2' });
    await waitFor(() => expect(createSignal?.aborted).toBe(true));
  });

  it('keeps a successfully created conversation selected when a stale list resolves afterward', async () => {
    let resolveList: ((response: Response) => void) | undefined;
    let resolveCreate: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) === '/api/map-design/projects/project-1/conversations' && init?.method === undefined) {
        return new Promise<Response>((resolve) => { resolveList = resolve; });
      }
      if (String(input) === '/api/map-design/projects/project-1/conversations' && init?.method === 'POST') {
        return new Promise<Response>((resolve) => { resolveCreate = resolve; });
      }
      return Promise.reject(new Error(`Unexpected request ${String(input)}`));
    });

    const view = renderHook(() => useMapDesignConversations('project-1', null));
    let created: Promise<void> | undefined;
    await act(async () => { created = view.result.current.create(); await Promise.resolve(); });
    await act(async () => {
      resolveCreate?.(json({ conversation: newest }, 201));
      await created;
    });
    expect(view.result.current.selected?.conversationId).toBe('conversation-2');
    expect(window.location.search).toBe('?conversation=conversation-2');

    await act(async () => { resolveList?.(json({ conversations: [first] })); });
    expect(view.result.current.conversations).toContainEqual(first);
    expect(view.result.current.conversations).toContainEqual(newest);
    expect(view.result.current.selected?.conversationId).toBe('conversation-2');
    expect(window.location.search).toBe('?conversation=conversation-2');
  });

  it('retries a localized failed create with the same key and selects one durable conversation', async () => {
    let rejectCreate: ((reason: ApiClientError) => void) | undefined;
    let resolveRetry: ((response: Response) => void) | undefined;
    const createBodies: string[] = [];
    let createAttempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) === '/api/map-design/projects/project-1/conversations' && init?.method === undefined) {
        return Promise.resolve(json({ conversations: [first] }));
      }
      if (String(input) === '/api/map-design/projects/project-1/conversations' && init?.method === 'POST') {
        createAttempts += 1;
        createBodies.push(String(init.body));
        if (createAttempts === 1) return new Promise<Response>((_resolve, reject) => { rejectCreate = reject; });
        return new Promise<Response>((resolve) => { resolveRetry = resolve; });
      }
      return Promise.reject(new Error(`Unexpected request ${String(input)}`));
    });

    const view = renderHook(() => useMapDesignConversations('project-1', null), { wrapper: localeWrapper('ar') });
    await waitFor(() => expect(view.result.current.selected?.conversationId).toBe('conversation-1'));
    let firstCreate: Promise<void> | undefined;
    await act(async () => {
      firstCreate = view.result.current.create();
      await view.result.current.create();
    });
    expect(createAttempts).toBe(1);

    await act(async () => {
      rejectCreate?.(new ApiClientError('تفاصيل داخلية من الخادم', 503, 'UNAVAILABLE'));
      await firstCreate;
    });
    expect(view.result.current.error).toBe('تعذّر إنشاء المحادثة.');
    expect(view.result.current.failure).toEqual({ operation: 'create' });
    expect(view.result.current.error).not.toContain('تفاصيل داخلية');
    const selectedBeforeRetry = view.result.current.selected;
    const urlBeforeRetry = window.location.href;

    let retry: Promise<void> | undefined;
    await act(async () => {
      retry = view.result.current.retry();
      void view.result.current.retry();
      await Promise.resolve();
    });
    expect(createAttempts).toBe(2);
    expect(createBodies[1]).toBe(createBodies[0]);
    expect(view.result.current.selected).toBe(selectedBeforeRetry);
    expect(window.location.href).toBe(urlBeforeRetry);

    await act(async () => {
      resolveRetry?.(json({ conversation: newest }, 201));
      await retry;
    });
    expect(view.result.current.conversations.filter((conversation) => conversation.conversationId === 'conversation-2')).toHaveLength(1);
    expect(view.result.current.selected?.conversationId).toBe('conversation-2');
    expect(view.result.current.failure).toBeNull();
    expect(window.location.search).toBe('?conversation=conversation-2');
  });

  it('starts one retained create retry while a list retry is still pending', async () => {
    let getAttempts = 0;
    let postAttempts = 0;
    let resolveListRetry: ((response: Response) => void) | undefined;
    let resolveCreateRetry: ((response: Response) => void) | undefined;
    const createBodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) !== '/api/map-design/projects/project-1/conversations') {
        return Promise.reject(new Error(`Unexpected request ${String(input)}`));
      }
      if (init?.method === 'POST') {
        postAttempts += 1;
        createBodies.push(String(init.body));
        if (postAttempts === 1) return Promise.reject(new Error('create failed'));
        return new Promise<Response>((resolve) => { resolveCreateRetry = resolve; });
      }
      getAttempts += 1;
      if (getAttempts === 1) return Promise.resolve(json({ conversations: [first] }));
      if (getAttempts === 2) return Promise.reject(new Error('list failed'));
      return new Promise<Response>((resolve) => { resolveListRetry = resolve; });
    });

    const view = renderHook(() => useMapDesignConversations('project-1', null));
    await waitFor(() => expect(view.result.current.selected?.conversationId).toBe('conversation-1'));
    await act(async () => { await view.result.current.refresh(); });
    expect(view.result.current.failure).toEqual({ operation: 'list' });

    let listRetry: Promise<void> | undefined;
    await act(async () => {
      listRetry = view.result.current.retry();
      void view.result.current.retry();
      await Promise.resolve();
    });
    expect(getAttempts).toBe(3);

    await act(async () => { await view.result.current.create(); });
    expect(view.result.current.failure).toEqual({ operation: 'create' });

    let createRetry: Promise<void> | undefined;
    await act(async () => {
      createRetry = view.result.current.retry();
      void view.result.current.retry();
      await Promise.resolve();
    });
    expect(postAttempts).toBe(2);
    expect(createBodies[1]).toBe(createBodies[0]);

    await act(async () => {
      resolveCreateRetry?.(json({ conversation: newest }, 201));
      await createRetry;
    });
    expect(view.result.current.selected?.conversationId).toBe('conversation-2');

    await act(async () => {
      resolveListRetry?.(json({ conversations: [first] }));
      await listRetry;
    });
    expect(view.result.current.selected?.conversationId).toBe('conversation-2');
    expect(view.result.current.conversations.filter(({ conversationId }) => conversationId === 'conversation-2')).toHaveLength(1);
  });

  it('starts one list retry while a retained create retry is still pending', async () => {
    let getAttempts = 0;
    let postAttempts = 0;
    let resolveListRetry: ((response: Response) => void) | undefined;
    let resolveCreateRetry: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) !== '/api/map-design/projects/project-1/conversations') {
        return Promise.reject(new Error(`Unexpected request ${String(input)}`));
      }
      if (init?.method === 'POST') {
        postAttempts += 1;
        if (postAttempts === 1) return Promise.reject(new Error('create failed'));
        return new Promise<Response>((resolve) => { resolveCreateRetry = resolve; });
      }
      getAttempts += 1;
      if (getAttempts === 1) return Promise.resolve(json({ conversations: [first] }));
      if (getAttempts === 2) return Promise.reject(new Error('list failed'));
      return new Promise<Response>((resolve) => { resolveListRetry = resolve; });
    });

    const view = renderHook(() => useMapDesignConversations('project-1', null));
    await waitFor(() => expect(view.result.current.selected?.conversationId).toBe('conversation-1'));
    await act(async () => { await view.result.current.create(); });
    expect(view.result.current.failure).toEqual({ operation: 'create' });

    let createRetry: Promise<void> | undefined;
    await act(async () => {
      createRetry = view.result.current.retry();
      void view.result.current.retry();
      await Promise.resolve();
    });
    expect(postAttempts).toBe(2);

    await act(async () => { await view.result.current.refresh(); });
    expect(view.result.current.failure).toEqual({ operation: 'list' });

    let listRetry: Promise<void> | undefined;
    await act(async () => {
      listRetry = view.result.current.retry();
      void view.result.current.retry();
      await Promise.resolve();
    });
    expect(getAttempts).toBe(3);

    await act(async () => {
      resolveListRetry?.(json({ conversations: [first] }));
      await listRetry;
    });
    expect(view.result.current.selected?.conversationId).toBe('conversation-1');

    await act(async () => {
      resolveCreateRetry?.(json({ conversation: newest }, 201));
      await createRetry;
    });
    expect(view.result.current.selected?.conversationId).toBe('conversation-2');
    expect(view.result.current.conversations.filter(({ conversationId }) => conversationId === 'conversation-2')).toHaveLength(1);
  });

  it('localizes explicit conversation-load failures without rendering daemon detail', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new ApiClientError('پیام خام سرویس', 500, 'INTERNAL'));

    const view = renderHook(() => useMapDesignConversation('project-1', 'conversation-1'), {
      wrapper: localeWrapper('fa'),
    });

    await waitFor(() => expect(view.result.current.error).toBe('گفت‌وگو بارگیری نشد.'));
    expect(view.result.current.failure).toEqual({ operation: 'load' });
    expect(view.result.current.error).not.toContain('پیام خام');
  });

  it('clears old messages and aborts their request when the selected conversation changes', async () => {
    let firstSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) === '/api/map-design/projects/project-1/conversations/conversation-1') {
        firstSignal = init?.signal ?? undefined;
        return Promise.resolve(json({
          id: 'conversation-1', projectId: 'project-1', createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z', activeRun: null, messages: [],
        }));
      }
      if (String(input) === '/api/map-design/projects/project-1/conversations/conversation-2') {
        return new Promise<Response>(() => {});
      }
      return Promise.reject(new Error(`Unexpected request ${String(input)}`));
    });

    const view = renderHook(({ conversationId }) => useMapDesignConversation('project-1', conversationId), {
      initialProps: { conversationId: 'conversation-1' },
    });
    await waitFor(() => expect(view.result.current.conversation?.id).toBe('conversation-1'));
    view.rerender({ conversationId: 'conversation-2' });
    expect(view.result.current.conversation).toBeNull();
    expect(firstSignal?.aborted).toBe(true);
  });
});
