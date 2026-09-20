import { MapDesignWorkspacePanels } from './components/MapDesignWorkspacePanels';
import { MapLoading } from '@mapseekai/components';
import { MAP_SCREENSHOT_MAX_COUNT, type MapScreenshot } from '@mapseekai/contracts';
import { Button, type PanelImperativeHandle } from '@mapseekai/components';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '../i18n';
import { navigationCopy } from '../i18n/locales/navigation';
import { navigate } from '../router';
import { getMapDesignProject, MapDesignClientError, retryMapDesignImport } from './client';
import { MapDesignStudio } from './MapDesignStudio';
import { TitlebarProject } from './components/MapDesignTitlebar';
import { MapDesignChatPane, type MapCommentSubmission } from './chat/MapDesignChatPane';
import { MapDesignConversationHeader } from './chat/MapDesignConversationHeader';
import { useMapDesignConversations } from './chat/useMapDesignConversations';
import { MapDesignViewSwitcher, type MapDesignMobileView } from './components/MapDesignViewSwitcher';
import type { MapDesignInspectorPlacement } from './components/MapDesignInspectorPanel';
import { useMapDesignLayoutPreferences } from './hooks/useMapDesignLayoutPreferences';
import { useLocalAgents } from './hooks/useLocalAgents';
import type { MapDesignProjectView } from './hooks/useMapDesignProject';
import type { CartographySummary } from '@mapseekai/map-design-contracts';

export interface MapDesignWorkspaceProps {
  projectId: string;
  onMissingProject(message: string): void;
  onOpenSettings(): void;
}

interface WorkspaceState {
  loadedProjectId: string;
  title: string;
  cartography?: CartographySummary;
}

type WorkspaceError = 'load-failed' | 'import-failed';

const IMPORT_POLL_MS = 250;
const CURRENT_MAP_DESIGN_PROJECT_VIEW: MapDesignProjectView = { kind: 'current' };

export interface ParsedMapDesignProjectView {
  view: MapDesignProjectView;
  error: 'invalid-revision' | null;
}

interface WorkspaceLocationState extends ParsedMapDesignProjectView {
  conversationId: string | null;
}

export function parseMapDesignProjectView(search: string): ParsedMapDesignProjectView {
  const revision = new URLSearchParams(search).get('revision');
  if (revision === null) return { view: CURRENT_MAP_DESIGN_PROJECT_VIEW, error: null };
  if (!/^\d+$/u.test(revision)) return { view: CURRENT_MAP_DESIGN_PROJECT_VIEW, error: 'invalid-revision' };
  const parsedRevision = Number(revision);
  if (!Number.isSafeInteger(parsedRevision) || parsedRevision < 0) {
    return { view: CURRENT_MAP_DESIGN_PROJECT_VIEW, error: 'invalid-revision' };
  }
  return { view: { kind: 'historical', revision: parsedRevision }, error: null };
}

function workspaceLocationState(): WorkspaceLocationState {
  const search = window.location.search;
  return {
    ...parseMapDesignProjectView(search),
    conversationId: new URLSearchParams(search).get('conversation'),
  };
}

