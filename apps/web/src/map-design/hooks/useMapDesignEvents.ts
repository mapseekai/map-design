import { useEffect, useMemo, useRef, useState } from 'react';
import { MapStudioEventRecordSchema } from '@mapseekai/map-design-contracts';

interface EventController {
  handleRecord(record: ReturnType<typeof MapStudioEventRecordSchema.parse>): Promise<void> | void;
  handleGap(gap: { oldestAvailableSequence?: number | null; latestSequence?: number | null }): Promise<void> | void;
  reload(reason: string): Promise<void> | void;
}

interface EventSourceLike {
  addEventListener(name: string, listener: EventListener): void;
  removeEventListener(name: string, listener: EventListener): void;
  close(): void;
}

export interface UseMapDesignEventsOptions {
  projectId: string;
  controller: EventController;
  EventSource?: new (url: string) => EventSourceLike;
  recovery?: { maxAttempts: number; initialDelayMs: number; maxDelayMs: number };
  scheduleRetry?: (callback: () => void, delayMs: number) => () => void;
}

export type MapDesignEventsStatus = 'idle' | 'listening' | 'recovering' | 'recovery-failed';

export function useMapDesignEvents(options: UseMapDesignEventsOptions): { status: MapDesignEventsStatus } {
  const [status, setStatus] = useState<MapDesignEventsStatus>('idle');
  const recoveryPolicy = normalizeRecovery(options.recovery);
  const scheduleRetryRef = useRef(options.scheduleRetry ?? defaultScheduleRetry);
  scheduleRetryRef.current = options.scheduleRetry ?? defaultScheduleRetry;
  const url = useMemo(
    () => `/api/map-design/projects/${encodeURIComponent(options.projectId)}/events`,
    [options.projectId],
  );

  useEffect(() => {
    const EventSourceConstructor = options.EventSource ?? globalThis.EventSource;
    if (!EventSourceConstructor) { setStatus('idle'); return; }
    const controller = options.controller;
    const recovery = recoveryPolicy;
    const scheduleRetry = scheduleRetryRef.current;
    let active = true;
    let recovering = false;
    let cancelRetry: (() => void) | undefined;
    let source: EventSourceLike | null = null;
    let lastSequence: number | undefined;
    let reconnectAttempts = 0;
    let cursorTail = Promise.resolve();
    let disconnect = () => {};
    const current = (owner: EventSourceLike) => active && source === owner;
    const delayFor = (attempt: number) => Math.min(recovery.maxDelayMs, recovery.initialDelayMs * (2 ** (attempt - 1)));
    const recover = (attempt: number, owner: EventSourceLike) => {
      if (!current(owner)) return;
      recovering = true;
      setStatus('recovering');
      void Promise.resolve().then(() => current(owner) ? controller.reload('event-recovery') : undefined).then(
        () => {
          if (!current(owner)) return;
          recovering = false;
          reconnectAttempts = 0;
          setStatus('listening');
        },
        () => {
          if (!current(owner)) return;
          if (attempt >= recovery.maxAttempts) {
            recovering = false;
            setStatus('recovery-failed');
            return;
          }
          cancelRetry = scheduleRetry(() => {
            cancelRetry = undefined;
            recover(attempt + 1, owner);
          }, delayFor(attempt));
        },
      );
    };
    const settle = (value: Promise<void> | void, owner: EventSourceLike, confirmed?: () => void) => {
      const handled = Promise.resolve(value);
      // A later completed event must not acknowledge an earlier pending one.
      cursorTail = cursorTail.then(() => handled).then(() => { if (current(owner)) confirmed?.(); });
      void cursorTail.catch(() => {});
      void handled.catch(() => { if (current(owner) && !recovering) recover(1, owner); });
    };
    const connect = () => {
      if (!active) return;
      const owner = new EventSourceConstructor(lastSequence === undefined && reconnectAttempts === 0 ? url : `${url}?after=${lastSequence ?? 0}`);
      source = owner;
      cursorTail = Promise.resolve();
      const onRecord = ((message: MessageEvent) => {
        if (!current(owner)) return;
        try {
          const record = MapStudioEventRecordSchema.parse(JSON.parse(String(message.data)));
          settle(controller.handleRecord(record), owner, () => {
            lastSequence = Math.max(lastSequence ?? 0, record.sequence);
          });
        } catch {
          settle(controller.reload('invalid-event'), owner);
        }
      }) as EventListener;
      const onGap = ((message: MessageEvent) => {
        if (!current(owner)) return;
        try {
          const value = JSON.parse(String(message.data)) as Record<string, unknown>;
          const oldestAvailableSequence = optionalSequence(value.oldestAvailableSequence);
          const latestSequence = optionalSequence(value.latestSequence);
          settle(controller.handleGap({ oldestAvailableSequence, latestSequence }), owner, () => {
            if (latestSequence !== undefined) lastSequence = latestSequence ?? 0;
          });
        } catch {
          settle(controller.reload('invalid-gap'), owner);
        }
      }) as EventListener;
      const onOpen = (() => {
        if (!current(owner)) return;
        if (reconnectAttempts > 0) { if (!recovering) recover(1, owner); }
        else setStatus('listening');
      }) as EventListener;
      const onError = (() => {
        if (!current(owner)) return;
        // Own retries for both CONNECTING and CLOSED sources. Closing the old
        // source avoids racing native automatic retries with our bounded policy.
        cancelRetry?.(); cancelRetry = undefined;
        disconnect();
        recovering = false;
        if (reconnectAttempts >= recovery.maxAttempts) { setStatus('recovery-failed'); return; }
        reconnectAttempts += 1;
        setStatus('recovering');
        cancelRetry = scheduleRetry(() => {
          cancelRetry = undefined;
          connect();
        }, delayFor(reconnectAttempts));
      }) as EventListener;
      owner.addEventListener('map-design-event', onRecord);
      owner.addEventListener('map-design-gap', onGap);
      owner.addEventListener('open', onOpen);
      owner.addEventListener('error', onError);
      disconnect = () => {
        if (source !== owner) return;
        source = null;
        owner.removeEventListener('map-design-event', onRecord);
        owner.removeEventListener('map-design-gap', onGap);
        owner.removeEventListener('open', onOpen);
        owner.removeEventListener('error', onError);
        owner.close();
      };
    };
    setStatus('listening');
    connect();
    return () => {
      active = false;
      cancelRetry?.();
      cancelRetry = undefined;
      disconnect();
    };
  }, [
    url,
    options.EventSource,
    options.controller,
    recoveryPolicy.maxAttempts,
    recoveryPolicy.initialDelayMs,
    recoveryPolicy.maxDelayMs,
  ]);

  return { status };
}

function optionalSequence(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError('Invalid event sequence.');
  return Number(value);
}

function normalizeRecovery(value: UseMapDesignEventsOptions['recovery']): {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
} {
  const candidate = value ?? { maxAttempts: 4, initialDelayMs: 250, maxDelayMs: 2_000 };
  if (!Number.isSafeInteger(candidate.maxAttempts) || candidate.maxAttempts < 1 || candidate.maxAttempts > 8
    || !Number.isSafeInteger(candidate.initialDelayMs) || candidate.initialDelayMs < 1
    || !Number.isSafeInteger(candidate.maxDelayMs) || candidate.maxDelayMs < candidate.initialDelayMs) {
    throw new TypeError('Invalid MapDesign event recovery policy.');
  }
  return candidate;
}

function defaultScheduleRetry(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}
