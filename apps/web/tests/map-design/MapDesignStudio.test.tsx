// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { startTransition, StrictMode, useLayoutEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';

const clientMocks = vi.hoisted(() => ({
  commitFromPreview: vi.fn(),
  restoreRevision: vi.fn(),
  context: vi.fn(),
  style: vi.fn(),
  validation: vi.fn(),
  inspect: vi.fn(),
  revisions: vi.fn(),
  currentPreview: vi.fn(),
  revisionSnapshot: vi.fn(),
}));
const mapCanvasMock = vi.hoisted(() => ({
  mounts: 0,
  renders: 0,
  onMapError: undefined as undefined | (() => void),
  onMapIdle: undefined as undefined | (() => void),
  onMapReady: undefined as undefined | ((map: unknown) => void),
  canvas: null as HTMLDivElement | null,
}));
const eventChannel = vi.hoisted(() => ({ status: 'listening', retry: vi.fn(), controller: null as { handleRecord(record: unknown): Promise<void> } | null }));
vi.mock('../../src/map-design/hooks/useMapDesignEvents', () => ({
  useMapDesignEvents: ({ controller }: { controller: { handleRecord(record: unknown): Promise<void> } }) => {
    eventChannel.controller = controller;
    return { status: eventChannel.status, retry: eventChannel.retry };
  },
}));
const commentTool = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
// Picking/CRUD have their own component suite and real-map browser coverage.
// Studio tests use a partial map to isolate navigation and revision lifecycle.
vi.mock('../../src/map-design/comments/MapDesignComments', () => ({
  MapDesignComments: (props: Record<string, unknown>) => { commentTool.props = props; return null; },
}));

vi.mock('../../src/map-design/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/map-design/client')>(),
  commitMapDesignRevisionFromPreview: clientMocks.commitFromPreview,
  getMapDesignContext: clientMocks.context,
  getMapDesignStyle: clientMocks.style,
  validateMapDesignProject: clientMocks.validation,
  inspectMapDesignProject: clientMocks.inspect,
  listMapDesignRevisions: clientMocks.revisions,
  getCurrentMapDesignPreview: clientMocks.currentPreview,
  getMapDesignRevisionSnapshot: clientMocks.revisionSnapshot,
  restoreMapDesignRevision: clientMocks.restoreRevision,
}));

vi.mock('../../src/map-design/map/MapCanvas', () => ({
  MapCanvas: ({ projectId, initialStyle, onMapError, onMapIdle, onMapReady }: { projectId: string; initialStyle: { name?: string }; onMapError?(): void; onMapIdle?(): void; onMapReady?(map: unknown): void }) => {
    mapCanvasMock.renders += 1;
    useLayoutEffect(() => { mapCanvasMock.mounts += 1; }, []);
    mapCanvasMock.onMapError = onMapError;
    mapCanvasMock.onMapIdle = onMapIdle;
    mapCanvasMock.onMapReady = onMapReady;
    return <div ref={(node) => { mapCanvasMock.canvas = node; }} data-testid="map-canvas" tabIndex={0} data-style-name={initialStyle.name}
      data-project-id={projectId}>{projectId}</div>;
  },
}));

import {
  MapDesignStudio,
  mapScaleDenominator,
  mapDesignPreviewCommitIntent,
  mapDesignPreviewCommitKey,
} from '../../src/map-design/MapDesignStudio';
import { MapDesignClientError } from '../../src/map-design/client';
import { LiveDraftController } from '../../src/map-design/map/live-draft-controller';

const project = {
  view: { kind: 'current' as const },
  context: {
    lifecycle: 'ready' as const,
    source: { kind: 'style' as const, digest: 'a'.repeat(64), status: 'available' as const, resourceCount: 1 },
    designSystem: { id: 'quiet-atlas', name: 'Quiet Atlas', digest: 'd'.repeat(64) }, draftRevision: 4,
    committedRevision: null, styleHash: 'b'.repeat(64),
    styleSummary: { layerCount: 1, sourceCount: 1, layerTypes: ['line' as const] },
    semanticSummary: { version: 1 as const, groupCount: 0, mappedLayerCount: 0, mappedSourceCount: 0 },
    validationStatus: 'valid' as const, previewStatus: 'current' as const, cartographicGuidance: [],
  },
  currentContext: {
    lifecycle: 'ready' as const,
    source: { kind: 'style' as const, digest: 'a'.repeat(64), status: 'available' as const, resourceCount: 1 },
    designSystem: { id: 'quiet-atlas', name: 'Quiet Atlas', digest: 'd'.repeat(64) }, draftRevision: 4,
    committedRevision: null, styleHash: 'b'.repeat(64),
    styleSummary: { layerCount: 1, sourceCount: 1, layerTypes: ['line' as const] },
    semanticSummary: { version: 1 as const, groupCount: 0, mappedLayerCount: 0, mappedSourceCount: 0 },
    validationStatus: 'valid' as const, previewStatus: 'current' as const, cartographicGuidance: [],
  },
  style: { version: 8 as const, sources: {}, layers: [] },
  validation: { draftRevision: 4, styleHash: 'b'.repeat(64), validationDigest: 'd'.repeat(64),
    summary: { status: 'valid' as const, errors: 0, warnings: 0, infos: 0, totalFindings: 0, returnedFindings: 0, omittedFindings: 0 }, findings: [] },
  revisions: { revisions: [], returned: 0, truncated: false },
  inspect: { target: { kind: 'root' as const }, view: { kind: 'root' as const,
    style: { layerCount: 1, sourceCount: 1, layerTypes: ['line' as const] }, layers: [], sources: [] }, truncated: false },
};