export function MapDesignWorkspace({ projectId, onMissingProject, onOpenSettings }: MapDesignWorkspaceProps) {
  const { t, locale } = useI18n();
  const [mapHeaderHeight, setMapHeaderHeight] = useState<number | null>(null);
  const unavailableProjectNotice = t('mapDesign.workspace.unavailableProject');
  const unavailableProject = useRef(unavailableProjectNotice);
  unavailableProject.current = unavailableProjectNotice;
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [error, setError] = useState<WorkspaceError | null>(null);
  const [importing, setImporting] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [drawerModalActive, setDrawerModalActive] = useState(false);
  const [commentSubmission, setCommentSubmission] = useState<MapCommentSubmission | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [screenshotsByConversation, setScreenshotsByConversation] = useState<Record<string, MapScreenshot[]>>({});
  useEffect(() => setScreenshotsByConversation({}), [projectId]);
  const [mobileView, setMobileView] = useState<MapDesignMobileView>('chat');
  const [retry, setRetry] = useState(0);
  const layout = useMapDesignLayoutPreferences();
  const compactLayout = useMediaQuery('(max-width: 1199px)');
  const mobileLayout = useMediaQuery('(max-width: 767px)');
  const lifecycleGeneration = useRef(0);
  const retryGeneration = useRef(0);
  const focusRailAfterCollapse = useRef(false);
  const expandConversationRef = useRef<HTMLButtonElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const chatColumnRef = useRef<HTMLDivElement | null>(null);
  const chatPanelRef = useRef<PanelImperativeHandle | null>(null);
  const retryRequest = useRef<{ controller: AbortController; projectId: string; generation: number } | null>(null);
  const currentProjectId = useRef(projectId);
  const fullscreenRef = useRef(false);
  const inspectorOpenRef = useRef(false);
  const inspectorPinnedRef = useRef(layout.inspectorPinned);
  const mobileViewRef = useRef<MapDesignMobileView>('chat');
  const pendingResizeRef = useRef<'chat' | 'inspector' | null>(null);
  const gridTransitionRef = useRef({ nextGeneration: 0, pendingGeneration: null as number | null, activeGeneration: null as number | null });
  const breakpointRef = useRef<string | null>(null);
  const [urlState, setUrlState] = useState<WorkspaceLocationState>(workspaceLocationState);
  const readOnly = urlState.error !== null || urlState.view.kind === 'historical';
  const conversations = useMapDesignConversations(projectId, urlState.conversationId, readOnly);
  const localAgents = useLocalAgents();
  currentProjectId.current = projectId;
  inspectorPinnedRef.current = layout.inspectorPinned;

  useEffect(() => {
    const onPopState = () => setUrlState(workspaceLocationState());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const setProjectView = useCallback((view: MapDesignProjectView, options?: { replace?: boolean }) => {
    const url = new URL(window.location.href);
    if (view.kind === 'historical') url.searchParams.set('revision', String(view.revision));
    else url.searchParams.delete('revision');
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    if (options?.replace) window.history.replaceState(window.history.state, '', nextUrl);
    else window.history.pushState(window.history.state, '', nextUrl);
    setUrlState((current) => ({ ...current, view, error: null }));
  }, []);

  const canAwaitGridTransition = useCallback(() => {
    const workspace = workspaceRef.current;
    if (!workspace || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
    const computed = window.getComputedStyle(workspace);
    const properties = computed.transitionProperty.split(',').map((value) => value.trim());
    const durations = computed.transitionDuration.split(',').map((value) => Number.parseFloat(value));
    return properties.some((property) => property === 'all' || property === 'grid-template-columns')
      && durations.some((duration) => Number.isFinite(duration) && duration > 0);
  }, []);
  const commitLayout = useCallback((awaitGridTransition = false) => {
    if (awaitGridTransition && canAwaitGridTransition()) {
      const generation = gridTransitionRef.current.nextGeneration + 1;
      gridTransitionRef.current.nextGeneration = generation;
      gridTransitionRef.current.pendingGeneration = generation;
    }
    setLayoutRevision((revision) => revision + 1);
  }, [canAwaitGridTransition]);
  const commitPendingResize = useCallback(() => {
    if (!pendingResizeRef.current) return;
    pendingResizeRef.current = null;
    commitLayout(true);
  }, [commitLayout]);
  const setChatCollapsed = useCallback((collapsed: boolean) => {
    if (layout.chatCollapsed === collapsed) return;
    layout.setChatCollapsed(collapsed);
    commitLayout(true);
  }, [commitLayout, layout]);
  const setInspectorWidth = useCallback((width: number) => {
    pendingResizeRef.current = 'inspector';
    layout.setInspectorWidth(width);
  }, [layout]);
  const setInspectorPinned = useCallback((pinned: boolean) => {
    if (inspectorPinnedRef.current === pinned) return;
    inspectorPinnedRef.current = pinned;
    layout.setInspectorPinned(pinned);
    commitLayout();
  }, [commitLayout, layout]);
  const setInspectorOpenCommitted = useCallback((open: boolean) => {
    if (inspectorOpenRef.current === open) return;
    inspectorOpenRef.current = open;
    setInspectorOpen(open);
    commitLayout();
  }, [commitLayout]);
  const setFullscreenCommitted = useCallback((next: boolean) => {
    if (fullscreenRef.current === next) return;
    fullscreenRef.current = next;
    setFullscreen(next);
    commitLayout(true);
  }, [commitLayout]);
  const setMobileViewCommitted = useCallback((view: MapDesignMobileView) => {
    if (mobileViewRef.current === view) return;
    mobileViewRef.current = view;
    setMobileView(view);
    commitLayout();
  }, [commitLayout]);

  useLayoutEffect(() => {
    const size = fullscreen ? 0 : mobileLayout ? (mobileView === 'chat' ? '100%' : 0)
      : layout.chatCollapsed ? 48 : compactLayout ? 320 : layout.chatWidth;
    chatPanelRef.current?.resize(size);
  }, [fullscreen, mobileLayout, mobileView, layout.chatCollapsed, compactLayout, layout.chatWidth]);

  useLayoutEffect(() => {
    const breakpoint = `${compactLayout}:${mobileLayout}`;
    if (breakpointRef.current === null) {
      breakpointRef.current = breakpoint;
      return;
    }
    if (breakpointRef.current === breakpoint) return;
    breakpointRef.current = breakpoint;
    commitLayout(!mobileLayout || mobileView === 'map');
  }, [commitLayout, compactLayout, mobileLayout, mobileView]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const isGridTransition = (event: globalThis.TransitionEvent) => event.target === workspace && event.propertyName === 'grid-template-columns';
    const onTransitionRun = (event: globalThis.TransitionEvent) => {
      if (!isGridTransition(event) || gridTransitionRef.current.pendingGeneration === null) return;
      gridTransitionRef.current.activeGeneration = gridTransitionRef.current.pendingGeneration;
    };
    const completeTransition = (event: globalThis.TransitionEvent) => {
      if (!isGridTransition(event)) return;
      const { activeGeneration, pendingGeneration } = gridTransitionRef.current;
      const generation = activeGeneration ?? pendingGeneration;
      if (generation === null || generation !== pendingGeneration) return;
      gridTransitionRef.current.activeGeneration = null;
      gridTransitionRef.current.pendingGeneration = null;
      commitLayout();
    };
    workspace.addEventListener('transitionrun', onTransitionRun);
    workspace.addEventListener('transitionend', completeTransition);
    workspace.addEventListener('transitioncancel', completeTransition);
    return () => {
      workspace.removeEventListener('transitionrun', onTransitionRun);
      workspace.removeEventListener('transitionend', completeTransition);
      workspace.removeEventListener('transitioncancel', completeTransition);
    };
  }, [commitLayout, state?.loadedProjectId]);

  useEffect(() => {
    if (!layout.chatCollapsed || !focusRailAfterCollapse.current) return;
    focusRailAfterCollapse.current = false;
    expandConversationRef.current?.focus();
  }, [layout.chatCollapsed]);
  useEffect(() => {
    const chat = chatColumnRef.current;
    const split = workspaceRef.current?.querySelector<HTMLElement>('[role="separator"]');
    const mapSurface = workspaceRef.current?.querySelector<HTMLElement>('#map-design-map-surface');
    const viewSwitcher = workspaceRef.current?.querySelector<HTMLElement>('[role="tablist"]');
    const setIsolation = (element: HTMLElement | null | undefined, isolated: boolean) => {
      if (!element) return;
      if (isolated) {
        element.setAttribute('inert', '');
        element.setAttribute('aria-hidden', 'true');
      } else {
        element.removeAttribute('inert');
        element.removeAttribute('aria-hidden');
      }
    };
    setIsolation(chat, drawerModalActive || (mobileLayout && mobileView !== 'chat'));
    setIsolation(split, drawerModalActive);
    setIsolation(mapSurface, mobileLayout && mobileView !== 'map');
    setIsolation(viewSwitcher, drawerModalActive);
    return () => {
      setIsolation(chat, false);
      setIsolation(split, false);
      setIsolation(mapSurface, false);
      setIsolation(viewSwitcher, false);
    };
  }, [drawerModalActive, mobileLayout, mobileView]);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++lifecycleGeneration.current;
    retryRequest.current?.controller.abort();
    retryRequest.current = null;
    setState(null);
    setError(null);
    setImporting(false);
    setFullscreen(false);
    setInspectorOpen(false);
    fullscreenRef.current = false;
    inspectorOpenRef.current = false;
    const isCurrent = () => !controller.signal.aborted && lifecycleGeneration.current === generation;
    const projectRequest = async () => {
      while (isCurrent()) {
        const aggregate = await getMapDesignProject(projectId, controller.signal);
        if (!isCurrent()) return null;
        if (aggregate.project.lifecycle === 'ready') return aggregate;
        if (aggregate.project.lifecycle === 'failed') {
          setError('import-failed');
          return null;
        }
        setImporting(true);
        await waitForImportPoll(controller.signal);
      }
      return null;
    };
    const load = async () => {
      try {
        const aggregate = await projectRequest();
        if (!isCurrent() || !aggregate) return;
        setImporting(false);
        setState({
          loadedProjectId: projectId,
          title: aggregate.title,
          ...(aggregate.cartography ? { cartography: aggregate.cartography } : {}),
        });
      } catch (reason: unknown) {
        if (!isCurrent()) return;
        if (reason instanceof MapDesignClientError && reason.code === 'NOT_FOUND') {
          onMissingProject(unavailableProject.current);
          return;
        }
        setError('load-failed');
      }
    };
    void load();
    return () => {
      controller.abort();
      lifecycleGeneration.current++;
      if (retryRequest.current?.projectId === projectId) {
        retryRequest.current.controller.abort();
        retryRequest.current = null;
      }
    };
  }, [onMissingProject, projectId, retry]);

  const retryImport = () => {
    retryRequest.current?.controller.abort();
    const controller = new AbortController();
    const generation = ++retryGeneration.current;
    retryRequest.current = { controller, projectId, generation };
    void retryMapDesignImport(
      projectId,
      `map-import-retry:${projectId}:${crypto.randomUUID()}`,
      controller.signal,
    ).then(() => {
      if (
        controller.signal.aborted
        || currentProjectId.current !== projectId
        || retryRequest.current?.generation !== generation
      ) return;
      setRetry((attempt) => attempt + 1);
    }).catch(() => {
      if (
        controller.signal.aborted
        || currentProjectId.current !== projectId
        || retryRequest.current?.generation !== generation
      ) return;
      setError('load-failed');
    });
  };
  const backHome = <Button type="button" variant="ghost" onClick={() => navigate({ kind: 'home' })}>{navigationCopy[locale].backHome}</Button>;
  if (error) {
    return <div className="grid place-items-center text-muted-foreground" style={{ minHeight: 'calc(100dvh - var(--app-titlebar-height, 0px))' }} role="alert">
      <p>{error === 'import-failed'
          ? t('mapDesign.workspace.importFailed')
          : t('mapDesign.workspace.loadError')}</p>
      {error === 'import-failed'
          ? <Button type="button" onClick={retryImport}>{t('mapDesign.workspace.retryImport')}</Button>
          : <Button type="button" onClick={() => setRetry((attempt) => attempt + 1)}>{t('mapDesign.conversation.retry')}</Button>}
      {backHome}
    </div>;
  }
  if (importing) {
    return <MapLoading variant="screen" label={t('mapDesign.workspace.importing')}>{backHome}</MapLoading>;
  }
  if (!state || state.loadedProjectId !== projectId) {
    return <MapLoading variant="screen" label={t('mapDesign.workspace.loading')}>{backHome}</MapLoading>;
  }
  const selectedConversation = conversations.selected?.projectId === state.loadedProjectId ? conversations.selected : null;
  const viewedRevision = urlState.view.kind === 'historical' ? urlState.view.revision : undefined;
  const readOnlyReason = urlState.view.kind === 'historical'
    ? t('mapDesign.revision.composerReadOnly')
    : urlState.error !== null ? t('mapDesign.revision.historicalUnavailable') : null;
  const workspaceStyle = {
    '--chat-header-height': mapHeaderHeight === null ? 'var(--studio-header-height)' : `${mapHeaderHeight}px`, height: 'calc(100dvh - var(--app-titlebar-height, 0px))', minHeight: 0, '--map-chat-preferred-width': `${layout.chatWidth}px` } as CSSProperties;
  const inspectorPlacement: MapDesignInspectorPlacement = !inspectorOpen ? 'closed'
    : compactLayout ? 'drawer'
      : layout.inspectorPinned ? 'docked' : 'floating';
  return <div ref={workspaceRef} className="group/workspace grid grid-cols-[minmax(0,1fr)] overflow-hidden bg-background text-foreground max-md:min-h-0 max-md:grid-rows-[44px_minmax(0,1fr)] max-md:data-[fullscreen=true]:grid-rows-[minmax(0,1fr)]" style={workspaceStyle} data-fullscreen={fullscreen}
    data-chat-collapsed={layout.chatCollapsed} key={state.loadedProjectId}
    onPointerUpCapture={commitPendingResize} onPointerCancelCapture={commitPendingResize}
    onKeyUpCapture={commitPendingResize}>
    <TitlebarProject title={state.title} />
    <MapDesignViewSwitcher view={mobileView} chatPanelId="map-design-chat-surface" mapPanelId="map-design-map-surface"
      onViewChange={setMobileViewCommitted} />
    <MapDesignWorkspacePanels
      groupProps={{ disabled: mobileLayout || fullscreen || layout.chatCollapsed || compactLayout,
        onLayoutChanged: (_, meta) => {
          if (!meta.isUserInteraction || mobileLayout || fullscreen || layout.chatCollapsed || compactLayout) return;
          const width = chatPanelRef.current?.getSize().inPixels;
          if (width !== undefined) layout.setChatWidth(width);
          commitLayout();
        },
      }}
      chatPanelProps={{ panelRef: chatPanelRef,
        defaultSize: fullscreen ? 0 : mobileLayout ? (mobileView === 'chat' ? '100%' : 0) : layout.chatCollapsed ? 48 : compactLayout ? 320 : layout.chatWidth,
        minSize: fullscreen || (mobileLayout && mobileView !== 'chat') ? 0 : mobileLayout ? '100%' : layout.chatCollapsed ? 48 : 320,
        maxSize: fullscreen || (mobileLayout && mobileView !== 'chat') ? 0 : mobileLayout ? '100%' : layout.chatCollapsed ? 48 : compactLayout ? 320 : 520,
      }}
      showHandle={!mobileLayout && !fullscreen && !layout.chatCollapsed && !compactLayout}
      chat={
    <div id="map-design-chat-surface" ref={chatColumnRef} className="h-full min-h-0 min-w-0 overflow-hidden border-e bg-background group-data-[fullscreen=true]/workspace:invisible group-data-[fullscreen=true]/workspace:border-0 max-md:col-start-1 max-md:row-start-2 max-md:h-full max-md:border-0 max-md:data-[mobile-view-active=false]:hidden" role={mobileLayout ? 'tabpanel' : undefined}
      aria-label={mobileLayout ? undefined : t('mapDesign.conversation.chatRegion')} aria-labelledby={mobileLayout ? 'map-design-mobile-chat-tab' : undefined}
      data-mobile-view-active={!mobileLayout || mobileView === 'chat'} hidden={mobileLayout && mobileView !== 'chat'}
      aria-hidden={drawerModalActive || (mobileLayout && mobileView !== 'chat') || undefined}>
      <div className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] group-data-[chat-collapsed=true]/workspace:block group-data-[chat-collapsed=true]/workspace:overflow-hidden [&>div]:min-h-0" role="region" aria-label={t('mapDesign.conversation.chatRegion')}>
        {selectedConversation && !layout.chatCollapsed ? <MapDesignConversationHeader conversations={conversations.conversations} selectedId={selectedConversation.conversationId}
        creating={conversations.creating} readOnly={readOnly} error={conversations.error} notice={conversations.notice} onSelect={conversations.select} onDelete={conversations.remove}
        onCreate={() => { if (!readOnly) void conversations.create(); }} onRetry={conversations.failure ? () => { if (!readOnly) void conversations.retry(); } : undefined}
        onCollapse={() => { if (readOnly) return; focusRailAfterCollapse.current = true; setChatCollapsed(true); }} /> : null}
      {!selectedConversation ? <div className="row-span-full grid min-h-0 place-items-center text-muted-foreground">
        {conversations.loading ? <MapLoading label={t('mapDesign.conversation.loading')} /> : <p role="status">{t('mapDesign.conversation.none')}</p>}
        {conversations.error ? <><p role="alert">{conversations.error}</p>
          <Button type="button" disabled={readOnly} onClick={() => { if (!readOnly) void conversations.retry(); }}>{t('mapDesign.conversation.retry')}</Button>
        </> : null}
        {!conversations.loading && !conversations.error ? <Button type="button" disabled={conversations.creating || readOnly}
          onClick={() => { if (!readOnly) void conversations.create(); }}>
          {conversations.creating ? t('mapDesign.conversation.creating') : t('mapDesign.conversation.defaultTitle')}
        </Button> : null}
      </div> : null}
      {selectedConversation ? <MapDesignChatPane projectId={state.loadedProjectId} conversationId={selectedConversation.conversationId}
        {...(state.cartography ? { cartographyLabel: state.cartography.name, cartographyHref: `/cartographies?cartography=${encodeURIComponent(state.cartography.id)}` } : {})}
        agents={localAgents.agents} agentsLoading={localAgents.loading} agentsError={localAgents.error}
        onOpenSettings={onOpenSettings} openSettingsLabel={t('mapDesign.workspace.openSettings')}
        readOnly={readOnly} viewedRevision={viewedRevision} readOnlyReason={readOnlyReason}
        onCommentSubmissionChange={setCommentSubmission}
        screenshots={screenshotsByConversation[selectedConversation.conversationId] ?? []}
        onRemoveScreenshot={(id) => setScreenshotsByConversation((current) => ({ ...current, [selectedConversation.conversationId]: (current[selectedConversation.conversationId] ?? []).filter((shot) => shot.id !== id) }))}
        onScreenshotsSent={(ids) => setScreenshotsByConversation((current) => ({ ...current, [selectedConversation.conversationId]: (current[selectedConversation.conversationId] ?? []).filter((shot) => !ids.includes(shot.id)) }))}
        collapsed={layout.chatCollapsed} onExpandButtonMount={(button) => { expandConversationRef.current = button; }} onExpand={() => { if (!readOnly) setChatCollapsed(false); }} onCreateConversation={() => { if (!readOnly) void conversations.create(); }}
        onStartAccepted={() => { void conversations.refresh(); }} /> : null}
      </div>
    </div>
      }
      studio={
    <div id="map-design-map-surface" className="h-full min-w-0 overflow-hidden max-md:col-start-1 max-md:row-start-2 max-md:h-full max-md:min-h-0 max-md:data-[mobile-view-active=false]:hidden max-md:group-data-[fullscreen=true]/workspace:row-start-1" role={mobileLayout ? 'tabpanel' : undefined}
      aria-labelledby={mobileLayout ? 'map-design-mobile-map-tab' : undefined} data-mobile-view-active={!mobileLayout || mobileView === 'map'}
      hidden={mobileLayout && mobileView !== 'map'}
      aria-hidden={mobileLayout && mobileView !== 'map' || undefined}>
      <MapDesignStudio key={state.loadedProjectId} projectId={state.loadedProjectId} title={state.title}
        mapEditingDisabled={readOnly || commentSubmission?.running === true || conversations.conversations.some((item) => item.runState === 'running')}
        screenshotTargetKey={selectedConversation?.conversationId}
        screenshotCount={selectedConversation ? (screenshotsByConversation[selectedConversation.conversationId]?.length ?? 0) : 0}
        onScreenshot={selectedConversation && !readOnly ? (screenshot) => {
          if (screenshot.projectId !== currentProjectId.current || (screenshotsByConversation[selectedConversation.conversationId]?.length ?? 0) >= MAP_SCREENSHOT_MAX_COUNT) return false;
          setScreenshotsByConversation((current) => ({ ...current, [selectedConversation.conversationId]: [...(current[selectedConversation.conversationId] ?? []), screenshot].slice(0, MAP_SCREENSHOT_MAX_COUNT) }));
          setChatCollapsed(false); setMobileViewCommitted('chat');
          return true;
        } : undefined}
        commentSubmissionDisabled={readOnly || !selectedConversation || !commentSubmission || commentSubmission.disabled
          || commentSubmission.projectId !== state.loadedProjectId || commentSubmission.conversationId !== selectedConversation.conversationId}
        onSubmitComments={async (comments) => {
          if (readOnly || !commentSubmission || commentSubmission.disabled || commentSubmission.projectId !== currentProjectId.current
            || commentSubmission.conversationId !== selectedConversation?.conversationId) return false;
          return commentSubmission.send(comments);
        }}
        view={urlState.view} viewError={urlState.error !== null} onViewChange={setProjectView}
        onHeaderHeightChange={setMapHeaderHeight} layoutRevision={layoutRevision} onFullscreenChange={setFullscreenCommitted} inspectorPlacement={inspectorPlacement} inspectorWidth={layout.inspectorWidth}
        onInspectorOpenChange={setInspectorOpenCommitted} onInspectorPinnedChange={setInspectorPinned}
        onInspectorWidthChange={(width) => { setInspectorWidth(width); commitPendingResize(); }} onDrawerModalChange={setDrawerModalActive} />
    </div>
      }
    />
  </div>;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, [query]);
  return matches;
}

function waitForImportPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, IMPORT_POLL_MS);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
