import { eventConnectionCopy } from '../i18n/locales/event-connection';
import { resourceErrorCopy } from '../i18n/locales/resource-error';
import { MapLoading } from '@mapseekai/components';
import { Button, Alert, ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@mapseekai/components';
import {
  mapCommitPreviewIntentSummary,
  type MapRenderPreviewOutput,
  type MapStudioEventRecord,
  type MapComment,
} from '@mapseekai/map-design-contracts';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { useI18n } from '../i18n';
import { resizablePanelWidth } from './resizable-panel-width';
import {
  commitMapDesignRevisionFromPreview,
  fulfillMapDesignPreview,
  getMapDesignContext,
  getMapDesignStyle,
  validateMapDesignProject,
} from './client';
import { MapDesignInspectorPanel, type MapDesignInspectorPlacement, type MapDesignInspectorTab } from './components/MapDesignInspectorPanel';
import { MapDesignHistoricalBanner } from './components/MapDesignHistoricalBanner';
import { MapNavigationControls } from './components/MapNavigationControls';
import { MapDesignRestoreRevisionDialog } from './components/MapDesignRestoreRevisionDialog';
import { MapDesignStatusBar } from './components/MapDesignStatusBar';
import { MapDesignStudioHeader, type MapDesignStudioMode } from './components/MapDesignStudioHeader';
import { useMapDesignEvents } from './hooks/useMapDesignEvents';
import { type MapDesignProjectData, type MapDesignProjectView, useMapDesignProject } from './hooks/useMapDesignProject';
import { usePreviewRequests } from './hooks/usePreviewRequests';
import { MapCanvas, type OwnedMap } from './map/MapCanvas';
import { LiveDraftController } from './map/live-draft-controller';
import { renderMapDesignPreview } from './preview/preview-renderer';
import { MapDesignComments } from './comments/MapDesignComments';
import type { MapScreenshot } from '@mapseekai/contracts';
import { Pencil } from 'lucide-react';
import { useProjectThumbnail } from './screenshots/useProjectThumbnail';
import { MapScreenshotButton } from './screenshots/MapScreenshotButton';
import { MapDesignStyleEditor } from './style-edit/MapDesignStyleEditor';
import { styleEditCopy } from '../i18n/locales/style-edit';

const StyleCode = lazy(() => import('./MapDesignStyleCode').then(module => ({ default: module.MapDesignStyleCode })));

export interface MapDesignStudioProps {
  projectId: string;
  title: string;
  view?: MapDesignProjectView;
  viewError?: boolean;
  onViewChange?(view: MapDesignProjectView, options?: { replace?: boolean }): void;
  project?: MapDesignProjectData;
  preview?: MapRenderPreviewOutput | null;
  onFullscreenChange?(fullscreen: boolean): void;
  inspectorPlacement?: MapDesignInspectorPlacement;
  inspectorWidth?: number;
  onHeaderHeightChange?(height: number): void;
  onInspectorOpenChange?(open: boolean): void;
  onInspectorPinnedChange?(pinned: boolean): void;
  onInspectorWidthChange?(width: number): void;
  onDrawerModalChange?(active: boolean): void;
  layoutRevision?: number;
  commentSubmissionDisabled?: boolean;
  onSubmitComments?(comments: MapComment[]): Promise<boolean>;
  onScreenshot?(screenshot: MapScreenshot): boolean;
  screenshotTargetKey?: string;
  screenshotCount?: number;
  mapEditingDisabled?: boolean;
}

interface MapStatus {
  scaleDenominator: number;
  coordinates: { lat: number; lng: number } | null;
}

const MAP_KEYBOARD_NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', '-', '+', '=']);

export function mapScaleDenominator(latitude: number, zoom: number): number {
  const metresPerCssPixel = 40075016.68557849 * Math.cos(latitude * Math.PI / 180) / 512 / 2 ** zoom;
  return Math.max(1, Math.round(metresPerCssPixel * 96 * 39.37));
}

export function MapDesignStudio({ projectId, title, view = { kind: 'current' }, viewError = false, onViewChange, project: seed, preview: previewSeed = null,
  onFullscreenChange, onHeaderHeightChange, inspectorPlacement, inspectorWidth, onInspectorOpenChange, onInspectorPinnedChange,
  onInspectorWidthChange, onDrawerModalChange, layoutRevision = 0, commentSubmissionDisabled = true, onSubmitComments,
  onScreenshot, screenshotTargetKey, screenshotCount, mapEditingDisabled = false }: MapDesignStudioProps) {
  const { locale, t } = useI18n();
  const state = useMapDesignProject(projectId, view, seed);
  const previouslyEditingDisabled = useRef(mapEditingDisabled);
  useEffect(() => {
    const wasDisabled = previouslyEditingDisabled.current;
    previouslyEditingDisabled.current = mapEditingDisabled;
    if (wasDisabled && !mapEditingDisabled && view.kind === 'current') {
      void state.reload().catch(() => undefined);
    }
  }, [mapEditingDisabled, state.reload, view.kind]);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const cameraRef = useRef<{ projectId: string; center: [number, number]; zoom: number; bearing: number; pitch: number } | null>(null);
  const [commentToolbarHost, setCommentToolbarHost] = useState<HTMLDivElement | null>(null);
  const [commentListHost, setCommentListHost] = useState<HTMLDivElement | null>(null);
  const [mapError, setMapError] = useState<'load' | 'resource' | 'rate-limit' | null>(null);
  const [mapAttempt, setMapAttempt] = useState(0);
  const [historicalBannerHeight, setHistoricalBannerHeight] = useState(0);
  const [editingStyle, setEditingStyle] = useState(false);
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');
  const [codeOpened, setCodeOpened] = useState(false);
  useProjectThumbnail(projectId, map, editingStyle || mapEditingDisabled || view.kind === 'historical');
  const editTriggerRef = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<MapRenderPreviewOutput | null>(previewSeed ?? seed?.preview ?? null);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef(false);
  const fullscreenChangeRef = useRef(onFullscreenChange);
  const [uncontrolledInspectorOpen, setUncontrolledInspectorOpen] = useState(false);
  const [uncontrolledInspectorPinned, setUncontrolledInspectorPinned] = useState(false);
  const [uncontrolledInspectorWidth, setUncontrolledInspectorWidth] = useState(320);
  const resolvedInspectorPlacement = inspectorPlacement ?? (uncontrolledInspectorOpen
    ? uncontrolledInspectorPinned ? 'docked' : 'floating'
    : 'closed');
  const [presentedInspectorPlacement, setPresentedInspectorPlacement] = useState<MapDesignInspectorPlacement>(resolvedInspectorPlacement);
  const [drawerClosing, setDrawerClosing] = useState(false);
  const [commentCount, setCommentCount] = useState(0);
  const [inspectorTab, setInspectorTab] = useState<MapDesignInspectorTab>('layers');
  const [keyboardNavigationActive, setKeyboardNavigationActive] = useState(false);
  const keyboardNavigationRef = useRef(false);
  const liveRegionClearTimerRef = useRef<number | null>(null);
  const [mapStatus, setMapStatus] = useState<MapStatus>({ scaleDenominator: 25000, coordinates: null });
  const [committing, setCommitting] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<{ revision: number; expectedDraftRevision: number } | null>(null);
  const [restoreAnnouncement, setRestoreAnnouncement] = useState<string | null>(null);
  const [restoreFocusTarget, setRestoreFocusTarget] = useState<'banner' | 'inspector' | null>(null);
  const [currentReloadPending, setCurrentReloadPending] = useState(false);
  const mountedRef = useRef(true);
  const commitControllerRef = useRef<AbortController | null>(null);
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreTriggerRef = useRef<HTMLButtonElement>(null);
  const focusInspectorTriggerAfterClose = useRef(false);
  const mapColumnRef = useRef<HTMLElement>(null);
  const inspectorId = `map-inspector-${useId().replace(/:/gu, '')}`;
  const focusRestoreInspectorTrigger = useCallback(() => {
    const trigger = inspectorTriggerRef.current
      ?? mapColumnRef.current?.querySelector<HTMLButtonElement>(`[aria-controls="${inspectorId}"]`);
    trigger?.focus();
  }, [inspectorId]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      commitControllerRef.current?.abort();
      commitControllerRef.current = null;
    };
  }, []);
  useEffect(() => {
    setPreview(previewSeed ?? state.project?.preview ?? null);
  }, [previewSeed, state.project?.preview]);
  useLayoutEffect(() => {
    fullscreenChangeRef.current = onFullscreenChange;
  }, [onFullscreenChange]);
  useEffect(() => () => {
    if (!fullscreenRef.current) return;
    fullscreenRef.current = false;
    fullscreenChangeRef.current?.(false);
  }, []);
  const clearKeyboardNavigation = useCallback(() => {
    keyboardNavigationRef.current = false;
    if (liveRegionClearTimerRef.current !== null) window.clearTimeout(liveRegionClearTimerRef.current);
    liveRegionClearTimerRef.current = null;
    setKeyboardNavigationActive(false);
  }, []);
  const scheduleKeyboardNavigationClear = useCallback(() => {
    if (liveRegionClearTimerRef.current !== null) window.clearTimeout(liveRegionClearTimerRef.current);
    liveRegionClearTimerRef.current = window.setTimeout(() => {
      keyboardNavigationRef.current = false;
      liveRegionClearTimerRef.current = null;
      setKeyboardNavigationActive(false);
    }, 300);
  }, []);
  const updateMapScale = useCallback((nextMap: MapLibreMap) => {
    const center = nextMap.getCenter();
    cameraRef.current = { projectId, center: [center.lng, center.lat], zoom: nextMap.getZoom(),
      bearing: nextMap.getBearing(), pitch: nextMap.getPitch() };
    setMapStatus((current) => ({ ...current, scaleDenominator: mapScaleDenominator(center.lat, nextMap.getZoom()) }));
  }, [projectId]);
  const updateCoordinates = useCallback((coordinates: { lat: number; lng: number }) => {
    setMapStatus((current) => ({ ...current, coordinates }));
  }, []);
  const resolvedInspectorWidth = inspectorWidth ?? uncontrolledInspectorWidth;
  const setInspectorOpen = useCallback((open: boolean) => {
    onInspectorOpenChange?.(open);
    if (inspectorPlacement === undefined) setUncontrolledInspectorOpen(open);
  }, [inspectorPlacement, onInspectorOpenChange]);
  const setInspectorPinned = useCallback((pinned: boolean) => {
    onInspectorPinnedChange?.(pinned);
    if (inspectorPlacement === undefined) setUncontrolledInspectorPinned(pinned);
  }, [inspectorPlacement, onInspectorPinnedChange]);
  const setInspectorWidth = useCallback((width: number) => {
    onInspectorWidthChange?.(width);
    if (inspectorWidth === undefined) setUncontrolledInspectorWidth(width);
  }, [inspectorWidth, onInspectorWidthChange]);
  const closeInspector = useCallback(() => {
    if (resolvedInspectorPlacement === 'drawer') setDrawerClosing(true);
    focusInspectorTriggerAfterClose.current = true;
    setInspectorOpen(false);
  }, [resolvedInspectorPlacement, setInspectorOpen]);
  const toggleFullscreen = useCallback(() => {
    const next = !fullscreenRef.current;
    if (next && resolvedInspectorPlacement !== 'closed') {
      if (resolvedInspectorPlacement === 'drawer') setDrawerClosing(true);
      setInspectorOpen(false);
    }
    fullscreenRef.current = next;
    setFullscreen(next);
    fullscreenChangeRef.current?.(next);
  }, [resolvedInspectorPlacement, setInspectorOpen]);
  useEffect(() => {
    if (!fullscreen) return;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')
        || (event.target instanceof Element && event.target.closest('[role="dialog"]'))) return;
      event.preventDefault();
      toggleFullscreen();
    };
    window.addEventListener('keydown', exitOnEscape);
    return () => window.removeEventListener('keydown', exitOnEscape);
  }, [fullscreen, toggleFullscreen]);
  useEffect(() => {
    if (resolvedInspectorPlacement !== 'closed') {
      setDrawerClosing(false);
      setPresentedInspectorPlacement(resolvedInspectorPlacement);
      return;
    }
    if (presentedInspectorPlacement !== 'drawer') {
      setPresentedInspectorPlacement('closed');
      return;
    }
    if (!drawerClosing) setDrawerClosing(true);
    const timer = window.setTimeout(() => {
      setPresentedInspectorPlacement('closed');
      setDrawerClosing(false);
    }, 140);
    return () => window.clearTimeout(timer);
  }, [drawerClosing, presentedInspectorPlacement, resolvedInspectorPlacement]);
  const drawerModalActive = presentedInspectorPlacement === 'drawer';
  useEffect(() => {
    const mapColumn = mapColumnRef.current;
    if (!mapColumn) return;
    if (drawerModalActive) mapColumn.setAttribute('inert', '');
    else mapColumn.removeAttribute('inert');
    return () => mapColumn.removeAttribute('inert');
  }, [drawerModalActive]);
  useEffect(() => {
    onDrawerModalChange?.(drawerModalActive);
    return () => onDrawerModalChange?.(false);
  }, [drawerModalActive, onDrawerModalChange]);
  useEffect(() => {
    if (presentedInspectorPlacement === 'drawer' || !focusInspectorTriggerAfterClose.current) return;
    focusInspectorTriggerAfterClose.current = false;
    inspectorTriggerRef.current?.focus();
  }, [presentedInspectorPlacement]);
  const currentDraftRevision = state.project?.currentContext.draftRevision;
  useEffect(() => {
    if (!restoreTarget) return;
    if (view.kind !== 'historical' || view.revision !== restoreTarget.revision) {
      setRestoreTarget(null);
      setRestoreFocusTarget(view.kind === 'current' ? 'inspector' : 'banner');
      return;
    }
    if (currentDraftRevision !== undefined && currentDraftRevision !== restoreTarget.expectedDraftRevision) {
      setRestoreTarget({ revision: restoreTarget.revision, expectedDraftRevision: currentDraftRevision });
    }
  }, [currentDraftRevision, restoreTarget, view]);
  useLayoutEffect(() => {
    if (restoreTarget || restoreFocusTarget === null) return;
    if (restoreFocusTarget === 'inspector' && (view.kind !== 'current' || state.project?.view.kind !== 'current')) return;
    setRestoreFocusTarget(null);
    if (restoreFocusTarget === 'inspector') focusRestoreInspectorTrigger();
    else restoreTriggerRef.current?.focus();
  }, [focusRestoreInspectorTrigger, restoreFocusTarget, restoreTarget, state.project?.view.kind, view.kind]);
  useEffect(() => {
    if (!currentReloadPending || view.kind !== 'current') return;
    setCurrentReloadPending(false);
    void state.reload().catch(() => undefined);
  }, [currentReloadPending, state, view.kind]);
  useEffect(() => {
    if (!map) return;
    const onMove = () => updateMapScale(map);
    const onPointerMove = (event: { lngLat?: { lat: number; lng: number } }) => {
      if (!event.lngLat) return;
      clearKeyboardNavigation();
      updateCoordinates(event.lngLat);
    };
    const onMoveEnd = () => {
      if (!keyboardNavigationRef.current) return;
      updateCoordinates(map.getCenter());
      scheduleKeyboardNavigationClear();
    };
    const onCanvasKeyDown = (event: KeyboardEvent) => {
      if (!MAP_KEYBOARD_NAVIGATION_KEYS.has(event.key)) return;
      if (liveRegionClearTimerRef.current !== null) window.clearTimeout(liveRegionClearTimerRef.current);
      liveRegionClearTimerRef.current = null;
      keyboardNavigationRef.current = true;
      setKeyboardNavigationActive(true);
    };
    const onCanvasBlur = () => clearKeyboardNavigation();
    const canvas = map.getCanvas();
    map.on('move', onMove);
    map.on('mousemove', onPointerMove as never);
    map.on('moveend', onMoveEnd);
    canvas.addEventListener('keydown', onCanvasKeyDown);
    canvas.addEventListener('blur', onCanvasBlur);
    return () => {
      map.off('move', onMove);
      map.off('mousemove', onPointerMove as never);
      map.off('moveend', onMoveEnd);
      canvas.removeEventListener('keydown', onCanvasKeyDown);
      canvas.removeEventListener('blur', onCanvasBlur);
      keyboardNavigationRef.current = false;
      if (liveRegionClearTimerRef.current !== null) window.clearTimeout(liveRegionClearTimerRef.current);
      liveRegionClearTimerRef.current = null;
    };
  }, [clearKeyboardNavigation, map, scheduleKeyboardNavigationClear, updateCoordinates, updateMapScale]);
  const selectMode = useCallback((next: MapDesignStudioMode) => {
    const nextTab = next === 'map' ? 'layers' : next === 'style' ? 'revisions' : 'comments';
    if (nextTab === inspectorTab && resolvedInspectorPlacement !== 'closed' && !drawerClosing) {
      closeInspector();
      return;
    }
    setInspectorTab(nextTab);
    setInspectorOpen(true);
  }, [closeInspector, drawerClosing, inspectorTab, resolvedInspectorPlacement, setInspectorOpen]);

  const data = state.project;
  const commit = useCallback(async () => {
    if (view.kind === 'historical' || !data || !preview || preview.status !== 'succeeded' || commitControllerRef.current) return;
    setCommitting(true);
    const controller = new AbortController();
    commitControllerRef.current = controller;
    try {
      await commitMapDesignRevisionFromPreview(projectId, {
        expectedRevision: data.context.draftRevision,
        idempotencyKey: await mapDesignPreviewCommitKey(projectId, preview.previewId), previewId: preview.previewId,
        intentSummary: mapDesignPreviewCommitIntent(projectId, preview.previewId),
      }, controller.signal);
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        try { await state.reload(); } catch { /* keep the durable preview available for same-key retry */ }
      }
      if (commitControllerRef.current === controller) commitControllerRef.current = null;
      if (mountedRef.current) setCommitting(false);
    }
  }, [data, preview, projectId, state, t, view.kind]);

  useEffect(() => {
    const column = mapColumnRef.current;
    if (!map || !column || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(column);
    return () => observer.disconnect();
  }, [map]);

  const closeRestoreDialog = useCallback((focusTarget: 'banner' | 'inspector' = 'banner') => {
    setRestoreTarget(null);
    setRestoreFocusTarget(focusTarget);
    if (focusTarget === 'inspector') focusRestoreInspectorTrigger();
  }, [focusRestoreInspectorTrigger]);
  const restoreConflict = useCallback(async () => {
    setRestoreAnnouncement(t('mapDesign.revision.restoreConflict'));
    try { await state.reload(); } catch { /* the open dialog remains available for the next explicit retry */ }
  }, [state, t]);

  if (viewError || (state.error && view.kind === 'historical')) return <section className="grid h-full place-items-center text-muted-foreground" role="alert">
    <p>{t('mapDesign.revision.historicalUnavailable')}</p>
    <Button type="button" onClick={() => onViewChange?.({ kind: 'current' })}>{t('mapDesign.revision.returnCurrent')}</Button>
  </section>;
  if (!data) return <div className="grid h-full place-items-center text-muted-foreground" role={state.error ? 'alert' : undefined}>
    {state.error ? t('mapDesign.studio.loadError') : <MapLoading label={t('mapDesign.studio.loading')} />}
  </div>;

  const selectedRevision = view.kind === 'historical' ? view.revision : null;
  const selectedRevisionMetadata = selectedRevision === null ? null
    : data.revisions.revisions.find((revision) => revision.revision === selectedRevision) ?? null;
  const displayedStyleHash = selectedRevisionMetadata?.styleHash ?? data.context.styleHash;
  const canCommit = view.kind === 'current'
    && preview?.status === 'succeeded'
    && preview.draftRevision === data.context.draftRevision && preview.styleHash === data.context.styleHash
    && data.validation.summary.status === 'valid'
    && !data.revisions.revisions.some((revision) => revision.previewId === preview.previewId);

  const inspector = <MapDesignInspectorPanel id={inspectorId} placement={presentedInspectorPlacement} closing={drawerClosing} width={resolvedInspectorWidth}
      topInset={historicalBannerHeight}
      onCommentsHost={setCommentListHost}
      tab={inspectorTab} commentCount={commentCount} inspect={data.inspect}
      revisions={data.revisions} preview={preview} canCommit={canCommit} committing={committing}
      currentCommittedRevision={data.currentContext.committedRevision} view={view}
      onTabChange={setInspectorTab}
      onCommit={() => { if (view.kind === 'historical') return; void commit().catch(() => undefined); }}
      onViewRevision={(revision) => onViewChange?.({ kind: 'historical', revision })} onPinChange={setInspectorPinned}
      onWidthChange={setInspectorWidth} onClose={closeInspector} />;

  return <div className="group/studio relative grid h-full min-h-0 grid-cols-[minmax(0,1fr)] overflow-hidden bg-background text-foreground" data-fullscreen={fullscreen} data-conversation="external"
    data-view={view.kind}
    data-view-mode={viewMode}
    data-inspector-placement={presentedInspectorPlacement}
    data-direction={typeof document !== 'undefined' && document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr'}
    style={{ '--map-inspector-width': `${Math.min(420, Math.max(280, resolvedInspectorWidth))}px` } as CSSProperties}>
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0" onLayoutChanged={(nextLayout, meta) => {
      if (!meta.isUserInteraction) return;
      const group = mapColumnRef.current?.closest('[data-slot="resizable-panel-group"]');
      if (group instanceof HTMLElement && nextLayout.inspector !== undefined) setInspectorWidth(resizablePanelWidth(group, nextLayout.inspector));
    }}>
    <ResizablePanel id="studio-map" minSize={0} className="min-h-0">
    <section ref={mapColumnRef} className="relative grid h-full min-h-0 min-w-0 grid-rows-[auto_auto_minmax(0,1fr)] bg-muted" aria-label={t('mapDesign.studio.mapCanvas')}
      aria-hidden={drawerModalActive || undefined}>
      <MapDesignStudioHeader onHeightChange={onHeaderHeightChange} title={title} draftRevision={data.context.draftRevision}
        mode={inspectorTab === 'revisions' ? 'style' : inspectorTab === 'layers' ? 'map' : 'comments'} fullscreen={fullscreen}
        inspectorOpen={resolvedInspectorPlacement !== 'closed' && !drawerClosing}
        inspectorId={inspectorId} commentCount={commentCount} onToggleFullscreen={toggleFullscreen}
        onModeChange={selectMode}
        viewMode={viewMode} onViewModeChange={next => { setViewMode(next); if (next === 'code') { setCodeOpened(true); setEditingStyle(false); } }}
        inspectorTriggerRef={inspectorTriggerRef}
        actions={<div className={viewMode === 'code' ? 'hidden' : 'flex min-w-0 flex-wrap items-center gap-1'}>
          <div ref={setCommentToolbarHost} className="flex items-center" />
          <Button ref={editTriggerRef} type="button" size="sm" variant={editingStyle ? 'default' : 'ghost'}
            aria-label={styleEditCopy[locale].edit} title={styleEditCopy[locale].edit} aria-pressed={editingStyle}
            disabled={!map || view.kind === 'historical' || mapEditingDisabled} onClick={() => setEditingStyle((active) => !active)}><Pencil data-icon="inline-start" />{styleEditCopy[locale].edit}</Button>
          <MapScreenshotButton projectId={projectId} targetKey={screenshotTargetKey} map={map} draftRevision={data.context.draftRevision}
            styleHash={displayedStyleHash} disabled={view.kind === 'historical' || editingStyle} count={screenshotCount} onCapture={onScreenshot} />
        </div>} />
      {view.kind === 'historical' ? <MapDesignHistoricalBanner revision={view.revision} restoreTriggerRef={restoreTriggerRef}
        onHeightChange={setHistoricalBannerHeight}
        onReturnCurrent={() => onViewChange?.({ kind: 'current' })}
        onRequestRestore={() => setRestoreTarget({ revision: view.revision, expectedDraftRevision: data.currentContext.draftRevision })} /> : null}
      {state.error ? <Alert variant="destructive" appearance="floating" className="z-3 col-start-1 row-start-3 mx-3.5 mt-3 w-auto self-start">{t('mapDesign.studio.loadError')}</Alert>
        : mapError ? <Alert variant={mapError === 'load' ? 'destructive' : 'default'} appearance="floating" className="z-3 col-start-1 row-start-3 mx-3.5 mt-3 w-auto self-start">
          <span>{mapError === 'load' ? t('mapDesign.studio.loadError') : resourceErrorCopy[locale][mapError]}</span>
          <Button type="button" onClick={() => { setMapError(null); setMapAttempt((attempt) => attempt + 1); }}>
            {t('mapDesign.conversation.retry')}
          </Button>
        </Alert> : null}
      <MapCanvas key={`${projectId}:${view.kind}:${selectedRevision ?? 'current'}:${mapAttempt}`} projectId={projectId} initialStyle={data.style} className={`relative col-start-1 row-start-3 h-full min-h-80 w-full min-w-0 max-w-full overflow-hidden ${viewMode === 'code' ? 'invisible pointer-events-none' : ''}`}
        layoutRevision={layoutRevision}
        onMapError={(event) => setMapError(event?.status === 429 ? 'rate-limit' : event?.sourceId || event?.status ? 'resource' : 'load')}
        onMapIdle={() => setMapError((issue) => issue === 'load' ? null : issue)}
        onMapReady={(owned: OwnedMap) => {
          const nextMap = owned as MapLibreMap;
          const camera = cameraRef.current;
          if (camera?.projectId === projectId) {
            const { center, zoom, bearing, pitch } = camera;
            nextMap.jumpTo({ center, zoom, bearing, pitch });
          }
          setMap(nextMap);
          updateMapScale(nextMap);
        }} />
      {viewMode === 'preview' ? <MapNavigationControls map={map} /> : null}
      {codeOpened ? <div className={`z-1 col-start-1 row-start-3 min-h-0 min-w-0 overflow-hidden ${viewMode === 'code' ? '' : 'hidden'}`}>
        <Suspense fallback={<MapLoading label={t('mapDesign.studio.loading')} />}>
          <StyleCode key={`${projectId}:${view.kind}:${selectedRevision ?? 'current'}`} projectId={projectId} style={data.style}
            draftRevision={data.context.draftRevision} styleHash={displayedStyleHash}
            readOnly={view.kind === 'historical' || mapEditingDisabled} onSaved={state.reload} />
        </Suspense>
      </div> : null}
      <MapDesignComments projectId={projectId} map={map} draftRevision={data.context.draftRevision} styleHash={displayedStyleHash}
        toolbarHost={commentToolbarHost} listHost={commentListHost}
        readOnly={view.kind === 'historical'} submissionDisabled={commentSubmissionDisabled}
        suspended={editingStyle || viewMode === 'code'} onActivate={() => { setEditingStyle(false); if (presentedInspectorPlacement === 'drawer') setInspectorOpen(false); }}
        onOpenList={() => { setInspectorTab('comments'); setInspectorOpen(true); }} onCountChange={setCommentCount}
        onSubmit={onSubmitComments ?? unavailableCommentSubmission} />
      <MapDesignStyleEditor projectId={projectId} map={map} draftRevision={data.context.draftRevision} styleHash={displayedStyleHash}
        finalFocus={editTriggerRef} active={editingStyle} disabled={view.kind === 'historical' || mapEditingDisabled}
        onSaved={state.reload} />
      {map && view.kind === 'current' ? <StudioRuntime map={map} projectId={projectId} data={data}
        onPreview={async (output) => { setPreview(output); await state.reload(); }} onReload={state.reload} /> : null}
      <MapDesignStatusBar projection="EPSG:3857" scale={`1:${new Intl.NumberFormat(locale).format(mapStatus.scaleDenominator)}`}
        draftRevision={data.context.draftRevision} synced={data.context.previewStatus === 'current'}
        coordinates={formatMapCoordinates(mapStatus.coordinates, t)}
        keyboardNavigationActive={keyboardNavigationActive} />
    </section>
    </ResizablePanel>
    {presentedInspectorPlacement === 'docked' && !fullscreen ? <>
      <ResizableHandle withHandle aria-label={t('mapDesign.studio.inspectorResize')} variant="subtle" />
      <ResizablePanel id="inspector" defaultSize={resolvedInspectorWidth} minSize={280} maxSize={420} className="min-h-0">
        {inspector}
      </ResizablePanel>
    </> : null}
    </ResizablePanelGroup>
    {presentedInspectorPlacement !== 'docked' ? inspector : null}
    {restoreAnnouncement ? <p className="absolute inset-x-3.5 bottom-9 z-10 rounded-md border bg-background px-2.5 py-2 text-xs shadow-sm" role="status" aria-live="polite">{restoreAnnouncement}</p> : null}
    {restoreTarget && view.kind === 'historical' && restoreTarget.revision === view.revision ? <MapDesignRestoreRevisionDialog key={`${projectId}:${restoreTarget.revision}:${restoreTarget.expectedDraftRevision}`}
      projectId={projectId} revision={restoreTarget.revision} expectedDraftRevision={restoreTarget.expectedDraftRevision}
      onClose={closeRestoreDialog} onConflict={restoreConflict}
      onRestored={async (result) => {
        setRestoreAnnouncement(t('mapDesign.revision.restoreSuccess', { revision: result.restoredRevision, draftRevision: result.draftRevision }));
        closeRestoreDialog('inspector');
        onViewChange?.({ kind: 'current' }, { replace: true });
        setCurrentReloadPending(true);
      }} /> : null}
  </div>;
}

