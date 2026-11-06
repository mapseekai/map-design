import type { MapDesignRunStatus, MapScreenshot, MapTextAttachment } from '@mapseekai/contracts';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useWorkspaceTabDraft } from '../WorkspaceTabs';
import { randomUUID } from '../../utils/uuid';

export interface PendingMapMessage {
  readonly id: string;
  readonly requestId: string;
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
  readonly projectId: string;
  readonly conversationId: string;
  readonly sending: boolean;
  readonly ready: boolean;
  readonly status: MapDesignRunStatus | 'idle';
  readonly blocked: boolean;
  readonly readOnly?: boolean;
  send(message: PendingMapMessage): Promise<boolean>;
}

function createQueueStore(previousStatus: QueueOptions['status'] = 'idle') {
  let state: QueueState = { items: [], submittingId: null, editingId: null, paused: false };
  const listeners = new Set<() => void>();
  return {
    previousStatus,
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update(next: QueueState) { state = next; listeners.forEach(listener => listener()); },
  };
}

export function useQueuedMapMessages(options: QueueOptions) {
  const [store] = useWorkspaceTabDraft(`message-queue:${options.projectId}:${options.conversationId}`, createQueueStore);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const update = store.update;
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    const failed = store.previousStatus !== options.status && (options.status === 'failed' || options.status === 'canceled');
    store.previousStatus = options.status;
    if (failed && store.getSnapshot().items.length) update({ ...store.getSnapshot(), paused: true });
    const queue = store.getSnapshot();
    const item = queue.items[0];
    if (!item || options.blocked || options.sending || !options.ready || queue.paused || queue.editingId || queue.submittingId) return;
    update({ ...queue, submittingId: item.id });
    const finish = (accepted: boolean) => {
      const pending = store.getSnapshot();
      update({ ...pending, submittingId: null, paused: pending.paused || !accepted,
        items: accepted ? pending.items.filter((entry) => entry.id !== item.id) : pending.items });
    };
    void Promise.resolve().then(() => mounted.current ? latest.current.send(item) : false).then(finish, () => finish(false));
  }, [options.blocked, options.ready, options.sending, options.status, state, store, update]);

  const enqueue = useCallback((prompt: string, screenshots: MapScreenshot[] = [], attachments: MapTextAttachment[] = []) => {
    if (latest.current.blocked || !prompt.trim() || prompt.length > 16_384) return false;
    const queue = store.getSnapshot();
    update({ ...queue, items: [...queue.items, { id: randomUUID(), requestId: randomUUID(), prompt, screenshots: [...screenshots], attachments: [...attachments] }],
      paused: queue.items.length ? queue.paused : false });
    return true;
  }, [store, update]);
  const edit = useCallback((id: string) => {
    const queue = store.getSnapshot();
    if (latest.current.readOnly || queue.submittingId === id || !queue.items.some((entry) => entry.id === id)) return;
    update({ ...queue, editingId: id });
  }, [store, update]);
  const save = useCallback((id: string, prompt: string) => {
    const queue = store.getSnapshot();
    if (latest.current.readOnly || queue.editingId !== id || queue.submittingId === id || !prompt.trim() || prompt.length > 16_384) return;
    update({ ...queue, items: queue.items.map((entry) => entry.id === id ? { ...entry, prompt, requestId: entry.prompt.trim() === prompt.trim() ? entry.requestId : randomUUID() } : entry), editingId: null });
  }, [store, update]);
  const remove = useCallback((id: string) => {
    const queue = store.getSnapshot();
    if (latest.current.readOnly || queue.submittingId === id) return;
    update({ ...queue, items: queue.items.filter((entry) => entry.id !== id), editingId: queue.editingId === id ? null : queue.editingId });
  }, [store, update]);
  const removeAttachment = useCallback((id: string, attachmentId: string) => {
    const queue = store.getSnapshot();
    if (latest.current.readOnly || queue.editingId !== id || queue.submittingId === id) return;
    update({ ...queue, items: queue.items.map(entry => {
      if (entry.id !== id) return entry;
      const screenshots = entry.screenshots.filter(item => item.id !== attachmentId);
      const attachments = entry.attachments.filter(item => item.id !== attachmentId);
      if (screenshots.length === entry.screenshots.length && attachments.length === entry.attachments.length) return entry;
      return { ...entry, screenshots, attachments, requestId: randomUUID() };
    }) });
  }, [store, update]);
  const cancelEdit = useCallback(() => update({ ...store.getSnapshot(), editingId: null }), [store, update]);
  const pause = useCallback(() => update({ ...store.getSnapshot(), paused: true }), [store, update]);
  const resume = useCallback(() => {
    if (!latest.current.blocked) update({ ...store.getSnapshot(), paused: false });
  }, [store, update]);
  return { ...state, enqueue, edit, save, remove, removeAttachment, cancelEdit, pause, resume };
}
