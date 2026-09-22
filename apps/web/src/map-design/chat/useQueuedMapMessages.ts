import type { MapDesignRunStatus, MapScreenshot, MapTextAttachment } from '@mapseekai/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { randomUUID } from '../../utils/uuid';

export interface PendingMapMessage {
  readonly id: string;
  readonly prompt: string;
  readonly screenshots: MapScreenshot[];
  readonly attachments: MapTextAttachment[];
}

interface QueueState {
  readonly items: readonly PendingMapMessage[];
  readonly submittingId: string | null;
  readonly editingId: string | null;
  readonly paused: boolean;
}

interface QueueOptions {
  readonly sending: boolean;
  readonly ready: boolean;
  readonly status: MapDesignRunStatus | 'idle';
  readonly blocked: boolean;
  readonly readOnly?: boolean;
  send(message: PendingMapMessage): Promise<boolean>;
}

export function useQueuedMapMessages(options: QueueOptions) {
  const [state, setState] = useState<QueueState>({ items: [], submittingId: null, editingId: null, paused: false });
  const current = useRef(state);
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(true);
  const previousStatus = useRef(options.status);
  const update = useCallback((next: QueueState) => { current.current = next; setState(next); }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    const failed = previousStatus.current !== options.status && (options.status === 'failed' || options.status === 'canceled');
    previousStatus.current = options.status;
    if (failed && current.current.items.length) update({ ...current.current, paused: true });
    const queue = current.current;
    const item = queue.items[0];
    if (!item || options.blocked || options.sending || !options.ready || queue.paused || queue.editingId || queue.submittingId) return;
    update({ ...queue, submittingId: item.id });
    const finish = (accepted: boolean) => {
      if (!mounted.current) return;
      const pending = current.current;
      update({ ...pending, submittingId: null, paused: pending.paused || !accepted,
        items: accepted ? pending.items.filter((entry) => entry.id !== item.id) : pending.items });
    };
    void Promise.resolve().then(() => latest.current.send(item)).then(finish, () => finish(false));
  }, [options.blocked, options.ready, options.sending, options.status, state, update]);

  const enqueue = useCallback((prompt: string, screenshots: MapScreenshot[] = [], attachments: MapTextAttachment[] = []) => {
    if (latest.current.blocked || !prompt.trim() || prompt.length > 16_384) return false;
    const queue = current.current;
    update({ ...queue, items: [...queue.items, { id: randomUUID(), prompt, screenshots: [...screenshots], attachments: [...attachments] }],
      paused: queue.items.length ? queue.paused : false });
    return true;
  }, [update]);
  const edit = useCallback((id: string) => {
    const queue = current.current;
    if (latest.current.readOnly || queue.submittingId === id || !queue.items.some((entry) => entry.id === id)) return;
    update({ ...queue, editingId: id });
  }, [update]);
  const save = useCallback((id: string, prompt: string) => {
    const queue = current.current;
    if (latest.current.readOnly || queue.editingId !== id || queue.submittingId === id || !prompt.trim() || prompt.length > 16_384) return;
    update({ ...queue, items: queue.items.map((entry) => entry.id === id ? { ...entry, prompt } : entry), editingId: null });
  }, [update]);
  const remove = useCallback((id: string) => {
    const queue = current.current;
    if (latest.current.readOnly || queue.submittingId === id) return;
    update({ ...queue, items: queue.items.filter((entry) => entry.id !== id), editingId: queue.editingId === id ? null : queue.editingId });
  }, [update]);
  const cancelEdit = useCallback(() => update({ ...current.current, editingId: null }), [update]);
  const pause = useCallback(() => update({ ...current.current, paused: true }), [update]);
  const resume = useCallback(() => {
    if (!latest.current.blocked) update({ ...current.current, paused: false });
  }, [update]);
  return { ...state, enqueue, edit, save, remove, cancelEdit, pause, resume };
}
