// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMapDesignEvents } from '../../src/map-design/hooks/useMapDesignEvents';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  readonly close = vi.fn();
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener(name: string, listener: EventListenerOrEventListenerObject) {
    const callback = listener as (event: MessageEvent) => void;
    const values = this.listeners.get(name) ?? new Set();
    values.add(callback);
    this.listeners.set(name, values);
  }
  removeEventListener(name: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.get(name)?.delete(listener as (event: MessageEvent) => void);
  }
  emit(name: string, data: unknown) {
    for (const listener of this.listeners.get(name) ?? []) listener(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
  capture(name: string) {
    return [...(this.listeners.get(name) ?? [])][0];
  }
}

describe('useMapDesignEvents', () => {
  afterEach(() => { cleanup(); FakeEventSource.instances = []; });

  it('reconnects with the confirmed cursor and reloads canonical state on open', async () => {
    const callbacks: Array<() => void> = [];
    const controller = { handleRecord: vi.fn(async () => {}), handleGap: vi.fn(async () => {}), reload: vi.fn(async () => {}) };
    const view = renderHook(() => useMapDesignEvents({ projectId: 'project-a', controller, EventSource: FakeEventSource as any,
      scheduleRetry: (callback) => { callbacks.push(callback); return vi.fn(); } }));
    const first = FakeEventSource.instances[0]!;
    const record = { sequence: 7, event: { type: 'project.lifecycle.updated', occurredAt: '2026-08-15T00:00:00.000Z', payload: { lifecycle: 'ready', failure: null } } };
    await act(async () => first.emit('map-design-event', record));
    const late = first.capture('map-design-event');
    act(() => first.emit('error', {}));
    expect(first.close).toHaveBeenCalledOnce();
    expect(view.result.current.status).toBe('recovering');
    act(() => callbacks.shift()?.());
    const second = FakeEventSource.instances[1]!;
    expect(second.url).toBe('/api/map-design/projects/project-a/events?after=7');
    await act(async () => second.emit('open', {}));
    expect(controller.reload).toHaveBeenCalledWith('event-recovery');
    expect(view.result.current.status).toBe('listening');
    late?.(new MessageEvent('map-design-event', { data: JSON.stringify(record) }));
    expect(controller.handleRecord).toHaveBeenCalledOnce();
    view.unmount();
    expect(second.close).toHaveBeenCalledOnce();
    expect([...second.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it('replays unconfirmed records and accepts a lower authoritative gap cursor', async () => {
    const callbacks: Array<() => void> = [];
    let finishRecord!: () => void;
    const controller = { handleRecord: vi.fn(async () => {}).mockImplementationOnce(() => new Promise<void>((resolve) => { finishRecord = resolve; })), handleGap: vi.fn(async () => {}), reload: vi.fn(async () => {}) };
    renderHook(() => useMapDesignEvents({ projectId: 'project-a', controller, EventSource: FakeEventSource as any,
      scheduleRetry: (callback) => { callbacks.push(callback); return vi.fn(); } }));
    const first = FakeEventSource.instances[0]!;
    await act(async () => first.emit('map-design-gap', { latestSequence: 4 }));
    act(() => first.emit('map-design-event', { sequence: 7, event: { type: 'project.lifecycle.updated', occurredAt: '2026-08-15T00:00:00.000Z', payload: { lifecycle: 'ready', failure: null } } }));
    await act(async () => first.emit('map-design-event', { sequence: 8, event: { type: 'project.lifecycle.updated', occurredAt: '2026-08-15T00:00:01.000Z', payload: { lifecycle: 'ready', failure: null } } }));
    act(() => first.emit('error', {}));
    await act(async () => finishRecord());
    act(() => callbacks.shift()?.());
    const second = FakeEventSource.instances[1]!;
    expect(second.url).toContain('after=4');
    await act(async () => second.emit('map-design-gap', { latestSequence: 2 }));
    act(() => second.emit('error', {}));
    act(() => callbacks.shift()?.());
    expect(FakeEventSource.instances[2]!.url).toContain('after=2');
  });

  it('bounds transport reconnect attempts and ignores timers after unmount', () => {
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];
    const controller = { handleRecord: vi.fn(), handleGap: vi.fn(), reload: vi.fn() };
    const view = renderHook(() => useMapDesignEvents({ projectId: 'project-a', controller, EventSource: FakeEventSource as any,
      recovery: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20 },
      scheduleRetry: (callback, delay) => { callbacks.push(callback); delays.push(delay); return vi.fn(); } }));
    act(() => FakeEventSource.instances[0]!.emit('error', {}));
    act(() => callbacks.shift()?.());
    expect(FakeEventSource.instances[1]!.url).toContain('after=0');
    act(() => FakeEventSource.instances[1]!.emit('error', {}));
    const lateTimer = callbacks[0]!;
    act(() => callbacks.shift()?.());
    act(() => FakeEventSource.instances[2]!.emit('error', {}));
    expect(delays).toEqual([10, 20]);
    expect(callbacks).toHaveLength(0);
    expect(view.result.current.status).toBe('recovery-failed');
    view.unmount();
    lateTimer();
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('uses the project navigation authority query and closes/recreates on project change', () => {
    const controller = { handleRecord: vi.fn(), handleGap: vi.fn(), reload: vi.fn() };
    const view = renderHook(({ projectId }) => useMapDesignEvents({ projectId, controller, EventSource: FakeEventSource as any }), {
      initialProps: { projectId: 'project-a' },
    });
    expect(FakeEventSource.instances[0]?.url).toBe('/api/map-design/projects/project-a/events');
    view.rerender({ projectId: 'project-b' });
    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances[1]?.url).toContain('/projects/project-b/events');
  });

  it('queues validated event records and forces recovery for gaps or malformed payloads', async () => {
    const controller = { handleRecord: vi.fn(async () => {}), handleGap: vi.fn(async () => {}), reload: vi.fn(async () => {}) };
    renderHook(() => useMapDesignEvents({ projectId: 'project-a', controller, EventSource: FakeEventSource as any }));
    const source = FakeEventSource.instances[0]!;
    source.emit('map-design-event', {
      sequence: 7,
      event: { type: 'project.lifecycle.updated', occurredAt: '2026-08-15T00:00:00.000Z', payload: { lifecycle: 'ready', failure: null } },
    });
    source.emit('map-design-gap', { oldestAvailableSequence: 9, latestSequence: 12 });
    source.emit('map-design-event', { malformed: true });
    await waitFor(() => expect(controller.handleRecord).toHaveBeenCalledTimes(1));
    expect(controller.handleGap).toHaveBeenCalledWith({ oldestAvailableSequence: 9, latestSequence: 12 });
    expect(controller.reload).toHaveBeenCalledWith('invalid-event');
  });

  it('rejects a late old-project callback instead of dispatching it to the new controller', async () => {
    const first = { handleRecord: vi.fn(), handleGap: vi.fn(), reload: vi.fn() };
    const second = { handleRecord: vi.fn(), handleGap: vi.fn(), reload: vi.fn() };
    const view = renderHook(({ projectId, controller }) => useMapDesignEvents({
      projectId, controller, EventSource: FakeEventSource as any,
    }), {
      initialProps: { projectId: 'project-a', controller: first },
    });
    const late = FakeEventSource.instances[0]?.capture('map-design-event');
    view.rerender({ projectId: 'project-b', controller: second });
    late?.(new MessageEvent('map-design-event', { data: JSON.stringify({
      sequence: 7,
      event: {
        type: 'project.lifecycle.updated',
        occurredAt: '2026-08-15T00:00:00.000Z',
        payload: { lifecycle: 'ready', failure: null },
      },
    }) }));
    await Promise.resolve();

    expect(first.handleRecord).not.toHaveBeenCalled();
    expect(second.handleRecord).not.toHaveBeenCalled();
  });


  it('stops at an explicit recovery-failed state and cancels scheduled work on unmount', async () => {
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    const callbacks: Array<() => void> = [];
    const controller = {
      handleRecord: vi.fn(async () => { throw new Error('apply failed'); }),
      handleGap: vi.fn(),
      reload: vi.fn(async () => { throw new Error('reload failed'); }),
    };
    const view = renderHook(() => useMapDesignEvents({
      projectId: 'project-a', controller, EventSource: FakeEventSource as any,
      recovery: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20 },
      scheduleRetry: (callback) => {
        const cancel = vi.fn();
        callbacks.push(callback);
        cancels.push(cancel);
        return cancel;
      },
    }));
    FakeEventSource.instances[0]?.emit('map-design-event', {
      sequence: 7,
      event: { type: 'project.lifecycle.updated', occurredAt: '2026-08-15T00:00:00.000Z', payload: { lifecycle: 'ready', failure: null } },
    });
    await waitFor(() => expect(callbacks).toHaveLength(1));
    callbacks.shift()?.();
    await waitFor(() => expect(view.result.current.status).toBe('recovery-failed'));

    controller.handleRecord.mockRejectedValueOnce(new Error('again'));
    FakeEventSource.instances[0]?.emit('map-design-event', {
      sequence: 8,
      event: { type: 'project.lifecycle.updated', occurredAt: '2026-08-15T00:00:01.000Z', payload: { lifecycle: 'ready', failure: null } },
    });
    await waitFor(() => expect(callbacks).toHaveLength(1));
    view.unmount();
    expect(cancels.at(-1)).toHaveBeenCalledTimes(1);
    const calls = controller.reload.mock.calls.length;
    callbacks.shift()?.();
    await Promise.resolve();
    expect(controller.reload).toHaveBeenCalledTimes(calls);
  });
});