const historicalProject = {
  ...project,
  view: { kind: 'historical' as const, revision: 1 },
  context: { ...project.context, draftRevision: 7, committedRevision: 2, styleHash: 'c'.repeat(64) },
  currentContext: { ...project.currentContext, draftRevision: 7, committedRevision: 2, styleHash: 'c'.repeat(64) },
  style: { version: 8 as const, name: 'historic-revision-one', sources: {}, layers: [] },
  revisions: {
    revisions: [
      {
        revision: 1, draftRevision: 3, styleHash: 'a'.repeat(64), sourceDigest: 'b'.repeat(64),
        semanticDigest: 'c'.repeat(64), designSystemDigest: 'd'.repeat(64), previewId: 'preview-1',
        attestationDigest: 'e'.repeat(64), committedAt: '2026-09-01T00:00:00.000Z',
      },
      {
        revision: 2, draftRevision: 4, styleHash: 'f'.repeat(64), sourceDigest: '1'.repeat(64),
        semanticDigest: '2'.repeat(64), designSystemDigest: '3'.repeat(64), previewId: 'preview-2',
        attestationDigest: '4'.repeat(64), committedAt: '2026-09-02T00:00:00.000Z',
      },
    ],
    returned: 2,
    truncated: false,
  },
};

describe('MapDesignStudio', () => {
  it('passes the canonical map snapshot and conversation submission capability to comments', () => {
    const submit = vi.fn(async () => true);
    render(<MapDesignStudio projectId="map-1" title="Test map" project={project}
      commentSubmissionDisabled={false} onSubmitComments={submit} />);
    expect(commentTool.props).toMatchObject({ projectId: 'map-1', draftRevision: 4, styleHash: 'b'.repeat(64),
      readOnly: false, submissionDisabled: false, onSubmit: submit });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.documentElement.dir = '';
  });
  beforeEach(() => {
    vi.clearAllMocks();
    eventChannel.status = 'listening';
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    mapCanvasMock.mounts = 0;
    mapCanvasMock.onMapError = undefined;
    mapCanvasMock.onMapIdle = undefined;
    clientMocks.context.mockResolvedValue(project.context);
    clientMocks.style.mockResolvedValue(project.style);
    clientMocks.validation.mockResolvedValue(project.validation);
    clientMocks.inspect.mockResolvedValue(project.inspect);
    clientMocks.revisions.mockResolvedValue(project.revisions);
    clientMocks.currentPreview.mockResolvedValue({ preview: passedPreview });
    clientMocks.revisionSnapshot.mockResolvedValue({
      style: historicalProject.style,
      validation: historicalProject.validation,
      inspect: historicalProject.inspect,
    });
    clientMocks.restoreRevision.mockResolvedValue({
      draftRevision: 8, restoredRevision: 1, styleHash: 'a'.repeat(64), semanticDigest: 'b'.repeat(64),
      validationSummary: project.validation.summary,
    });
  });
  it('shows connection recovery and exposes a retry after failure', () => {
    eventChannel.status = 'recovering';
    const view = render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);
    act(() => mapCanvasMock.onMapReady?.({ triggerRepaint: vi.fn(), getCanvas: () => mapCanvasMock.canvas!,
      getCenter: () => ({ lat: 0, lng: 0 }), getZoom: () => 3, getBearing: () => 0, getPitch: () => 0,
      jumpTo: vi.fn(), on: vi.fn(), off: vi.fn() }));
    expect(screen.getByText('Reconnecting to live map updates…').closest('[role=status]')).not.toBeNull();
    eventChannel.status = 'recovery-failed';
    view.rerender(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Live map updates are disconnected');
    fireEvent.click(within(alert).getByRole('button'));
    expect(eventChannel.retry).toHaveBeenCalledOnce();
    eventChannel.status = 'listening';
    view.rerender(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses a stable schema-safe digest when preview identity would exceed the receipt key limit', async () => {
    const key = await mapDesignPreviewCommitKey('p'.repeat(128), 'v'.repeat(128));
    expect(key).toMatch(/^mapdesign-preview-commit:[a-f0-9]{64}$/u);
    expect(key).toHaveLength(89);
    await expect(mapDesignPreviewCommitKey('p'.repeat(128), 'v'.repeat(128))).resolves.toBe(key);
  });
  it('derives a locale-independent protocol intent within the revision contract bound', () => {
    const projectId = 'p'.repeat(256);
    const previewId = 'v'.repeat(256);
    const intent = mapDesignPreviewCommitIntent(projectId, previewId);
    expect(intent).toBe(
      `Commit MapDesign preview ${'v'.repeat(64)}…${'v'.repeat(64)} [256]`
      + ` for project ${'p'.repeat(64)}…${'p'.repeat(64)} [256].`,
    );
    expect(intent.length).toBeLessThanOrEqual(500);
  });
  it('composes one MapCanvas and the three inspector sections', () => {
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);
    expect(screen.getAllByTestId('map-canvas')).toHaveLength(1);
    expect(screen.queryByRole('tab', { name: 'Validation' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Comment (0)' })).toBeInTheDocument();
    expect(document.querySelector('[data-status=valid]')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Layers' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Versions' })).toBeInTheDocument();
  });

  it('renders a historical snapshot as read-only while keeping map navigation available', () => {
    const onViewChange = vi.fn();
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" view={{ kind: 'historical', revision: 1 }}
      onViewChange={onViewChange} project={historicalProject} />);

    expect(screen.getByText('Viewing revision 1 · Read only')).toBeInTheDocument();
    expect(screen.getByTestId('map-canvas')).toHaveAttribute('data-style-name', 'historic-revision-one');
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    fireEvent.click(screen.getByRole('tab', { name: 'Versions' }));
    expect(screen.getByRole('button', { name: 'Commit revision' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Return to current version' }));
    expect(onViewChange).toHaveBeenCalledWith({ kind: 'current' });
  });

  it('does not commit old historical surfaces or mount StudioRuntime while current data is still pending', async () => {
    const staleHistoricalProject = {
      ...historicalProject,
      validation: {
        ...historicalProject.validation,
        summary: {
          ...historicalProject.validation.summary,
          warnings: 1,
          totalFindings: 1,
          returnedFindings: 1,
        },
        findings: [{
          severity: 'warning' as const,
          code: 'HISTORICAL_ONLY',
          message: 'Historical validation only',
          scope: { kind: 'root' as const },
        }],
      },
      inspect: {
        ...historicalProject.inspect,
        view: {
          ...historicalProject.inspect.view,
          style: { layerCount: 1, sourceCount: 0, layerTypes: ['line' as const] },
          layers: [{ id: 'historical-only', type: 'line' as const, title: 'Historical inspect only' }],
        },
      },
    };
    clientMocks.context.mockImplementation((_projectId, signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const closeRuntime = vi.spyOn(LiveDraftController.prototype, 'close');
    const transitionLayouts: Array<{ style: string | null; text: string }> = [];
    function TransitionHarness() {
      const [view, setView] = useState<{ kind: 'current' } | { kind: 'historical'; revision: number }>({ kind: 'historical', revision: 1 });
      useLayoutEffect(() => {
        if (view.kind !== 'current') return;
        transitionLayouts.push({
          style: document.querySelector('[data-testid="map-canvas"]')?.getAttribute('data-style-name') ?? null,
          text: document.querySelector('[data-view]')?.textContent ?? '',
        });
      }, [view]);
      return <>
        <button type="button" onClick={() => setView({ kind: 'current' })}>Return current immediately</button>
        <MapDesignStudio projectId="map-project" title="Transit atlas" view={view} project={staleHistoricalProject} />
      </>;
    }
    render(<TransitionHarness />);
    act(() => {
      mapCanvasMock.onMapReady?.({
        triggerRepaint: vi.fn(), getCanvas: () => mapCanvasMock.canvas!,
        getCenter: () => ({ lat: 0, lng: 0 }),
        getZoom: () => 3, getBearing: () => 0, getPitch: () => 0, jumpTo: vi.fn(),
        off: vi.fn(),
        on: vi.fn(),
      });
    });
    const mountsBeforeTransition = mapCanvasMock.mounts;

    fireEvent.click(screen.getByRole('button', { name: 'Return current immediately' }));
    await act(async () => { await Promise.resolve(); });

    expect(transitionLayouts[0]).toEqual({ style: null, text: '' });
    expect(mapCanvasMock.mounts).toBe(mountsBeforeTransition);
    expect(closeRuntime).not.toHaveBeenCalled();
  });

  it('rekeys a restore after conflict reloads a newer current draft revision', async () => {
    clientMocks.restoreRevision
      .mockRejectedValueOnce(new MapDesignClientError({ code: 'REVISION_CONFLICT', message: 'draft changed', retryable: true }))
      .mockResolvedValueOnce({
        draftRevision: 9, restoredRevision: 1, styleHash: 'a'.repeat(64), semanticDigest: 'b'.repeat(64),
        validationSummary: project.validation.summary,
      });
    clientMocks.context.mockResolvedValueOnce({ ...historicalProject.currentContext, draftRevision: 8, styleHash: '8'.repeat(64) });
    const onViewChange = vi.fn();
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" view={{ kind: 'historical', revision: 1 }}
      onViewChange={onViewChange} project={historicalProject} />);

    const restore = screen.getByRole('button', { name: 'Restore as new draft' });
    fireEvent.click(restore);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore as new draft' }));

    await waitFor(() => expect(screen.getByText('Revision 1 will replace current draft revision 8.')).toBeInTheDocument());
    const refreshedDialog = screen.getByRole('alertdialog');
    fireEvent.click(within(refreshedDialog).getByRole('button', { name: 'Restore as new draft' }));

    await waitFor(() => expect(clientMocks.restoreRevision).toHaveBeenCalledTimes(2));
    const firstRestore = clientMocks.restoreRevision.mock.calls[0]?.[2];
    const secondRestore = clientMocks.restoreRevision.mock.calls[1]?.[2];
    expect(firstRestore).toMatchObject({ expectedDraftRevision: 7, confirmReplaceDraft: true });
    expect(secondRestore).toMatchObject({ expectedDraftRevision: 8, confirmReplaceDraft: true });
    expect(secondRestore.idempotencyKey).not.toBe(firstRestore.idempotencyKey);
    expect(clientMocks.restoreRevision.mock.calls[1]?.[3]).toBeInstanceOf(AbortSignal);
    expect(onViewChange).toHaveBeenCalledWith({ kind: 'current' }, { replace: true });
    expect(screen.getByText('Restored revision 1 as new draft revision 9.')).toHaveAttribute('role', 'status');
  });

  it('returns success focus to the persistent inspector trigger after the banner unmounts', async () => {
    function RestoreHarness() {
      const [view, setView] = useState<{ kind: 'current' } | { kind: 'historical'; revision: number }>({ kind: 'historical', revision: 1 });
      return <MapDesignStudio projectId="map-project" title="Transit atlas" view={view}
        onViewChange={(next) => setView(next)} project={view.kind === 'historical' ? historicalProject : project} />;
    }
    render(<RestoreHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore as new draft' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore as new draft' }));

    await waitFor(() => expect(screen.queryByText('Viewing revision 1 · Read only')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Layers' })).toHaveFocus());
  });

  it('aborts a late restore result when browser navigation leaves the selected historical view', async () => {
    let resolveRestore: ((value: { draftRevision: number; restoredRevision: number; styleHash: string; semanticDigest: string; validationSummary: typeof project.validation.summary }) => void) | undefined;
    let signal: AbortSignal | undefined;
    clientMocks.restoreRevision.mockImplementation((_projectId, _revision, _input, nextSignal: AbortSignal) => {
      signal = nextSignal;
      return new Promise((resolve) => { resolveRestore = resolve; });
    });
    function NavigationHarness() {
      const [view, setView] = useState<{ kind: 'current' } | { kind: 'historical'; revision: number }>({ kind: 'historical', revision: 1 });
      return <>
        <button type="button" onClick={() => setView({ kind: 'current' })}>Simulate browser navigation</button>
        <MapDesignStudio projectId="map-project" title="Transit atlas" view={view}
          onViewChange={setView} project={view.kind === 'historical' ? historicalProject : project} />
      </>;
    }
    render(<NavigationHarness />);
    const browserNavigation = screen.getByRole('button', { name: 'Simulate browser navigation' });
    fireEvent.click(screen.getByRole('button', { name: 'Restore as new draft' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore as new draft' }));
    await waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));

    fireEvent.click(browserNavigation);
    expect(signal?.aborted).toBe(true);
    resolveRestore?.({ draftRevision: 8, restoredRevision: 1, styleHash: 'a'.repeat(64), semanticDigest: 'b'.repeat(64), validationSummary: project.validation.summary });
    await waitFor(() => expect(screen.queryByText('Restored revision 1 as new draft revision 8.')).not.toBeInTheDocument());
    expect(document.querySelector('[data-view="current"]')).toBeInTheDocument();
  });

  it('shows a safe localized map error and remounts the map on retry', () => {
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);
    expect(mapCanvasMock.mounts).toBe(1);

    act(() => { mapCanvasMock.onMapError?.(); });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not load map studio.');
    expect(alert).not.toHaveTextContent('private.example');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mapCanvasMock.mounts).toBe(2);
  });

  it('keeps one map navigation group in the map surface and binds it to the retained map', () => {
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);
    const group = screen.getByRole('group', { name: 'Map navigation' });
    expect(group.closest('section')).toHaveAccessibleName('Map canvas');
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    const zoomIn = vi.fn();
    const map = {
      flyTo: vi.fn(),
      triggerRepaint: vi.fn(), getCanvas: () => mapCanvasMock.canvas!,
      getCenter: () => ({ lat: 0, lng: 0 }),
      getZoom: () => 3, getBearing: () => 0, getPitch: () => 0, jumpTo: vi.fn(),
      off: vi.fn(),
      on: vi.fn(),
      resetNorth: vi.fn(),
      zoomIn,
      zoomOut: vi.fn(),
    };

    act(() => { mapCanvasMock.onMapReady?.(map); });
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));

    expect(zoomIn).toHaveBeenCalledExactlyOnceWith({ essential: false });
    act(() => { mapCanvasMock.onMapError?.(); });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoomIn).toHaveBeenCalledTimes(2);
    act(() => { mapCanvasMock.onMapIdle?.(); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mapCanvasMock.mounts).toBe(1);
    expect(screen.getAllByRole('group', { name: 'Map navigation' })).toHaveLength(1);
  });

  it('toggles a panel off and clears its active button when the panel closes', () => {
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);
    const layers = screen.getByRole('button', { name: 'Layers' });
    fireEvent.click(layers);
    expect(layers).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(layers);
    expect(layers).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(layers);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close inspector' })[0]!);
    expect(layers).toHaveAttribute('aria-pressed', 'false');
  });

  it('maps semantic mode buttons to retained inspector views', () => {
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);

    fireEvent.click(screen.getByRole('button', { name: 'Layers' }));
    expect(screen.getByRole('tab', { name: 'Layers' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: 'Analysis' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Layers' })).toHaveAttribute('aria-selected', 'true');
  });

  it('retains the semantic mode selection when the inspector is closed and reopened', () => {
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);
    const style = screen.getByRole('button', { name: 'Layers' });

    fireEvent.click(style);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close inspector' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Layers' }));

    expect(style).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('tab', { name: 'Layers' })).toHaveAttribute('aria-selected', 'true');
  });

  it('pins and unpins a controlled inspector without changing its selected tab', () => {
    function InspectorHarness() {
      const [placement, setPlacement] = useState<'floating' | 'docked'>('floating');
      const [width, setWidth] = useState(320);
      return <MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
        inspectorPlacement={placement} inspectorWidth={width}
        onInspectorOpenChange={(open) => { if (!open) setPlacement('floating'); }}
        onInspectorPinnedChange={(pinned) => setPlacement(pinned ? 'docked' : 'floating')}
        onInspectorWidthChange={setWidth} />;
    }

    render(<InspectorHarness />);
    fireEvent.click(screen.getByRole('tab', { name: 'Layers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dock inspector' }));
    expect(screen.getByRole('complementary', { name: 'Map inspector' })).toHaveAttribute('data-placement', 'docked');
    expect(screen.getByRole('tab', { name: 'Layers' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Float inspector' }));
    expect(screen.getByRole('complementary', { name: 'Map inspector' })).toHaveAttribute('data-placement', 'floating');
    expect(screen.getByRole('tab', { name: 'Layers' })).toHaveAttribute('aria-selected', 'true');
  });

  it('uses the shared resizable handle for a docked inspector', () => {
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} inspectorPlacement="docked" inspectorWidth={320} />);
    const handle = screen.getByRole('separator', { name: 'Resize map inspector' });
    expect(handle).toHaveAttribute('data-slot', 'resizable-handle');
    expect(handle.closest('[data-slot="resizable-panel-group"]')).toContainElement(screen.getByRole('complementary', { name: 'Map inspector' }));
  });

  it('closes a floating inspector with Escape and returns focus to its toolbar trigger', () => {
    function InspectorHarness() {
      const [placement, setPlacement] = useState<'floating' | 'closed'>('floating');
      return <MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
        inspectorPlacement={placement} inspectorWidth={320}
        onInspectorOpenChange={(open) => setPlacement(open ? 'floating' : 'closed')} />;
    }
    render(<InspectorHarness />);
    const trigger = screen.getByRole('button', { name: 'Layers' });
    trigger.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('complementary', { name: 'Map inspector' })).toHaveAttribute('data-placement', 'closed');
    expect(trigger).toHaveFocus();
  });

  it('leaves the inspector open when a prior Escape handler already prevented the event', () => {
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);
    fireEvent.click(screen.getByRole('button', { name: 'Layers' }));
    const handledEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    handledEscape.preventDefault();

    act(() => { document.dispatchEvent(handledEscape); });

    expect(screen.getByRole('complementary', { name: 'Map inspector' })).toHaveAttribute('data-placement', 'floating');
  });

  it('closes only the topmost restore dialog before closing its inspector with Escape', async () => {
    render(<MapDesignStudio projectId="map-project" title="Transit atlas"
      view={{ kind: 'historical', revision: 1 }} project={historicalProject} />);
    fireEvent.click(screen.getByRole('button', { name: 'Layers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore as new draft' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Map inspector' })).toHaveAttribute('data-placement', 'floating');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('complementary', { name: 'Map inspector' })).toHaveAttribute('data-placement', 'closed');
  });

  it('uses a modal, focus-trapped drawer at the controlled tablet placement', async () => {
    function InspectorHarness() {
      const [placement, setPlacement] = useState<'drawer' | 'closed'>('drawer');
      return <MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
        inspectorPlacement={placement} inspectorWidth={320}
        onInspectorOpenChange={(open) => setPlacement(open ? 'drawer' : 'closed')} />;
    }
    render(<InspectorHarness />);
    const drawer = screen.getByRole('dialog', { name: 'Map inspector' });
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    const mapBackground = document.querySelector('[aria-label="Map canvas"]');
    if (!mapBackground) throw new Error('missing map background');
    expect(mapBackground).toHaveAttribute('aria-hidden', 'true');
    expect(mapBackground).toHaveAttribute('inert');
    expect(mapBackground.querySelector('[role="group"][aria-label="Map navigation"]')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Map navigation' })).not.toBeInTheDocument();
    const close = screen.getAllByRole('button', { name: 'Close inspector' })[0]!;
    await waitFor(() => expect(close).toHaveFocus());
    const panel = screen.getByRole('tabpanel', { name: 'Layers' });
    const firstAction = screen.getByRole('button', { name: 'Dock inspector' });
    // Base uses focus guards for native Tab traversal, which jsdom does not perform.
    const guards = document.querySelectorAll<HTMLElement>('[data-base-ui-focus-guard][data-type="inside"]');
    expect(guards).toHaveLength(2);
    act(() => guards[0]!.focus());
    await waitFor(() => expect(panel).toHaveFocus());
    act(() => guards[1]!.focus());
    await waitFor(() => expect(firstAction).toHaveFocus());
    fireEvent.click(close);
  });

  it('retains the drawer through its 140ms closing transition before removing the scrim', () => {
    vi.useFakeTimers();
    function InspectorHarness() {
      const [placement, setPlacement] = useState<'drawer' | 'closed'>('drawer');
      return <MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
        inspectorPlacement={placement} inspectorWidth={320}
        onInspectorOpenChange={(open) => setPlacement(open ? 'drawer' : 'closed')} />;
    }
    render(<InspectorHarness />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close inspector' })[0]!);
    expect(document.querySelector('[role="dialog"]')).toHaveAttribute('data-closing', 'true');
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(140); });
    expect(screen.getByRole('complementary', { name: 'Map inspector' })).toHaveAttribute('data-placement', 'closed');
    expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toBeInTheDocument();
  });

  it('defers drawer focus return until after its inert modal boundary is removed', () => {
    vi.useFakeTimers();
    function InspectorHarness() {
      const [placement, setPlacement] = useState<'drawer' | 'closed'>('drawer');
      return <MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
        inspectorPlacement={placement} inspectorWidth={320}
        onInspectorOpenChange={(open) => setPlacement(open ? 'drawer' : 'closed')} />;
    }
    render(<InspectorHarness />);
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Layers"]');
    if (!trigger) throw new Error('missing inspector trigger');
    const nativeFocus = trigger.focus.bind(trigger);
    const focus = vi.spyOn(trigger, 'focus').mockImplementation(() => {
      if (trigger.closest('[inert]')) return;
      nativeFocus();
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(focus).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(140); });
    expect(trigger).toHaveFocus();
    focus.mockRestore();
  });

  it('marks RTL drawer exit with a local direction state', () => {
    document.documentElement.dir = 'rtl';
    function InspectorHarness() {
      const [placement, setPlacement] = useState<'drawer' | 'closed'>('drawer');
      return <MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
        inspectorPlacement={placement} inspectorWidth={320}
        onInspectorOpenChange={(open) => setPlacement(open ? 'drawer' : 'closed')} />;
    }
    render(<InspectorHarness />);
    const studio = document.querySelector('[data-inspector-placement]');
    expect(studio).toHaveAttribute('data-direction', 'rtl');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close inspector' })[0]!);
    expect(document.querySelector('[role="dialog"]')).toHaveAttribute('data-closing', 'true');
  });

  it('closes the inspector before fullscreen and allows it to reopen after exit', () => {
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);
    const trigger = screen.getByRole('button', { name: 'Layers' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('complementary', { name: 'Map inspector' })).toHaveAttribute('data-placement', 'closed');
    fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('formats scale with the active locale and localizes the toolbar and status labels', () => {
    render(<I18nProvider initial="de"><MapDesignStudio projectId="map-project" title="Transit atlas" project={project} /></I18nProvider>);

    expect(screen.getByRole('button', { name: 'Ebenen' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('Entwurf 4');
    expect(screen.getByRole('status')).toHaveTextContent('1:25.000');
  });

  it('localizes inspector docking and resizing controls', () => {
    render(<I18nProvider initial="de"><MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
      inspectorPlacement="docked" inspectorWidth={320} /></I18nProvider>);
    expect(screen.getByRole('button', { name: 'Inspektor lösen' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Karteninspektorgröße ändern' })).toBeInTheDocument();
  });

  it('uses MapLibre’s 512px world tile scale at the equator', () => {
    expect(mapScaleDenominator(0, 0)).toBe(295828764);
  });

  it('updates pointer coordinates and scale without rerendering the map workspace', () => {
    // Given a loaded map with its inspector open.
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} inspectorPlacement="docked" />);
    type MapHandler = (event?: { lngLat?: { lat: number; lng: number } }) => void;
    const handlers = new Map<string, Set<MapHandler>>();
    const emit = (event: string, payload?: Parameters<MapHandler>[0]) => { handlers.get(event)?.forEach(handler => handler(payload)); };
    const map = {
      getCenter: () => ({ lat: 0, lng: 0 }),
      getZoom: () => 1, getBearing: () => 0, getPitch: () => 0, jumpTo: vi.fn(),
      triggerRepaint: vi.fn(), getCanvas: () => screen.getByTestId('map-canvas'),
      on: (event: string, handler: MapHandler) => {
        const listeners = handlers.get(event) ?? new Set<MapHandler>();
        listeners.add(handler);
        handlers.set(event, listeners);
      },
      off: (event: string, handler: MapHandler) => { handlers.get(event)?.delete(handler); },
    };
    act(() => { mapCanvasMock.onMapReady?.(map); });
    const rendersBefore = mapCanvasMock.renders;
    const commentsBefore = commentTool.props;

    // When MapLibre emits frequent pointer and camera events.
    for (let index = 0; index < 10; index += 1) {
      act(() => {
        emit('mousemove', { lngLat: { lat: 38.889, lng: -77.035 } });
        emit('move');
      });
    }

    // Then only the status leaf updates, with no sibling renders.
    expect(screen.getByText('38.889°N, 77.035°W')).toHaveAttribute('aria-live', 'off');
    expect(screen.getByText('1:147,914,382')).toBeInTheDocument();
    expect(mapCanvasMock.renders).toBe(rendersBefore);
    expect(commentTool.props).toBe(commentsBefore);
  });

  it('coalesces keyboard map navigation into one final announcement before clearing the live state', () => {
    vi.useFakeTimers();
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);
    type MapHandler = (event?: { lngLat?: { lat: number; lng: number } }) => void;
    const handlers = new Map<string, Set<MapHandler>>();
    const emit = (event: string, payload?: Parameters<MapHandler>[0]) => { handlers.get(event)?.forEach(handler => handler(payload)); };
    let center = { lat: 0, lng: 0 };
    const map = {
      getCenter: () => center,
      getZoom: () => 0, getBearing: () => 0, getPitch: () => 0, jumpTo: vi.fn(),
      triggerRepaint: vi.fn(), getCanvas: () => mapCanvasMock.canvas!,
      on: (event: string, handler: MapHandler) => {
        const listeners = handlers.get(event) ?? new Set<MapHandler>();
        listeners.add(handler);
        handlers.set(event, listeners);
      },
      off: (event: string, handler: MapHandler) => { handlers.get(event)?.delete(handler); },
    };
    act(() => { mapCanvasMock.onMapReady?.(map); });

    act(() => { emit('mousemove', { lngLat: { lat: 38.889, lng: -77.035 } }); });
    expect(screen.getByText('38.889°N, 77.035°W')).toHaveAttribute('aria-live', 'off');

    center = { lat: 40, lng: -74 };
    act(() => { emit('move'); });
    expect(screen.getByText('38.889°N, 77.035°W')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Layers' }), { key: 'ArrowRight' });
    expect(screen.getByText('38.889°N, 77.035°W')).toHaveAttribute('aria-live', 'off');

    fireEvent.keyDown(mapCanvasMock.canvas!, { key: 'ArrowUp' });
    expect(screen.getByText('38.889°N, 77.035°W')).toHaveAttribute('aria-live', 'polite');
    act(() => { emit('move'); emit('move'); });
    expect(screen.getByText('38.889°N, 77.035°W')).toBeInTheDocument();
    act(() => { emit('moveend'); });
    expect(screen.getByText('40.000°N, 74.000°W')).toHaveAttribute('aria-live', 'polite');
    act(() => { vi.runOnlyPendingTimers(); });
    expect(screen.getByText('40.000°N, 74.000°W')).toHaveAttribute('aria-live', 'off');

    center = { lat: 41, lng: -73 };
    act(() => { emit('move'); emit('moveend'); });
    expect(screen.getByText('40.000°N, 74.000°W')).toHaveAttribute('aria-live', 'off');

    fireEvent.keyDown(mapCanvasMock.canvas!, { key: 'ArrowUp' });
    expect(screen.getByText('40.000°N, 74.000°W')).toHaveAttribute('aria-live', 'polite');
    fireEvent.blur(mapCanvasMock.canvas!);
    expect(screen.getByText('40.000°N, 74.000°W')).toHaveAttribute('aria-live', 'off');
    vi.useRealTimers();
  });

  it('exits fullscreen with Escape after the inspector has handled its own dismissal', () => {
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Layers' }));
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Layers' }), { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Exit fullscreen' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Layers' }), { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Enter fullscreen' })).toBeInTheDocument();
  });

  it('offers reversible fullscreen and an accessible narrow inspector drawer', () => {
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }));
    expect(screen.getByRole('button', { name: 'Exit fullscreen' })).toBeInTheDocument();
    const inspector = screen.getByRole('complementary', { name: 'Map inspector' });
    expect(screen.getByRole('button', { name: 'Layers' })).toHaveAttribute('aria-controls', inspector.id);
  });

  it('notifies a replacement callback on immediate fullscreen exit before passive effects', () => {
    const firstCallback = vi.fn();
    const replacementCallback = vi.fn();
    function FullscreenHarness() {
      const [callbackVersion, setCallbackVersion] = useState(0);
      useLayoutEffect(() => {
        if (callbackVersion === 1) document.querySelector<HTMLButtonElement>('[aria-label="Exit fullscreen"]')?.click();
      }, [callbackVersion]);
      return <>
        <button type="button" onClick={() => setCallbackVersion(1)}>Replace fullscreen callback</button>
        <MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
          onFullscreenChange={callbackVersion === 0 ? firstCallback : replacementCallback} />
      </>;
    }

    render(<FullscreenHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }));
    expect(screen.getByRole('button', { name: 'Exit fullscreen' })).toBeInTheDocument();
    expect(firstCallback).toHaveBeenCalledExactlyOnceWith(true);
    expect(replacementCallback).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Replace fullscreen callback' }));
    expect(firstCallback).toHaveBeenCalledExactlyOnceWith(true);
    expect(replacementCallback).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('notifies the latest non-deduplicating callback once when fullscreen unmounts', () => {
    const firstCallback = vi.fn();
    const replacementCallback = vi.fn();
    const view = render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
      onFullscreenChange={firstCallback} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }));

    view.rerender(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
      onFullscreenChange={replacementCallback} />);
    view.unmount();

    expect(firstCallback).toHaveBeenCalledExactlyOnceWith(true);
    expect(replacementCallback).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('does not notify false during StrictMode replay or after explicit fullscreen exit', () => {
    const onFullscreenChange = vi.fn();
    const view = render(<StrictMode><MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
      onFullscreenChange={onFullscreenChange} /></StrictMode>);
    expect(onFullscreenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
    view.unmount();
    expect(onFullscreenChange).toHaveBeenCalledTimes(2);
    expect(onFullscreenChange).toHaveBeenNthCalledWith(1, true);
    expect(onFullscreenChange).toHaveBeenNthCalledWith(2, false);
  });

  it('keeps parent fullscreen notification out of queued state updaters', () => {
    function FullscreenHarness() {
      const [fullscreen, setFullscreen] = useState(false);
      return <div data-testid="fullscreen-owner" data-fullscreen={fullscreen ? 'true' : 'false'}>
        <MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
          onFullscreenChange={setFullscreen} />
      </div>;
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<StrictMode><FullscreenHarness /></StrictMode>);
      const toggle = screen.getByRole('button', { name: 'Enter fullscreen' });
      act(() => {
        startTransition(() => {
          toggle.click();
          toggle.click();
        });
      });

      expect(screen.getByTestId('fullscreen-owner')).toHaveAttribute('data-fullscreen', 'false');
      expect(consoleError.mock.calls.flat().join('\n')).not.toContain('Cannot update a component');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('implements roving keyboard tabs with owned tabpanels', () => {
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);
    const layers = screen.getByRole('tab', { name: 'Layers' });
    const revisions = screen.getByRole('tab', { name: 'Versions' });
    const comments = screen.getByRole('tab', { name: 'Comment (0)' });
    expect(layers).toHaveAttribute('tabindex', '0');
    expect(revisions).toHaveAttribute('tabindex', '-1');
    layers.focus();
    fireEvent.keyDown(layers, { key: 'ArrowRight' });
    expect(revisions).toHaveFocus();
    expect(revisions).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(revisions, { key: 'End' });
    expect(comments).toHaveFocus();
    expect(screen.getAllByRole('tabpanel', { hidden: true })).toHaveLength(3);
    for (const controlledTab of [layers, revisions, comments]) {
      const panel = document.getElementById(controlledTab.getAttribute('aria-controls')!);
      expect(panel).toHaveAttribute('role', 'tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', controlledTab.id);
      if (controlledTab === comments) expect(panel).not.toHaveAttribute('hidden');
      else { expect(panel).toHaveAttribute('hidden'); expect(panel).toHaveAttribute('inert'); }
    }
    fireEvent.keyDown(comments, { key: 'Home' });
    expect(layers).toHaveFocus();
    expect(document.getElementById(layers.getAttribute('aria-controls')!)).not.toHaveAttribute('hidden');
    fireEvent.keyDown(layers, { key: 'ArrowLeft' });
    expect(comments).toHaveFocus();
  });

  it('submits the same revision receipt identity and protocol intent in different UI locales', async () => {
    const renderLocale = (locale: 'en' | 'zh-CN') => render(
      <I18nProvider initial={locale}>
        <MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
          preview={passedPreview} />
      </I18nProvider>,
    );
    const english = renderLocale('en');
    fireEvent.click(screen.getByRole('tab', { name: 'Versions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commit revision' }));
    await waitFor(() => expect(clientMocks.commitFromPreview).toHaveBeenCalledTimes(1));
    english.unmount();

    renderLocale('zh-CN');
    fireEvent.click(screen.getByRole('tab', { name: '版本' }));
    fireEvent.click(screen.getByRole('button', { name: '提交修订版本' }));
    await waitFor(() => expect(clientMocks.commitFromPreview).toHaveBeenCalledTimes(2));

    const first = clientMocks.commitFromPreview.mock.calls[0]?.[1];
    const second = clientMocks.commitFromPreview.mock.calls[1]?.[1];
    expect(first).toMatchObject({
      idempotencyKey: 'mapdesign-preview-commit:map-project:preview-1',
      intentSummary: 'Commit MapDesign preview preview-1 for project map-project.',
    });
    expect(second).toEqual(first);
  });

  it('shows an authoritative reload failure after committing existing preview evidence', async () => {
    clientMocks.context.mockRejectedValueOnce(new Error('reload unavailable'));
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
      preview={passedPreview} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Versions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commit revision' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load map studio.');
  });

  it('enables Commit only for passed current preview evidence', () => {
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
      preview={passedPreview} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Versions' }));
    expect(screen.getByRole('button', { name: 'Commit revision' })).toBeEnabled();
  });

  it('coalesces same-tick Commit clicks and aborts the request on unmount', async () => {
    let finish: (() => void) | undefined;
    clientMocks.commitFromPreview.mockImplementationOnce((_projectId, _input, signal: AbortSignal) =>
      new Promise<void>((resolve) => { finish = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); }));
    const view = render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
      preview={passedPreview} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Versions' }));
    const commit = screen.getByRole('button', { name: 'Commit revision' });
    fireEvent.click(commit);
    fireEvent.click(commit);
    await waitFor(() => expect(clientMocks.commitFromPreview).toHaveBeenCalledTimes(1));
    expect(clientMocks.commitFromPreview).toHaveBeenCalledWith('map-project', expect.objectContaining({
      idempotencyKey: 'mapdesign-preview-commit:map-project:preview-1',
      previewId: 'preview-1',
    }), expect.any(AbortSignal));
    const signal = clientMocks.commitFromPreview.mock.calls[0]?.[2] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    finish?.();
  });

  it('refreshes revision history when an agent commits a revision', async () => {
    const handleRecord = vi.spyOn(LiveDraftController.prototype, 'handleRecord').mockResolvedValue(undefined);
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} preview={passedPreview} />);
    act(() => mapCanvasMock.onMapReady?.({ triggerRepaint: vi.fn(), getCanvas: () => mapCanvasMock.canvas!, getCenter: () => ({ lat: 0, lng: 0 }), getZoom: () => 3, getBearing: () => 0, getPitch: () => 0, jumpTo: vi.fn(), on: vi.fn(), off: vi.fn() }));
    fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
    expect(screen.getByRole('button', { name: 'Commit revision' })).toBeEnabled();
    clientMocks.revisions.mockResolvedValue({ revisions: [{ revision: 2, draftRevision: 4, styleHash: 'b'.repeat(64), sourceDigest: '1'.repeat(64), semanticDigest: '2'.repeat(64), designSystemDigest: '3'.repeat(64), previewId: 'preview-1', attestationDigest: '4'.repeat(64), committedAt: '2026-09-09T00:00:00.000Z' }], returned: 1, truncated: false });
    let pending: Promise<void> | undefined;
    act(() => { pending = eventChannel.controller?.handleRecord({ event: { type: 'revision.committed' } }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'View revision 2' })).toBeInTheDocument());
    await pending;
    expect(screen.getByRole('button', { name: 'Commit revision' })).toBeDisabled();
    handleRecord.mockRestore();
  });

  it('keeps the live controller active after StrictMode effect replay', async () => {
    const handled = vi.spyOn(LiveDraftController.prototype, 'handleRecord');
    render(<StrictMode><MapDesignStudio projectId="map-project" title="Transit atlas" project={project} /></StrictMode>);
    act(() => mapCanvasMock.onMapReady?.({ triggerRepaint: vi.fn(), getCanvas: () => mapCanvasMock.canvas!,
      getCenter: () => ({ lat: 0, lng: 0 }), getZoom: () => 3, getBearing: () => 0, getPitch: () => 0,
      on: vi.fn(), off: vi.fn(), jumpTo: vi.fn() }));
    await act(async () => { await eventChannel.controller?.handleRecord({ sequence: 1,
      event: { type: 'draft.updated', payload: { draftRevision: 4, styleHash: 'b'.repeat(64) } } }); });
    const live = handled.mock.contexts.at(-1) as LiveDraftController;
    expect(live.snapshot().sequence).toBe(1);
    handled.mockRestore();
  });

  it('refreshes the canonical draft after a run ends without a successful preview', async () => {
    const view = render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} mapEditingDisabled />);
    clientMocks.context.mockResolvedValue({ ...project.context, draftRevision: 6 });
    clientMocks.validation.mockResolvedValue({ ...project.validation, draftRevision: 6 });
    view.rerender(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} mapEditingDisabled={false} />);
    await waitFor(() => expect(commentTool.props).toMatchObject({ draftRevision: 6 }));
  });

  it('keeps the map instance when a canonical style refresh changes its hash', async () => {
    const handleRecord = vi.spyOn(LiveDraftController.prototype, 'handleRecord').mockResolvedValue(undefined);
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);
    act(() => mapCanvasMock.onMapReady?.({ triggerRepaint: vi.fn(), getCanvas: () => mapCanvasMock.canvas!, getCenter: () => ({ lat: 0, lng: 0 }), getZoom: () => 3, getBearing: () => 0, getPitch: () => 0, jumpTo: vi.fn(), on: vi.fn(), off: vi.fn() }));
    const mounts = mapCanvasMock.mounts;
    clientMocks.context.mockResolvedValue({ ...project.context, draftRevision: 5, styleHash: 'e'.repeat(64) });
    clientMocks.validation.mockResolvedValue({ ...project.validation, draftRevision: 5, styleHash: 'e'.repeat(64) });
    let pending: Promise<void> | undefined;
    act(() => { pending = eventChannel.controller?.handleRecord({ event: { type: 'revision.committed' } }); });
    await waitFor(() => expect(screen.getByText('Revision 5')).toBeInTheDocument());
    await pending;
    expect(mapCanvasMock.mounts).toBe(mounts);
    handleRecord.mockRestore();
  });

  it('preserves the camera when the map is explicitly recreated', () => {
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project} />);
    let center = { lat: 24, lng: 105 };
    const listeners = new Map<string, () => void>();
    const oldMap = { triggerRepaint: vi.fn(), getCanvas: () => mapCanvasMock.canvas!, getCenter: () => center,
      getZoom: () => 7, getBearing: () => 30, getPitch: () => 40,
      on: vi.fn((name, handler) => listeners.set(name, handler)), off: vi.fn(), jumpTo: vi.fn() };
    act(() => mapCanvasMock.onMapReady?.(oldMap));
    expect(oldMap.jumpTo).not.toHaveBeenCalled();
    center = { lat: 25, lng: 106 };
    act(() => listeners.get('move')?.());
    const nextMap = { ...oldMap, jumpTo: vi.fn() };
    act(() => mapCanvasMock.onMapReady?.(nextMap));
    expect(nextMap.jumpTo).toHaveBeenCalledWith({ center: [106, 25], zoom: 7, bearing: 30, pitch: 40 });
  });

  it('disables Commit when authoritative revision history already contains the preview', () => {
    const committedProject = { ...project, revisions: { revisions: [{
      revision: 1, draftRevision: 4, styleHash: 'b'.repeat(64), sourceDigest: '1'.repeat(64),
      semanticDigest: '2'.repeat(64), designSystemDigest: '3'.repeat(64), previewId: 'preview-1',
      attestationDigest: '4'.repeat(64), committedAt: '2026-08-16T00:00:00.000Z',
    }], returned: 1, truncated: false } };
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={committedProject}
      preview={passedPreview} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Versions' }));
    expect(screen.getByRole('button', { name: 'Commit revision' })).toBeDisabled();
  });

  it('recovers a lost commit response with the same key and authoritative revision reload', async () => {
    clientMocks.commitFromPreview.mockRejectedValueOnce(new Error('response lost'));
    clientMocks.revisions.mockResolvedValueOnce({ revisions: [{
      revision: 1, draftRevision: 4, styleHash: 'b'.repeat(64), sourceDigest: '1'.repeat(64),
      semanticDigest: '2'.repeat(64), designSystemDigest: '3'.repeat(64), previewId: 'preview-1',
      attestationDigest: '4'.repeat(64), committedAt: '2026-08-16T00:00:00.000Z',
    }], returned: 1, truncated: false });
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" project={project}
      preview={passedPreview} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Versions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commit revision' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit revision' })).toBeDisabled());
    expect(clientMocks.commitFromPreview).toHaveBeenCalledWith('map-project', expect.objectContaining({
      idempotencyKey: 'mapdesign-preview-commit:map-project:preview-1', previewId: 'preview-1',
    }), expect.any(AbortSignal));
  });

  it('restores current terminal preview evidence from the authorized project loader after a remount', async () => {
    const first = render(<MapDesignStudio projectId="map-project" title="Transit atlas" />);
    await waitFor(() => expect(screen.getByTestId('map-canvas')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Versions' }));
    expect(screen.getByRole('button', { name: 'Commit revision' })).toBeEnabled();
    first.unmount();
    render(<MapDesignStudio projectId="map-project" title="Transit atlas" />);
    await waitFor(() => expect(screen.getByTestId('map-canvas')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Versions' }));
    expect(screen.getByRole('button', { name: 'Commit revision' })).toBeEnabled();
    expect(clientMocks.currentPreview).toHaveBeenCalledTimes(2);
  });
});

const passedPreview = {
  status: 'succeeded' as const, previewId: 'preview-1', draftRevision: 4, styleHash: 'b'.repeat(64),
  png: { digest: 'e'.repeat(64), mediaType: 'image/png' as const, byteLength: 24, width: 320, height: 240 },
  report: { digest: 'f'.repeat(64), mediaType: 'application/json' as const, byteLength: 10 },
  validationSummary: project.validation.summary,
};
