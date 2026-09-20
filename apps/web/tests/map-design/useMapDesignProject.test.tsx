// @vitest-environment jsdom

import { StrictMode, useLayoutEffect, type ReactNode } from 'react';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({
  context: vi.fn(),
  style: vi.fn(),
  validation: vi.fn(),
  inspect: vi.fn(),
  revisions: vi.fn(),
  currentPreview: vi.fn(),
  revisionSnapshot: vi.fn(),
  actualStyle: null as null | ((projectId: string, signal?: AbortSignal) => Promise<unknown>),
  actualRevisionSnapshot: null as null | ((projectId: string, revision: number, signal?: AbortSignal) => Promise<unknown>),
}));

vi.mock('../../src/map-design/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/map-design/client')>();
  clientMocks.actualStyle = actual.getMapDesignStyle;
  clientMocks.actualRevisionSnapshot = actual.getMapDesignRevisionSnapshot;
  return {
    ...actual,
    getMapDesignContext: clientMocks.context,
    getMapDesignStyle: clientMocks.style,
    validateMapDesignProject: clientMocks.validation,
    inspectMapDesignProject: clientMocks.inspect,
    listMapDesignRevisions: clientMocks.revisions,
    getCurrentMapDesignPreview: clientMocks.currentPreview,
    getMapDesignRevisionSnapshot: clientMocks.revisionSnapshot,
  };
});

import { MapDesignClientError } from '../../src/map-design/client';
import {
  type MapDesignProjectData,
  type MapDesignProjectView,
  useMapDesignProject,
} from '../../src/map-design/hooks/useMapDesignProject';

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function abortableNever(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(
      signal?.reason ?? new DOMException('The request was aborted.', 'AbortError'),
    );
    if (signal?.aborted) rejectAbort();
    else signal?.addEventListener('abort', rejectAbort, { once: true });
  });
}

