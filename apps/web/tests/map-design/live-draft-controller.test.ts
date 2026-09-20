import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashStyle } from 'maplibre-style-tools/maplibre';
import type { StyleDocument } from 'maplibre-style-tools/core';

import { MapStudioEventRecordSchema, type MapStudioEventRecord } from '@mapseekai/map-design-contracts';

import { LiveDraftController, type CanonicalDraft } from '../../src/map-design/map/live-draft-controller';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const BASE_STYLE = { version: 8 as const, sources: {}, layers: [] };
const NEXT_STYLE = { version: 8 as const, sources: {}, layers: [], metadata: { revision: 2 } };
const ORIGIN = 'http://127.0.0.1:58357';
const GLYPHS = '/api/map-design/projects/project-a/resources/glyphs/fonts/{fontstack}/{range}.pbf';
const RELATIVE_RESOURCE_STYLE = {
  ...BASE_STYLE,
  id: 'daemon-style-id',
  glyphs: GLYPHS,
  layers: [{ id: 'background', type: 'background', filter: ['all'], paint: { 'background-color': '#ffffff' } }],
} as unknown as StyleDocument;
const ABSOLUTE_RESOURCE_STYLE = {
  ...BASE_STYLE,
  glyphs: `${ORIGIN}${GLYPHS}`,
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#ffffff' } }],
} as unknown as StyleDocument;

afterEach(() => vi.unstubAllGlobals());

function updated(sequence = 2, draftRevision = 2, styleHash = HASH_B): MapStudioEventRecord {
  return MapStudioEventRecordSchema.parse({
    sequence,
    event: {
      type: 'draft.updated',
      occurredAt: '2026-08-15T00:00:00.000Z',
      payload: {
        draftRevision,
        styleHash,
        transaction: { operations: [{ op: 'setStyleRootProperties', properties: { metadata: { revision: 2 } } }] },
        changedLayers: [],
        changedSources: [],
      },
    },
  });
}

