// @vitest-environment jsdom

import type {
  MapDesignConversationRuntimeChoice,
  MapDesignRuntimeSelectionInput,
  UpdateMapDesignConversationRuntimeRequest,
} from '@mapseekai/contracts';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../../src/api/client', () => ({
  ApiClientError: class ApiClientError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string | null = null,
      readonly details: unknown = null,
    ) { super(message); }
  },
  getMapDesignConversationRuntime: api.get,
  updateMapDesignConversationRuntime: api.update,
}));

import { I18nProvider } from '../../../src/i18n';
import { useConversationRuntime } from '../../../src/map-design/chat/useConversationRuntime';

const choice = (
  agentId: string,
  revision: number,
  extra: Partial<MapDesignConversationRuntimeChoice> = {},
): MapDesignConversationRuntimeChoice => ({
  agentId,
  revision,
  updatedAt: `2026-09-02T00:00:0${revision}.000Z`,
  ...extra,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <I18nProvider initial="en">{children}</I18nProvider>
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  api.get.mockReset();
  api.update.mockReset();
});

describe('useConversationRuntime', () => {
  it('renders the effective normalized GET choice and surfaces its notice', async () => {
    const stored = choice('retired-agent', 7, { model: 'provider/retired', reasoning: 'removed' });
    const effective = choice('opencode', 7, { model: 'openai/gpt-5.6-luna' });
    api.get.mockResolvedValue({
      runtime: stored,
      effectiveRuntime: effective,
      normalizationNotice: 'The saved runtime is no longer selectable; a safe current choice was selected.',
    });
    const { result } = renderHook(
      () => useConversationRuntime({ projectId: 'map-1', conversationId: 'conversation-1' }),
      { wrapper: ({ children }) => <I18nProvider initial="zh-CN">{children}</I18nProvider> },
    );

    await waitFor(() => expect(result.current.runtime).toEqual(effective));
    expect(result.current.runtime).not.toEqual(stored);
    expect(result.current.notice).toBe(
      '守护进程已将运行时调整为可用的智能体或模型。',
    );
  });

  it('loads an authoritative runtime for only the selected conversation', async () => {
    api.get.mockImplementation((_projectId: string, conversationId: string) => Promise.resolve({
      runtime: choice(conversationId === 'conversation-a' ? 'codex' : 'opencode', 0),
    }));
    const { result, rerender } = renderHook(
      ({ conversationId }) => useConversationRuntime({ projectId: 'map-1', conversationId }),
      { initialProps: { conversationId: 'conversation-a' }, wrapper },
    );

    await waitFor(() => expect(result.current.runtime?.agentId).toBe('codex'));
    rerender({ conversationId: 'conversation-b' });
    expect(result.current.runtime).toBeNull();
    await waitFor(() => expect(result.current.runtime?.agentId).toBe('opencode'));
    expect(api.get).toHaveBeenNthCalledWith(1, 'map-1', 'conversation-a', expect.any(AbortSignal));
    expect(api.get).toHaveBeenNthCalledWith(2, 'map-1', 'conversation-b', expect.any(AbortSignal));
  });

  it('suppresses an aborted stale response after a conversation switch', async () => {
    const first = deferred<{ runtime: MapDesignConversationRuntimeChoice }>();
    api.get.mockImplementation((_projectId: string, conversationId: string) => conversationId === 'conversation-a'
      ? first.promise
      : Promise.resolve({ runtime: choice('opencode', 4) }));
    const { result, rerender } = renderHook(
      ({ conversationId }) => useConversationRuntime({ projectId: 'map-1', conversationId }),
      { initialProps: { conversationId: 'conversation-a' }, wrapper },
    );
    const firstSignal = api.get.mock.calls[0]?.[2] as AbortSignal;

    rerender({ conversationId: 'conversation-b' });
    expect(firstSignal.aborted).toBe(true);
    await waitFor(() => expect(result.current.runtime).toMatchObject({ agentId: 'opencode', revision: 4 }));
    await act(async () => first.resolve({ runtime: choice('codex', 1) }));
    expect(result.current.runtime).toMatchObject({ agentId: 'opencode', revision: 4 });
  });

  it('autosaves with CAS and applies the authoritative response', async () => {
    api.get.mockResolvedValue({ runtime: choice('codex', 0) });
    api.update.mockResolvedValue({ runtime: choice('opencode', 1, { model: 'openai/gpt-5.6-terra' }) });
    const { result } = renderHook(
      () => useConversationRuntime({ projectId: 'map-1', conversationId: 'conversation-1' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.runtime).not.toBeNull());
    const updateIdentity = result.current.update;

    await act(async () => {
      await result.current.update({
        agentId: 'opencode', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog',
      });
    });

    expect(api.update).toHaveBeenCalledWith(
      'map-1',
      'conversation-1',
      expect.objectContaining({
        expectedRevision: 0,
        runtime: { agentId: 'opencode', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog' },
        clientRequestId: expect.stringMatching(/^map-runtime:/u),
      }),
      expect.any(AbortSignal),
    );
    expect(result.current.runtime).toMatchObject({ agentId: 'opencode', revision: 1 });
    expect(result.current.update).toBe(updateIdentity);
  });

  it('announces the exact successful persistence result', async () => {
    api.get.mockResolvedValue({ runtime: choice('codex', 0) });
    api.update.mockResolvedValue({ runtime: choice('opencode', 1) });
    const { result } = renderHook(
      () => useConversationRuntime({ projectId: 'map-1', conversationId: 'conversation-1' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.runtime).not.toBeNull());

    await act(async () => result.current.update({ agentId: 'opencode' }));

    expect(result.current.notice).toBe('Runtime saved to this conversation.');
  });

  it('replays an uncertain logical update with the same request and idempotency key', async () => {
    api.get.mockResolvedValue({ runtime: choice('codex', 0) });
    api.update
      .mockRejectedValueOnce(new TypeError('network lost after commit'))
      .mockResolvedValueOnce({ runtime: choice('opencode', 1) });
    const { result } = renderHook(
      () => useConversationRuntime({ projectId: 'map-1', conversationId: 'conversation-1' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.runtime).not.toBeNull());
    const next: MapDesignRuntimeSelectionInput = { agentId: 'opencode' };

    await act(async () => result.current.update(next));
    await act(async () => result.current.update(next));

    const first = api.update.mock.calls[0]?.[2] as UpdateMapDesignConversationRuntimeRequest;
    const second = api.update.mock.calls[1]?.[2] as UpdateMapDesignConversationRuntimeRequest;
    expect(second).toEqual(first);
    expect(result.current.runtime).toMatchObject({ agentId: 'opencode', revision: 1 });
  });

  it('refreshes authoritative state after a CAS conflict', async () => {
    api.get
      .mockResolvedValueOnce({ runtime: choice('codex', 0) })
      .mockResolvedValueOnce({ runtime: choice('pi', 2, { model: 'anthropic/claude-sonnet' }) });
    api.update.mockRejectedValue(Object.assign(new Error('conflict'), { code: 'RUNTIME_CONFLICT' }));
    const { result } = renderHook(
      () => useConversationRuntime({ projectId: 'map-1', conversationId: 'conversation-1' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.runtime).not.toBeNull());

    await act(async () => result.current.update({ agentId: 'opencode' }));

    expect(api.get).toHaveBeenCalledTimes(2);
    expect(result.current.runtime).toMatchObject({ agentId: 'pi', revision: 2 });
    expect(result.current.notice).toMatch(/changed in another client/iu);
  });

  it('announces when the daemon normalizes an Agent or model choice', async () => {
    api.get.mockResolvedValue({ runtime: choice('codex', 0) });
    api.update.mockResolvedValue({ runtime: choice('opencode', 1, { model: 'openai/gpt-5.6-luna' }) });
    const { result } = renderHook(
      () => useConversationRuntime({ projectId: 'map-1', conversationId: 'conversation-1' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.runtime).not.toBeNull());

    await act(async () => result.current.update({ agentId: 'opencode', model: 'openai/gpt-5.6-terra' }));

    expect(result.current.notice).toMatch(/adjusted/iu);
  });

  it('localizes the normalization notice returned after saving', async () => {
    api.get.mockResolvedValue({ runtime: choice('codex', 0) });
    api.update.mockResolvedValue({ runtime: choice('opencode', 1), normalizationNotice: 'The saved model is no longer selectable; a safe default was selected.' });
    const { result } = renderHook(
      () => useConversationRuntime({ projectId: 'map-1', conversationId: 'conversation-1' }),
      { wrapper: ({ children }) => <I18nProvider initial="zh-CN">{children}</I18nProvider> },
    );
    await waitFor(() => expect(result.current.runtime).not.toBeNull());
    await act(async () => result.current.update({ agentId: 'opencode' }));
    expect(result.current.notice).toBe('守护进程已将运行时调整为可用的智能体或模型。');
  });

  it('synchronously rejects read-only and active-run mutations before a request', async () => {
    api.get.mockResolvedValue({ runtime: choice('codex', 0) });
    const { result, rerender } = renderHook(
      ({ disabled }) => useConversationRuntime({ projectId: 'map-1', conversationId: 'conversation-1', disabled }),
      { initialProps: { disabled: true }, wrapper },
    );
    await waitFor(() => expect(result.current.runtime).not.toBeNull());

    await act(async () => result.current.update({ agentId: 'opencode' }));
    rerender({ disabled: false });
    rerender({ disabled: true });
    await act(async () => result.current.update({ agentId: 'pi' }));

    expect(api.update).not.toHaveBeenCalled();
  });

  it('aborts an in-flight update and ignores its completion when the scope changes', async () => {
    api.get.mockImplementation((_projectId: string, conversationId: string) => Promise.resolve({
      runtime: choice(conversationId === 'conversation-a' ? 'codex' : 'pi', 0),
    }));
    const pending = deferred<{ runtime: MapDesignConversationRuntimeChoice }>();
    api.update.mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(
      ({ conversationId }) => useConversationRuntime({ projectId: 'map-1', conversationId }),
      { initialProps: { conversationId: 'conversation-a' }, wrapper },
    );
    await waitFor(() => expect(result.current.runtime?.agentId).toBe('codex'));
    let save!: Promise<void>;
    act(() => { save = result.current.update({ agentId: 'opencode' }); });
    const updateSignal = api.update.mock.calls[0]?.[3] as AbortSignal;

    rerender({ conversationId: 'conversation-b' });
    expect(updateSignal.aborted).toBe(true);
    await waitFor(() => expect(result.current.runtime?.agentId).toBe('pi'));
    await act(async () => pending.resolve({ runtime: choice('opencode', 1) }));
    await act(async () => save);
    expect(result.current.runtime?.agentId).toBe('pi');
  });
});

describe('conversation runtime API client', () => {
  it('returns the strict schema output rather than the unparsed transport object', async () => {
    const client = await vi.importActual<typeof import('../../../src/api/client')>('../../../src/api/client');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      runtime: {
        agentId: '  opencode  ',
        model: '  openai/gpt-5.6-terra  ',
        revision: 3,
        updatedAt: '2026-09-02T00:00:00.000Z',
      },
      effectiveRuntime: {
        agentId: '  opencode  ',
        model: '  openai/gpt-5.6-luna  ',
        revision: 3,
        updatedAt: '2026-09-02T00:00:00.000Z',
      },
      normalizationNotice: 'Saved runtime normalized.',
    }), { status: 200 }));

    await expect(client.getMapDesignConversationRuntime('map/one', 'conversation one')).resolves.toEqual({
      runtime: {
        agentId: 'opencode',
        model: 'openai/gpt-5.6-terra',
        revision: 3,
        updatedAt: '2026-09-02T00:00:00.000Z',
      },
      effectiveRuntime: {
        agentId: 'opencode',
        model: 'openai/gpt-5.6-luna',
        revision: 3,
        updatedAt: '2026-09-02T00:00:00.000Z',
      },
      normalizationNotice: 'Saved runtime normalized.',
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/map-design/projects/map%2Fone/conversations/conversation%20one/runtime',
      expect.anything(),
    );
  });

  it('sends the exact CAS update body to the conversation-scoped endpoint', async () => {
    const client = await vi.importActual<typeof import('../../../src/api/client')>('../../../src/api/client');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      runtime: choice('opencode', 1, { model: 'openai/gpt-5.6-terra' }),
      effectiveRuntime: choice('opencode', 1, { model: 'openai/gpt-5.6-terra' }),
    }), { status: 200 }));
    const input: UpdateMapDesignConversationRuntimeRequest = {
      expectedRevision: 0,
      runtime: { agentId: 'opencode', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog' },
      clientRequestId: 'map-runtime:test',
    };

    await client.updateMapDesignConversationRuntime('map-1', 'conversation-1', input);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/map-design/projects/map-1/conversations/conversation-1/runtime',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(input) }),
    );
  });
});