function StrictModeWrapper({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}

function ViewMatchHarness({ view, onLayout }: {
  view: MapDesignProjectView;
  onLayout(project: MapDesignProjectData | null): void;
}) {
  const state = useMapDesignProject('map-project-1', view);
  useLayoutEffect(() => { onLayout(state.project); }, [onLayout, state.project, view]);
  return null;
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const STYLE = { version: 8 as const, sources: {}, layers: [] };
const REVISIONS = { revisions: [], returned: 0, truncated: false };
const CURRENT_PREVIEW = { preview: null };
const INSPECT = { target: { kind: 'root' as const } };
const CURRENT_VIEW = { kind: 'current' as const };
const HISTORICAL_STYLE = {
  version: 8 as const,
  sources: {},
  layers: [{ id: 'historical-boundary', type: 'line', source: 'historical-source' }],
};
const HISTORICAL_VALIDATION = { draftRevision: 1, summary: { status: 'valid' as const } };
const HISTORICAL_INSPECT = { target: { kind: 'root' as const }, view: { kind: 'root' as const } };
const HISTORICAL_SNAPSHOT = {
  revision: { revision: 1 },
  style: HISTORICAL_STYLE,
  semantics: { version: 1 as const, groups: [] },
  validation: HISTORICAL_VALIDATION,
  inspect: HISTORICAL_INSPECT,
};

const CLIENT_SNAPSHOT = {
  revision: {
    revision: 1,
    draftRevision: 8,
    styleHash: HASH_A,
    sourceDigest: HASH_B,
    semanticDigest: HASH_B,
    designSystemDigest: HASH_B,
    previewId: 'preview-1',
    attestationDigest: HASH_B,
    committedAt: '2026-09-01T00:00:00.000Z',
  },
  style: { version: 8, sources: { broken: null }, layers: [] },
  semantics: { version: 1, groups: [] },
  validation: {
    draftRevision: 8,
    styleHash: HASH_A,
    validationDigest: HASH_B,
    summary: { status: 'valid', errors: 0, warnings: 0, infos: 0, totalFindings: 0, returnedFindings: 0, omittedFindings: 0 },
    findings: [],
  },
  inspect: {
    target: { kind: 'root' },
    view: { kind: 'root', style: { layerCount: 0, sourceCount: 0, layerTypes: [] }, layers: [], sources: [] },
    truncated: false,
  },
};

const VALID_NONTRIVIAL_STYLE = {
  version: 8,
  sources: {
    parks: {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    },
  },
  layers: [{
    id: 'park-fill',
    type: 'fill',
    source: 'parks',
    filter: ['==', ['get', 'kind'], 'park'],
    layout: { visibility: 'visible' },
    paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.6 },
  }],
};

function context(draftRevision: number, styleHash: string) {
  return { draftRevision, styleHash };
}

function mockSuccessfulSecondStage() {
  clientMocks.style.mockResolvedValue(STYLE);
  clientMocks.revisions.mockResolvedValue(REVISIONS);
  clientMocks.currentPreview.mockResolvedValue(CURRENT_PREVIEW);
  clientMocks.validation.mockImplementation(async (_projectId, draftRevision) => ({ draftRevision }));
  clientMocks.inspect.mockResolvedValue(INSPECT);
}

describe('useMapDesignProject', () => {
  it('rejects a historical snapshot with a null source entry as a safe invalid response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(CLIENT_SNAPSHOT), {
      headers: { 'content-type': 'application/json' },
    }));

    await expect(clientMocks.actualRevisionSnapshot?.('map-project-1', 1)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      retryable: false,
    });
  });

  it.each([
    ['a null source entry', { ...VALID_NONTRIVIAL_STYLE, sources: { broken: null } }],
    ['a layer without an id', { ...VALID_NONTRIVIAL_STYLE, layers: [{ ...VALID_NONTRIVIAL_STYLE.layers[0], id: undefined }] }],
    ['a layer without a type', { ...VALID_NONTRIVIAL_STYLE, layers: [{ ...VALID_NONTRIVIAL_STYLE.layers[0], type: undefined }] }],
    ['an array paint value', { ...VALID_NONTRIVIAL_STYLE, layers: [{ ...VALID_NONTRIVIAL_STYLE.layers[0], paint: [] }] }],
    ['an array layout value', { ...VALID_NONTRIVIAL_STYLE, layers: [{ ...VALID_NONTRIVIAL_STYLE.layers[0], layout: [] }] }],
    ['an object filter value', { ...VALID_NONTRIVIAL_STYLE, layers: [{ ...VALID_NONTRIVIAL_STYLE.layers[0], filter: { operator: '==' } }] }],
  ])('rejects a current style with %s', async (_description, style) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(style), {
      headers: { 'content-type': 'application/json' },
    }));

    await expect(clientMocks.actualStyle?.('map-project-1')).rejects.toThrow('MapDesign returned an invalid response.');
  });

  it('accepts a nontrivial valid MapLibre style from the current-style endpoint', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(VALID_NONTRIVIAL_STYLE), {
      headers: { 'content-type': 'application/json' },
    }));

    await expect(clientMocks.actualStyle?.('map-project-1')).resolves.toEqual(VALID_NONTRIVIAL_STYLE);
  });

  it('loads a historical snapshot while retaining current context and revision metadata', async () => {
    const currentContext = context(7, HASH_A);
    clientMocks.context.mockResolvedValue(currentContext);
    clientMocks.revisions.mockResolvedValue(REVISIONS);
    clientMocks.revisionSnapshot.mockResolvedValue(HISTORICAL_SNAPSHOT);

    const { result } = renderHook(() => useMapDesignProject(
      'map-project-1',
      { kind: 'historical', revision: 1 },
    ));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.project?.view).toEqual({ kind: 'historical', revision: 1 });
    expect(result.current.project?.style).toEqual(HISTORICAL_STYLE);
    expect(result.current.project?.validation).toEqual(HISTORICAL_VALIDATION);
    expect(result.current.project?.inspect).toEqual(HISTORICAL_INSPECT);
    expect(result.current.project?.currentContext).toEqual(currentContext);
    expect(result.current.project?.context).toEqual(currentContext);
    expect(clientMocks.style).not.toHaveBeenCalled();
    expect(clientMocks.validation).not.toHaveBeenCalled();
    expect(clientMocks.inspect).not.toHaveBeenCalled();
    expect(clientMocks.currentPreview).not.toHaveBeenCalled();
  });

  it('does not let a stale historical snapshot overwrite a newer selected revision', async () => {
    const firstSnapshot = deferred<typeof HISTORICAL_SNAPSHOT>();
    const laterSnapshot = {
      ...HISTORICAL_SNAPSHOT,
      revision: { revision: 2 },
      style: { ...HISTORICAL_STYLE, layers: [{ id: 'current-boundary', type: 'line', source: 'current-source' }] },
    };
    clientMocks.context.mockResolvedValue(context(7, HASH_A));
    clientMocks.revisions.mockResolvedValue(REVISIONS);
    clientMocks.revisionSnapshot.mockImplementation((_projectId, revision) => (
      revision === 1 ? firstSnapshot.promise : Promise.resolve(laterSnapshot)
    ));

    const { result, rerender } = renderHook(
      ({ revision }) => useMapDesignProject('map-project-1', { kind: 'historical', revision }),
      { initialProps: { revision: 1 } },
    );

    await waitFor(() => expect(clientMocks.revisionSnapshot).toHaveBeenCalledWith(
      'map-project-1',
      1,
      expect.any(AbortSignal),
    ));
    rerender({ revision: 2 });
    await waitFor(() => expect(result.current.project?.view).toEqual({ kind: 'historical', revision: 2 }));

    await act(async () => { firstSnapshot.resolve(HISTORICAL_SNAPSHOT); });
    await act(async () => { await Promise.resolve(); });

    expect(result.current.project?.view).toEqual({ kind: 'historical', revision: 2 });
    expect(result.current.project?.style).toEqual(laterSnapshot.style);
  });

  it('withholds current data in the layout commit that requests a historical view', async () => {
    mockSuccessfulSecondStage();
    clientMocks.context.mockResolvedValue(context(7, HASH_A));
    const onLayout = vi.fn();
    const rendered = render(<ViewMatchHarness view={CURRENT_VIEW} onLayout={onLayout} />);
    await waitFor(() => expect(onLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: CURRENT_VIEW }),
    ));
    onLayout.mockClear();
    clientMocks.revisionSnapshot.mockImplementation((_projectId, _revision, signal) => abortableNever(signal));

    rendered.rerender(<ViewMatchHarness view={{ kind: 'historical', revision: 1 }} onLayout={onLayout} />);

    expect(onLayout.mock.calls[0]?.[0]).toBeNull();
  });

  it('withholds historical data in the layout commit that returns to current view', async () => {
    clientMocks.context.mockResolvedValue(context(7, HASH_A));
    clientMocks.revisions.mockResolvedValue(REVISIONS);
    clientMocks.revisionSnapshot.mockResolvedValue(HISTORICAL_SNAPSHOT);
    const onLayout = vi.fn();
    const rendered = render(<ViewMatchHarness view={{ kind: 'historical', revision: 1 }} onLayout={onLayout} />);
    await waitFor(() => expect(onLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: { kind: 'historical', revision: 1 } }),
    ));
    onLayout.mockClear();
    clientMocks.context.mockImplementation((_projectId, signal) => abortableNever(signal));

    rendered.rerender(<ViewMatchHarness view={CURRENT_VIEW} onLayout={onLayout} />);

    expect(onLayout.mock.calls[0]?.[0]).toBeNull();
  });

  it('withholds the prior historical revision in the layout commit that selects another revision', async () => {
    clientMocks.context.mockResolvedValue(context(7, HASH_A));
    clientMocks.revisions.mockResolvedValue(REVISIONS);
    clientMocks.revisionSnapshot.mockResolvedValue(HISTORICAL_SNAPSHOT);
    const onLayout = vi.fn();
    const rendered = render(<ViewMatchHarness view={{ kind: 'historical', revision: 1 }} onLayout={onLayout} />);
    await waitFor(() => expect(onLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: { kind: 'historical', revision: 1 } }),
    ));
    onLayout.mockClear();
    clientMocks.revisionSnapshot.mockImplementation((_projectId, revision, signal) => (
      revision === 2 ? abortableNever(signal) : Promise.resolve(HISTORICAL_SNAPSHOT)
    ));

    rendered.rerender(<ViewMatchHarness view={{ kind: 'historical', revision: 2 }} onLayout={onLayout} />);

    expect(onLayout.mock.calls[0]?.[0]).toBeNull();
  });

  it('observes every pending request rejection when StrictMode cleanup aborts the load', async () => {
    clientMocks.context.mockImplementation((_projectId, signal) => abortableNever(signal));

    const { result, unmount } = renderHook(
      () => useMapDesignProject('map-project-1', CURRENT_VIEW),
      { wrapper: StrictModeWrapper },
    );

    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBe(false);

    unmount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('retries revision and style hash changes and returns the newest stable context', async () => {
    mockSuccessfulSecondStage();
    const newestContext = context(2, HASH_B);
    clientMocks.context
      .mockResolvedValueOnce(context(1, HASH_A))
      .mockResolvedValueOnce(context(2, HASH_A))
      .mockResolvedValueOnce(context(2, HASH_A))
      .mockResolvedValueOnce(context(2, HASH_B))
      .mockResolvedValueOnce(newestContext)
      .mockResolvedValueOnce(newestContext);

    const { result } = renderHook(() => useMapDesignProject('map-project-1', CURRENT_VIEW));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(clientMocks.context).toHaveBeenCalledTimes(6);
    expect(clientMocks.validation.mock.calls.map(([, revision]) => revision)).toEqual([1, 2, 2]);
    expect(clientMocks.inspect).toHaveBeenCalledTimes(3);
    expect(clientMocks.inspect).toHaveBeenNthCalledWith(
      1,
      'map-project-1',
      expect.any(AbortSignal),
    );
    expect(result.current.project?.context).toBe(newestContext);
    expect(result.current.project?.currentContext).toBe(newestContext);
    expect(result.current.project?.view).toEqual(CURRENT_VIEW);
    expect(result.current.project?.validation).toEqual({ draftRevision: 2 });
    expect(result.current.error).toBe(false);
  });

  it('bounds revision-conflict retries to three coherent snapshot attempts', async () => {
    mockSuccessfulSecondStage();
    clientMocks.context.mockResolvedValue(context(7, HASH_A));
    clientMocks.validation.mockRejectedValue(new MapDesignClientError({
      code: 'REVISION_CONFLICT',
      message: 'The draft changed during the snapshot load.',
      retryable: true,
    }));

    const { result } = renderHook(() => useMapDesignProject('map-project-1', CURRENT_VIEW));

    await waitFor(() => expect(result.current.error).toBe(true));

    expect(clientMocks.context).toHaveBeenCalledTimes(3);
    expect(clientMocks.style).toHaveBeenCalledTimes(3);
    expect(clientMocks.revisions).toHaveBeenCalledTimes(3);
    expect(clientMocks.currentPreview).toHaveBeenCalledTimes(3);
    expect(clientMocks.validation).toHaveBeenCalledTimes(3);
    expect(clientMocks.inspect).toHaveBeenCalledTimes(3);
    expect(result.current.project).toBeNull();
  });

  it.each([
    ['style', clientMocks.style, STYLE],
    ['revisions', clientMocks.revisions, REVISIONS],
    ['current preview', clientMocks.currentPreview, CURRENT_PREVIEW],
  ])('waits for the final %s read before requesting contextAfter', async (_name, finalRead, value) => {
    mockSuccessfulSecondStage();
    const finalReadLoad = deferred<unknown>();
    const before = context(3, HASH_A);
    const after = context(3, HASH_A);
    finalRead.mockReturnValue(finalReadLoad.promise);
    clientMocks.context
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);

    const { result } = renderHook(() => useMapDesignProject('map-project-1', CURRENT_VIEW));

    await waitFor(() => {
      expect(clientMocks.context).toHaveBeenCalledOnce();
      expect(finalRead).toHaveBeenCalledOnce();
      expect(clientMocks.validation).toHaveBeenCalledOnce();
      expect(clientMocks.inspect).toHaveBeenCalledOnce();
    });
    expect(clientMocks.context).toHaveBeenCalledOnce();

    await act(async () => {
      finalReadLoad.resolve(value);
    });
    await waitFor(() => expect(clientMocks.context).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.project?.context).toBe(after);
  });
});
