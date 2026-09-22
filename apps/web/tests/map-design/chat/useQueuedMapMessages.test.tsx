// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapDesignRunStatus } from '@mapseekai/contracts';
import { useQueuedMapMessages, type PendingMapMessage } from '../../../src/map-design/chat/useQueuedMapMessages';

afterEach(cleanup);
const running = { sending: true, ready: false, status: 'running' as MapDesignRunStatus | 'idle', blocked: false };

describe('pending map messages', () => {
  it('queues during a run, preserves order, and waits for run cleanup before dispatch', async () => {
    const send = vi.fn(async (_message: PendingMapMessage) => true);
    const { result, rerender } = renderHook(props => useQueuedMapMessages({ ...props, send }), { initialProps: running });
    act(() => { result.current.enqueue('First'); result.current.enqueue('Second'); });
    expect(send).not.toHaveBeenCalled();
    rerender({ ...running, sending: false, status: 'succeeded' });
    expect(send).not.toHaveBeenCalled();
    rerender({ ...running, sending: false, ready: true, status: 'succeeded' });
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0]?.[0].prompt).toBe('First');
  });

  it('holds dispatch while editing, saves in place, and deletes only the selected row', async () => {
    const send = vi.fn(async (_message: PendingMapMessage) => true);
    const { result, rerender } = renderHook(props => useQueuedMapMessages({ ...props, send }), { initialProps: running });
    act(() => { result.current.enqueue('First'); result.current.enqueue('Second'); });
    const [first, second] = result.current.items;
    if (!first || !second) throw new Error('Missing queued messages');
    act(() => result.current.edit(first.id));
    rerender({ ...running, sending: false, ready: true, status: 'succeeded' });
    expect(send).not.toHaveBeenCalled();
    act(() => { result.current.remove(second.id); result.current.save(first.id, 'Edited first'); });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toMatchObject({ id: first.id, prompt: 'Edited first' });
    await waitFor(() => expect(result.current.items).toHaveLength(0));
  });

  it('locks a submitting row and retains a rejected submission for explicit retry', async () => {
    let finish: (accepted: boolean) => void = () => undefined;
    const send = vi.fn((_message: PendingMapMessage) => new Promise<boolean>(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useQueuedMapMessages({ ...running, sending: false, ready: true, status: 'idle', send }));
    act(() => result.current.enqueue('Keep me'));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const id = result.current.items[0]?.id;
    if (!id) throw new Error('Missing submitting row');
    act(() => { result.current.edit(id); result.current.remove(id); });
    expect(result.current.editingId).toBeNull();
    expect(result.current.items).toHaveLength(1);
    await act(async () => finish(false));
    expect(result.current.paused).toBe(true);
    expect(result.current.items[0]?.prompt).toBe('Keep me');
    act(() => result.current.resume());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await act(async () => finish(true));
  });

  it.each(['failed', 'canceled'] as const)('pauses pending messages after %s without dropping them', async status => {
    const send = vi.fn(async (_message: PendingMapMessage) => true);
    const { result, rerender } = renderHook(props => useQueuedMapMessages({ ...props, send }), { initialProps: running });
    act(() => result.current.enqueue('Later'));
    rerender({ ...running, sending: false, ready: true, status });
    expect(result.current.paused).toBe(true);
    expect(send).not.toHaveBeenCalled();
    act(() => result.current.resume());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it('keeps blocked queues and rejects empty or excessive prompts', () => {
    const send = vi.fn(async (_message: PendingMapMessage) => true);
    const { result, rerender } = renderHook(props => useQueuedMapMessages({ ...props, send }), { initialProps: running });
    act(() => {
      expect(result.current.enqueue('   ')).toBe(false);
      expect(result.current.enqueue('x'.repeat(16_385))).toBe(false);
      result.current.enqueue('Existing');
    });
    rerender({ ...running, sending: false, ready: true, blocked: true });
    act(() => expect(result.current.enqueue('Blocked')).toBe(false));
    expect(result.current.items).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
    const item = result.current.items[0];
    if (!item) throw new Error('Missing blocked queue entry');
    act(() => { result.current.edit(item.id); result.current.save(item.id, 'Editable while unavailable'); });
    expect(result.current.items[0]?.prompt).toBe('Editable while unavailable');
    act(() => result.current.remove(item.id));
    expect(result.current.items).toHaveLength(0);
  });
});
