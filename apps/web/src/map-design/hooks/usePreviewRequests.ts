import { useCallback, useEffect, useRef, useState } from 'react';
import type { MapStudioEventRecord, MapRenderPreviewOutput } from '@mapseekai/map-design-contracts';

export interface UsePreviewRequestsOptions {
  renderPreview(
    request: Extract<MapStudioEventRecord['event'], { type: 'preview.requested' }>['payload'],
    signal: AbortSignal,
  ): Promise<MapRenderPreviewOutput | { status: 'succeeded' | 'failed'; previewId: string } | unknown>;
  onTerminal?(output: unknown): Promise<void> | void;
}

export type PreviewRequestStatus = 'idle' | 'rendering' | 'succeeded' | 'failed';

export function usePreviewRequests(options: UsePreviewRequestsOptions): {
  status: PreviewRequestStatus;
  output: MapRenderPreviewOutput | null;
  handleRecord(record: MapStudioEventRecord): Promise<void>;
  close(): void;
} {
  const [status, setStatus] = useState<PreviewRequestStatus>('idle');
  const [output, setOutput] = useState<MapRenderPreviewOutput | null>(null);
  const activeRef = useRef(true);
  const completedRef = useRef(new Set<string>());
  const inFlightRef = useRef(new Map<string, Promise<void>>());
  const controllersRef = useRef(new Set<AbortController>());
  const tailRef = useRef(Promise.resolve());
  const renderRef = useRef(options.renderPreview);
  const terminalRef = useRef(options.onTerminal);
  renderRef.current = options.renderPreview;
  terminalRef.current = options.onTerminal;

  const close = useCallback(() => {
    activeRef.current = false;
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
  }, []);

  useEffect(() => {
    activeRef.current = true;
    return close;
  }, [close]);

  const handleRecord = useCallback((record: MapStudioEventRecord): Promise<void> => {
    if (record.event.type !== 'preview.requested') return Promise.resolve();
    const request = record.event.payload;
    if (completedRef.current.has(request.previewId)) return Promise.resolve();
    const existing = inFlightRef.current.get(request.previewId);
    if (existing) return existing;
    const operation = async () => {
      if (!activeRef.current) return;
      const controller = new AbortController();
      controllersRef.current.add(controller);
      setStatus('rendering');
      try {
        let result: MapRenderPreviewOutput;
        try {
          const rendered = await renderWithRetries(renderRef.current, request, controller.signal);
          if (!activeRef.current) return;
          if (!isTerminalOutput(rendered)) throw new TypeError('Preview fulfillment returned an invalid terminal response.');
          result = rendered;
        } catch {
          if (activeRef.current && !controller.signal.aborted) setStatus('failed');
          return;
        }
        try {
          await terminalRef.current?.(result);
        } catch (error) {
          if (activeRef.current && !controller.signal.aborted) setStatus('failed');
          throw error;
        }
        if (activeRef.current) {
          completedRef.current.add(request.previewId);
          setOutput(result);
          setStatus(result.status === 'succeeded' ? 'succeeded' : 'failed');
        }
      } finally {
        controllersRef.current.delete(controller);
      }
    };
    const task = tailRef.current.then(operation, operation);
    inFlightRef.current.set(request.previewId, task);
    void task.finally(() => {
      if (inFlightRef.current.get(request.previewId) === task) inFlightRef.current.delete(request.previewId);
    }).catch(() => undefined);
    tailRef.current = task.catch(() => undefined);
    return task;
  }, []);

  return { status, output, handleRecord, close };
}

const PREVIEW_RETRY_DELAYS_MS = [100, 250, 500] as const;

async function renderWithRetries(
  renderPreview: UsePreviewRequestsOptions['renderPreview'],
  request: Extract<MapStudioEventRecord['event'], { type: 'preview.requested' }>['payload'],
  signal: AbortSignal,
): Promise<unknown> {
  const expiresAt = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new TypeError('Preview request expiry is invalid.');
  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (Date.now() >= expiresAt) throw new DOMException('Preview request expired.', 'TimeoutError');
    try {
      return await renderPreview(request, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      const delay = PREVIEW_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || Date.now() + delay >= expiresAt) throw error;
      await abortableDelay(delay, signal);
    }
  }
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, delayMs);
    const onAbort = () => { cleanup(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTerminalOutput(value: unknown): value is MapRenderPreviewOutput {
  return isRecord(value) && (value.status === 'succeeded' || value.status === 'failed')
    && typeof value.previewId === 'string' && 'report' in value && 'validationSummary' in value;
}
