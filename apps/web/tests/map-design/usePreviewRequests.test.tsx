// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePreviewRequests } from '../../src/map-design/hooks/usePreviewRequests';

const HASH = 'b'.repeat(64);
const DIGEST = 'd'.repeat(64);
const terminalOutput = (previewId: string) => ({
  status: 'failed' as const,
  previewId,
  draftRevision: 4,
  styleHash: HASH,
  png: null,
  report: { digest: DIGEST, mediaType: 'application/json' as const, byteLength: 10 },
  validationSummary: { status: 'valid' as const, errors: 0, warnings: 0, infos: 0,
    totalFindings: 0, returnedFindings: 0, omittedFindings: 0 },
});

function requested(previewId = 'preview-1', expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  return {
    sequence: 1,
    event: { type: 'preview.requested' as const, occurredAt: new Date().toISOString(), payload: {
      previewId, draftRevision: 4, styleHash: HASH,
      viewport: { center: [0, 0] as [number, number], zoom: 1, bearing: 0, pitch: 0, width: 320, height: 240, pixelRatio: 1 },
      expiresAt,
    } },
  };
}

describe('usePreviewRequests', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('serializes and deduplicates preview.requested events and ignores unrelated records', async () => {
    const renderPreview = vi.fn(async () => terminalOutput('preview-1'));
    const view = renderHook(() => usePreviewRequests({ renderPreview }));
    const record = requested();
    await Promise.all([view.result.current.handleRecord(record), view.result.current.handleRecord(record)]);
    await view.result.current.handleRecord({ sequence: 2, event: {
      type: 'validation.updated', occurredAt: '2026-08-15T00:00:01.000Z', payload: {
        draftRevision: 4, styleHash: HASH, validationDigest: 'd'.repeat(64),
        summary: { status: 'valid', errors: 0, warnings: 0, infos: 0, totalFindings: 0, returnedFindings: 0, omittedFindings: 0 },
      },
    } });
    expect(renderPreview).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(view.result.current.status).toBe('failed'));
  });

  it('retries transient rendering failures before expiry and only deduplicates a daemon-accepted terminal output', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-16T00:00:00.000Z');
    const renderPreview = vi.fn()
      .mockRejectedValueOnce(new Error('validation unavailable'))
      .mockResolvedValueOnce(terminalOutput('preview-retry'));
    const onTerminal = vi.fn();
    const view = renderHook(() => usePreviewRequests({ renderPreview, onTerminal }));
    const record = requested('preview-retry', '2026-08-16T00:00:05.000Z');
    const pending = view.result.current.handleRecord(record);
    await vi.waitFor(() => expect(renderPreview).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(renderPreview).toHaveBeenCalledTimes(2);
    expect(onTerminal).toHaveBeenCalledOnce();
    await view.result.current.handleRecord(record);
    expect(renderPreview).toHaveBeenCalledTimes(2);
    view.unmount();
    vi.useRealTimers();
  });

  it('allows a replayed event to retry after a bounded attempt group failed before expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-16T00:00:00.000Z');
    const renderPreview = vi.fn().mockRejectedValue(new Error('offline'));
    const view = renderHook(() => usePreviewRequests({ renderPreview }));
    const record = requested('preview-replayed', '2026-08-16T00:01:00.000Z');
    const first = view.result.current.handleRecord(record);
    await vi.advanceTimersByTimeAsync(2_000);
    await first;
    const callsAfterFirstGroup = renderPreview.mock.calls.length;
    expect(callsAfterFirstGroup).toBeGreaterThan(0);
    renderPreview.mockResolvedValueOnce(terminalOutput('preview-replayed'));
    await view.result.current.handleRecord(record);
    expect(renderPreview.mock.calls.length).toBe(callsAfterFirstGroup + 1);
    view.unmount();
    vi.useRealTimers();
  });

  it('awaits terminal reload work and leaves the event retryable when that reload fails', async () => {
    const reloadFailure = {
      then: (_resolve: (value: void) => void, reject: (error: Error) => void) => {
        reject(new Error('authoritative reload failed'));
      },
    } as Promise<void>;
    const renderPreview = vi.fn(async () => terminalOutput('preview-terminal-reload'));
    const failingTerminal = vi.fn(() => reloadFailure);
    const view = renderHook(({ onTerminal }) => usePreviewRequests({ renderPreview, onTerminal }), {
      initialProps: { onTerminal: failingTerminal },
    });
    const record = requested('preview-terminal-reload');

    await expect(view.result.current.handleRecord(record)).rejects.toThrow('authoritative reload failed');
    expect(failingTerminal).toHaveBeenCalledOnce();
    await waitFor(() => expect(view.result.current.status).toBe('failed'));

    const recoveredTerminal = vi.fn(async () => undefined);
    view.rerender({ onTerminal: recoveredTerminal });
    await expect(view.result.current.handleRecord(record)).resolves.toBeUndefined();
    expect(renderPreview).toHaveBeenCalledTimes(2);
    expect(recoveredTerminal).toHaveBeenCalledOnce();
  });

  it('aborts in-flight rendering and suppresses late state updates on unmount', async () => {
    let signal: AbortSignal | undefined;
    const renderPreview = vi.fn((_request, currentSignal: AbortSignal) => {
      signal = currentSignal;
      return new Promise(() => {});
    });
    const view = renderHook(() => usePreviewRequests({ renderPreview }));
    void view.result.current.handleRecord(requested());
    await waitFor(() => expect(signal).toBeDefined());
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('ignores expired replay requests without replacing the last preview status', async () => {
    const renderPreview = vi.fn(async () => ({ ...terminalOutput('current'), status: 'succeeded' as const }));
    const view = renderHook(() => usePreviewRequests({ renderPreview }));
    await view.result.current.handleRecord(requested('current'));
    await waitFor(() => expect(view.result.current.status).toBe('succeeded'));
    await view.result.current.handleRecord(requested('expired', new Date(Date.now() - 1_000).toISOString()));
    expect(renderPreview).toHaveBeenCalledOnce();
    expect(view.result.current.status).toBe('succeeded');
  });
});