describe('LiveDraftController', () => {
  it('recovers a transaction whose MapLibre style expands URLs and omits inert canonical fields', async () => {
    vi.stubGlobal('location', { origin: ORIGIN });
    const relativeNext = { ...RELATIVE_RESOURCE_STYLE, metadata: { revision: 2 } };
    const absoluteNext = { ...ABSOLUTE_RESOURCE_STYLE, metadata: { revision: 2 } };
    const expectedHash = await hashStyle(relativeNext);
    const loadCanonical = vi.fn(async () => ({ context: { draftRevision: 2, styleHash: expectedHash }, style: relativeNext }));
    const applyCanonicalStyle = vi.fn(async (_map, _style, options: { hashStyle(style: any): Promise<string> }) => (
      await options.hashStyle(absoluteNext) === await options.hashStyle(relativeNext)
        ? { ok: true }
        : { ok: false }
    ));
    const controller = new LiveDraftController({
      map: {}, projectId: 'project-a', initialContext: { draftRevision: 1, styleHash: await hashStyle(RELATIVE_RESOURCE_STYLE) },
      applyTransaction: vi.fn(async () => ({
        ok: true as const, styleAuthority: 'current' as const, applied: true, style: absoluteNext,
        changedLayers: [], changedSources: [], diff: [], warnings: [],
      })),
      loadCanonical,
      applyCanonicalStyle,
    });

    await controller.handleRecord(updated(2, 2, expectedHash));

    expect(controller.snapshot()).toMatchObject({ draftRevision: 2, styleHash: expectedHash, sequence: 2 });
    expect(loadCanonical).toHaveBeenCalledWith('hash-mismatch', expect.any(AbortSignal));
  });

  it('recovers an event gap when canonical MapLibre state expands resource URLs', async () => {
    vi.stubGlobal('location', { origin: ORIGIN });
    const expectedHash = await hashStyle(RELATIVE_RESOURCE_STYLE);
    const applyCanonicalStyle = vi.fn(async (_map, style, options: { hashStyle(style: any): Promise<string> }) => (
      await options.hashStyle(ABSOLUTE_RESOURCE_STYLE) === await options.hashStyle(style)
        ? { ok: true }
        : { ok: false }
    ));
    const controller = new LiveDraftController({
      map: {}, projectId: 'project-a', initialContext: { draftRevision: 1, styleHash: HASH_A, sequence: 1 },
      loadCanonical: vi.fn(async () => ({ context: { draftRevision: 2, styleHash: expectedHash }, style: RELATIVE_RESOURCE_STYLE })),
      applyCanonicalStyle,
    });

    await controller.handleGap({ latestSequence: 9 });

    expect(controller.snapshot()).toMatchObject({ draftRevision: 2, styleHash: expectedHash, sequence: 9 });
  });

  it('recovers a real hash mismatch through canonical style with expanded resource URLs', async () => {
    vi.stubGlobal('location', { origin: ORIGIN });
    const relativeNext = { ...RELATIVE_RESOURCE_STYLE, metadata: { revision: 2 } };
    const absoluteNext = { ...ABSOLUTE_RESOURCE_STYLE, metadata: { revision: 2 } };
    const expectedHash = await hashStyle(relativeNext);
    const loadCanonical = vi.fn(async () => ({ context: { draftRevision: 2, styleHash: expectedHash }, style: relativeNext }));
    const applyCanonicalStyle = vi.fn(async (_map, style, options: { hashStyle(style: any): Promise<string> }) => (
      await options.hashStyle(absoluteNext) === await options.hashStyle(style) ? { ok: true } : { ok: false }
    ));
    const controller = new LiveDraftController({
      map: {}, projectId: 'project-a', initialContext: { draftRevision: 1, styleHash: await hashStyle(RELATIVE_RESOURCE_STYLE) },
      applyTransaction: vi.fn(async () => ({
        ok: true as const, styleAuthority: 'current' as const, applied: true, style: ABSOLUTE_RESOURCE_STYLE,
        changedLayers: [], changedSources: [], diff: [], warnings: [],
      })),
      loadCanonical,
      applyCanonicalStyle,
    });

    await controller.handleRecord(updated(2, 2, expectedHash));

    expect(loadCanonical).toHaveBeenCalledWith('hash-mismatch', expect.any(AbortSignal));
    expect(controller.snapshot()).toMatchObject({ draftRevision: 2, styleHash: expectedHash, sequence: 2 });
  });

  it('advances only after the public adapter succeeds and SHA-256 canonical Style hash matches', async () => {
    const applyTransaction = vi.fn(async () => ({
      ok: true as const, styleAuthority: 'current' as const, applied: true, style: NEXT_STYLE,
      changedLayers: [], changedSources: [], diff: [], warnings: [],
    }));
    const hashStyle = vi.fn(async (style: unknown) => style === NEXT_STYLE ? HASH_B : HASH_A);
    const loadCanonical = vi.fn();
    const map = { getStyle: vi.fn(() => { throw new Error('browser style must not become canonical'); }) };
    const controller = new LiveDraftController({
      map, projectId: 'project-a',
      initialContext: { draftRevision: 1, styleHash: HASH_A },
      applyTransaction,
      hashStyle,
      loadCanonical,
      applyCanonicalStyle: vi.fn(),
    });

    await controller.handleRecord(updated());
    const event = updated().event;
    if (event.type !== 'draft.updated') throw new TypeError('expected draft.updated fixture');
    expect(applyTransaction).toHaveBeenCalledWith(map, event.payload.transaction, expect.objectContaining({ hashStyle: expect.any(Function), timeoutMs: expect.any(Number) }));
    expect(hashStyle).toHaveBeenCalledWith(NEXT_STYLE);
    expect(controller.snapshot()).toMatchObject({ draftRevision: 2, styleHash: HASH_B, sequence: 2 });
    expect(loadCanonical).not.toHaveBeenCalled();
    expect(map.getStyle).not.toHaveBeenCalled();
  });

  it.each([
    ['duplicate', updated(2, 2, HASH_B), { sequence: 2, draftRevision: 2, styleHash: HASH_B }],
    ['out-of-order', updated(1, 3, HASH_C), { sequence: 2, draftRevision: 2, styleHash: HASH_B }],
    ['draft gap', updated(5, 5, HASH_C), { sequence: 2, draftRevision: 2, styleHash: HASH_B }],
  ])('reloads the full canonical Style on %s events', async (_name, record, initial) => {
    const applyCanonicalStyle = vi.fn(async () => ({ ok: true }));
    const controller = new LiveDraftController({
      map: {}, projectId: 'project-a', initialContext: initial,
      applyTransaction: vi.fn(), hashStyle: vi.fn(async () => HASH_C),
      loadCanonical: vi.fn(async () => ({ context: { draftRevision: 3, styleHash: HASH_C }, style: BASE_STYLE })),
      applyCanonicalStyle,
    });
    await controller.handleRecord(record);
    expect(applyCanonicalStyle).toHaveBeenCalledWith(expect.anything(), BASE_STYLE, expect.anything());
    expect(controller.snapshot()).toMatchObject({ draftRevision: 3, styleHash: HASH_C });
  });

  it.each([
    ['hash mismatch', { ok: true as const, styleAuthority: 'current' as const, applied: true, style: NEXT_STYLE, changedLayers: [], changedSources: [], diff: [], warnings: [] }],
    ['adapter conflict', { ok: false as const, styleAuthority: 'current' as const, applied: false, style: BASE_STYLE, changedLayers: [], changedSources: [], diff: [], warnings: [], error: { code: 'REVISION_CONFLICT', message: 'conflict', retryable: true } }],
    ['adapter timeout', new Error('transaction timeout')],
  ])('reloads canonical context/style after %s', async (name, adapterResult) => {
    const canonicalStyle = { ...NEXT_STYLE, metadata: { revision: 2, canonical: true } };
    const applyTransaction = vi.fn(async () => {
      if (adapterResult instanceof Error) throw adapterResult;
      return adapterResult;
    });
    const applyCanonicalStyle = vi.fn(async () => ({ ok: true }));
    const controller = new LiveDraftController({
      map: {}, projectId: 'project-a', initialContext: { draftRevision: 1, styleHash: HASH_A }, applyTransaction: applyTransaction as any,
      hashStyle: vi.fn(async (style: unknown) => name === 'hash mismatch' && style === NEXT_STYLE ? HASH_C : HASH_B),
      loadCanonical: vi.fn(async () => ({ context: { draftRevision: 2, styleHash: HASH_B }, style: canonicalStyle })),
      applyCanonicalStyle,
    });
    await controller.handleRecord(updated());
    expect(applyCanonicalStyle).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toMatchObject({ draftRevision: 2, styleHash: HASH_B });
  });

  it('serializes concurrent records and reloads on an explicit server retention gap', async () => {
    const order: number[] = [];
    const controller = new LiveDraftController({
      map: {}, projectId: 'project-a', initialContext: { draftRevision: 1, styleHash: HASH_A },
      applyTransaction: vi.fn(async (_map, transaction: any) => {
        const revision = transaction.operations[0].properties.metadata.revision;
        order.push(revision);
        return { ok: true, styleAuthority: 'current', applied: true, style: { ...BASE_STYLE, metadata: { revision } }, changedLayers: [], changedSources: [], diff: [], warnings: [] };
      }) as any,
      hashStyle: vi.fn(async (style: any) => style.metadata?.revision === 2 ? HASH_B : HASH_C),
      loadCanonical: vi.fn(async () => ({ context: { draftRevision: 4, styleHash: HASH_C }, style: BASE_STYLE })),
      applyCanonicalStyle: vi.fn(async () => ({ ok: true })),
    });
    await Promise.all([controller.handleRecord(updated(2, 2, HASH_B)), controller.handleGap({ latestSequence: 9 })]);
    expect(order).toEqual([2]);
    expect(controller.snapshot()).toMatchObject({ draftRevision: 4, styleHash: HASH_C, sequence: 9 });
  });

  it('rejects attacker resource URLs before a live transaction can reach MapLibre', async () => {
    const applyTransaction = vi.fn();
    const loadCanonical = vi.fn(async () => ({
      context: { draftRevision: 2, styleHash: HASH_B },
      style: BASE_STYLE,
    }));
    const controller = new LiveDraftController({
      map: {}, projectId: 'project-a', initialContext: { draftRevision: 1, styleHash: HASH_A },
      applyTransaction,
      hashStyle: vi.fn(async () => HASH_B),
      loadCanonical,
      applyCanonicalStyle: vi.fn(async () => ({ ok: true })),
    });
    const record = updated();
    if (record.event.type !== 'draft.updated') throw new TypeError('expected draft.updated fixture');
    record.event.payload.transaction = {
      operations: [{
        op: 'addSource', sourceId: 'attacker',
        source: { type: 'vector', tiles: ['https://attacker.test/{z}/{x}/{y}.pbf'] },
      }],
    };

    await controller.handleRecord(record);

    expect(applyTransaction).not.toHaveBeenCalled();
    expect(loadCanonical).toHaveBeenCalledWith('unsafe-style-resource', expect.any(AbortSignal));
  });

  it('rejects an unsafe canonical reload before applying it to MapLibre', async () => {
    const applyCanonicalStyle = vi.fn();
    const controller = new LiveDraftController({
      map: {}, projectId: 'project-a', initialContext: { draftRevision: 1, styleHash: HASH_A },
      hashStyle: vi.fn(async () => HASH_B),
      loadCanonical: vi.fn(async () => ({
        context: { draftRevision: 2, styleHash: HASH_B },
        style: {
          version: 8,
          sources: { attacker: { type: 'vector', tiles: ['https://attacker.test/{z}/{x}/{y}.pbf'] } },
          layers: [],
        },
      })),
      applyCanonicalStyle,
    });

    await expect(controller.reload()).rejects.toThrow(/project resource gateway|unsafe MapDesign Style resource/i);
    expect(applyCanonicalStyle).not.toHaveBeenCalled();
  });

  it('aborts an inflight adapter deadline, drops queued records, and never advances after close', async () => {
    let finish!: (value: any) => void;
    const pending = new Promise<any>((resolve) => { finish = resolve; });
    let deadlineSignal: AbortSignal | undefined;
    const applyTransaction = vi.fn(async (_map, _transaction, options: any) => {
      deadlineSignal = options.deadline?.signal;
      return pending;
    });
    const controller = new LiveDraftController({
      map: {}, projectId: 'project-a', initialContext: { draftRevision: 1, styleHash: HASH_A, sequence: 1 },
      applyTransaction,
      hashStyle: vi.fn(async (candidate: any) => candidate.metadata?.revision === 2 ? HASH_B : HASH_C),
      loadCanonical: vi.fn(),
      applyCanonicalStyle: vi.fn(),
    });
    const first = controller.handleRecord(updated(2, 2, HASH_B));
    const queued = controller.handleRecord(updated(3, 3, HASH_C));
    await vi.waitFor(() => expect(applyTransaction).toHaveBeenCalledTimes(1));
    controller.close();
    finish({
      ok: true, styleAuthority: 'current', applied: true, style: NEXT_STYLE,
      changedLayers: [], changedSources: [], diff: [], warnings: [],
    });
    await Promise.all([first, queued]);

    expect(deadlineSignal?.aborted).toBe(true);
    expect(applyTransaction).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toEqual({ draftRevision: 1, styleHash: HASH_A, sequence: 1 });
  });

  it('cancels canonical loading on close and does not apply a style after map removal', async () => {
    let finish!: (value: CanonicalDraft) => void;
    const pending = new Promise<CanonicalDraft>((resolve) => { finish = resolve; });
    let loadSignal: AbortSignal | undefined;
    const applyCanonicalStyle = vi.fn();
    const controller = new LiveDraftController({
      map: {}, projectId: 'project-a', initialContext: { draftRevision: 1, styleHash: HASH_A },
      loadCanonical: vi.fn(async (_reason, signal) => {
        loadSignal = signal;
        return pending;
      }),
      hashStyle: vi.fn(async () => HASH_B),
      applyCanonicalStyle,
    });
    const reload = controller.reload();
    await vi.waitFor(() => expect(loadSignal).toBeInstanceOf(AbortSignal));
    controller.close();
    finish({ context: { draftRevision: 2, styleHash: HASH_B }, style: BASE_STYLE });
    await reload;

    expect(loadSignal?.aborted).toBe(true);
    expect(applyCanonicalStyle).not.toHaveBeenCalled();
    expect(controller.snapshot()).toEqual({ draftRevision: 1, styleHash: HASH_A });
  });

  it('enforces a real aborting deadline when canonical loading hangs', async () => {
    vi.useFakeTimers();
    try {
      let loadSignal: AbortSignal | undefined;
      const controller = new LiveDraftController({
        map: {}, projectId: 'project-a', initialContext: { draftRevision: 1, styleHash: HASH_A },
        transactionTimeoutMs: 50,
        loadCanonical: vi.fn(async (_reason, signal) => {
          loadSignal = signal;
          return await new Promise<CanonicalDraft>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          });
        }),
        hashStyle: vi.fn(async () => HASH_B),
        applyCanonicalStyle: vi.fn(),
      });
      const failed = vi.fn();

      void controller.reload().catch(failed);
      await vi.advanceTimersByTimeAsync(50);

      expect(loadSignal?.aborted).toBe(true);
      expect(failed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