async function unavailableCommentSubmission(): Promise<boolean> { return false; }

function formatMapCoordinates(coordinates: MapStatus['coordinates'], t: ReturnType<typeof useI18n>['t']): string {
  if (!coordinates) return '—';
  const formatCoordinate = (value: number, positive: 'north' | 'east', negative: 'south' | 'west') => {
    const direction = value >= 0
      ? positive === 'north' ? t('mapDesign.studio.north') : t('mapDesign.studio.east')
      : negative === 'south' ? t('mapDesign.studio.south') : t('mapDesign.studio.west');
    return `${Math.abs(value).toFixed(3)}°${direction}`;
  };
  return `${formatCoordinate(coordinates.lat, 'north', 'south')}, ${formatCoordinate(coordinates.lng, 'east', 'west')}`;
}

export async function mapDesignPreviewCommitKey(projectId: string, previewId: string): Promise<string> {
  const identity = `mapdesign-preview-commit:${projectId}:${previewId}`;
  if (identity.length <= 128) return identity;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `mapdesign-preview-commit:${hex}`;
}

export function mapDesignPreviewCommitIntent(projectId: string, previewId: string): string {
  return mapCommitPreviewIntentSummary(projectId, previewId);
}

function StudioRuntime({ map, projectId, data, onPreview, onReload }: {
  map: MapLibreMap; projectId: string; data: MapDesignProjectData;
  onPreview(output: MapRenderPreviewOutput): Promise<void>; onReload(): Promise<void>;
}) {
  const { locale, t } = useI18n();
  const liveRef = useRef<LiveDraftController | null>(null);
  useEffect(() => {
    const live = new LiveDraftController({
      map, projectId, initialContext: { draftRevision: data.context.draftRevision, styleHash: data.context.styleHash },
      loadCanonical: async (_reason, signal) => {
        const [context, style] = await Promise.all([
          getMapDesignContext(projectId, signal), getMapDesignStyle(projectId, signal),
        ]);
        return { context: { draftRevision: context.draftRevision, styleHash: context.styleHash }, style };
      },
    });
    liveRef.current = live;
    return () => { live.close(); if (liveRef.current === live) liveRef.current = null; };
  }, [map, projectId]);
  const getLive = useCallback(() => {
    if (!liveRef.current) throw new Error('The map runtime is unavailable.');
    return liveRef.current;
  }, []);
  const renderer = useCallback(async (request: Extract<MapStudioEventRecord['event'], { type: 'preview.requested' }>['payload'], signal: AbortSignal) => {
    const live = getLive();
    const validation = await validateMapDesignProject(projectId, request.draftRevision, signal);
    const output = await renderMapDesignPreview({ map: map as never, request, snapshot: () => live.snapshot(),
      loadCanonical: async (reason) => { await live.reload(reason); },
      validationDigest: validation.validationDigest,
      fulfill: (body, currentSignal) => fulfillMapDesignPreview(projectId, request.previewId, body, currentSignal), signal });
    return output;
  }, [getLive, map, projectId]);
  const previews = usePreviewRequests({ renderPreview: renderer, onTerminal: async (output) => {
    if (isPreviewOutput(output)) await onPreview(output);
  } });
  const controller = useMemo(() => ({
    handleRecord: async (record: MapStudioEventRecord) => {
      await getLive().handleRecord(record);
      await previews.handleRecord(record);
      if (record.event.type === 'revision.committed') await onReload();
    },
    handleGap: (gap: { oldestAvailableSequence?: number | null; latestSequence?: number | null }) => getLive().handleGap(gap),
    reload: async (reason: string) => { await getLive().reload(reason); await onReload(); },
  }), [getLive, onReload, previews.handleRecord]);
  const events = useMapDesignEvents({ projectId, controller });
  if (events.status !== 'recovering' && events.status !== 'recovery-failed') return null;
  return <Alert variant={events.status === 'recovery-failed' ? 'destructive' : 'default'} appearance="floating"
    className="absolute inset-x-3.5 bottom-3 z-10 w-auto" role={events.status === 'recovering' ? 'status' : 'alert'}>
    <span>{eventConnectionCopy[locale][events.status]}</span>
    {events.status === 'recovery-failed' ? <Button type="button" onClick={events.retry}>{t('mapDesign.conversation.retry')}</Button> : null}
  </Alert>;
}

function isPreviewOutput(value: unknown): value is MapRenderPreviewOutput {
  return typeof value === 'object' && value !== null && 'report' in value && 'validationSummary' in value
    && ((value as { status?: unknown }).status === 'succeeded' || (value as { status?: unknown }).status === 'failed');
}
