// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MapDesignProjectFetcher = (projectId: string, signal?: AbortSignal) => Promise<unknown>;

const api = vi.hoisted(() => ({
  project: vi.fn(),
  conversation: vi.fn(),
  conversations: vi.fn(),
  createConversation: vi.fn(),
  config: vi.fn(),
  agents: vi.fn(),
  retryImport: vi.fn(),
  realProject: null as MapDesignProjectFetcher | null,
}));
vi.mock('../../src/map-design/client', async (importOriginal) => {
  const actual = await importOriginal() as {
    getMapDesignProject: MapDesignProjectFetcher;
    retryMapDesignImport: (projectId: string, key: string, signal?: AbortSignal) => Promise<unknown>;
  };
  api.realProject = actual.getMapDesignProject;
  return { ...actual, getMapDesignProject: api.project, retryMapDesignImport: api.retryImport };
});
vi.mock('../../src/api/client', () => ({
  getMapDesignConversation: api.conversation,
  listMapDesignConversations: api.conversations,
  createMapDesignConversation: api.createConversation,
  getMapDesignConfig: api.config,
  getLocalAgents: api.agents,
}));
vi.mock('../../src/map-design/chat/MapDesignChatPane', () => ({
  MapDesignChatPane: ({ projectId, conversationId, cartographyLabel, cartographyHref, runtime, agents = [], collapsed, agentBlocked, agentStatusMessage, readOnly, viewedRevision, readOnlyReason, onExpand, onCreateConversation, onExpandButtonMount, onStartAccepted }: {
    projectId: string; conversationId: string; runtime?: { revision: number; agentId: string; model?: string; reasoning?: string; serviceTier?: string };
    cartographyLabel?: string; cartographyHref?: string;
    agents?: Array<{ id: string; label: string; available?: boolean; mapDesign?: { nativeMapTools: boolean } }>;
    agentBlocked?: boolean; agentStatusMessage?: string | null;
    readOnly?: boolean; viewedRevision?: number; readOnlyReason?: string | null;
    collapsed?: boolean; onExpand?(): void; onCreateConversation?(): void; onExpandButtonMount?(button: HTMLButtonElement | null): void;
    onStartAccepted?(): void;
  }) => {
    const catalogBlocked = Boolean(agents[0] && (agents[0].available === false || agents[0].mapDesign?.nativeMapTools === false));
    const status = agentStatusMessage ?? (catalogBlocked ? 'Map editing unavailable' : null);
    return collapsed
      ? <section data-testid="chat-pane"><button ref={onExpandButtonMount} type="button" aria-label="Expand design conversation" onClick={onExpand}>Expand</button><button type="button" aria-label="New conversation" onClick={onCreateConversation}>New</button></section>
      : <section data-testid="chat-pane" data-runtime-bridge={runtime ? 'present' : 'absent'}>{cartographyLabel ? <a href={cartographyHref}>{cartographyLabel}</a> : null}{projectId}:{conversationId}:{runtime?.agentId ?? agents[0]?.id ?? ''}:{runtime?.model ?? ''}:{runtime?.reasoning ?? ''}:{runtime?.serviceTier ?? ''}
        {status ? <p role="status">{status}</p> : null}
        {readOnlyReason ? <p data-testid="read-only-reason">{readOnlyReason}</p> : null}
        <button type="button" aria-label="Send" disabled={agentBlocked || catalogBlocked || readOnly} data-viewed-revision={viewedRevision}>Send</button>
        <button type="button" onClick={onStartAccepted}>Accepted run</button>
      </section>;
  },
}));
vi.mock('../../src/map-design/MapDesignStudio', () => ({
  MapDesignStudio: ({ projectId, title, view = { kind: 'current' }, onViewChange, onFullscreenChange, inspectorPlacement = 'closed', inspectorWidth = 320,
    layoutRevision, onInspectorOpenChange, onInspectorPinnedChange, onInspectorWidthChange, onDrawerModalChange }: {
      projectId: string; title: string; onFullscreenChange(fullscreen: boolean): void;
      view?: { kind: 'current' } | { kind: 'historical'; revision: number };
      onViewChange?(view: { kind: 'current' } | { kind: 'historical'; revision: number }, options?: { replace?: boolean }): void;
      inspectorPlacement?: string; inspectorWidth?: number; onInspectorOpenChange?(open: boolean): void;
      layoutRevision?: number; onInspectorPinnedChange?(pinned: boolean): void; onInspectorWidthChange?(width: number): void; onDrawerModalChange?(active: boolean): void;
    }) => <section data-testid="studio" data-placement={inspectorPlacement} data-inspector-width={inspectorWidth} data-layout-revision={layoutRevision}
      data-view-kind={view.kind} data-view-revision={view.kind === 'historical' ? view.revision : undefined}>
      <span>{projectId}:{title}:{layoutRevision}</span><section role="region" aria-label="Map canvas">Map</section><button onClick={() => onFullscreenChange(true)}>Fullscreen</button>
      <button onClick={() => onInspectorOpenChange?.(true)}>Open inspector</button>
      <button onClick={() => onInspectorPinnedChange?.(true)}>Dock inspector</button>
      <button onClick={() => onInspectorWidthChange?.(999)}>Grow inspector</button>
      <button onClick={() => onDrawerModalChange?.(true)}>Open drawer modal</button>
      <button onClick={() => onDrawerModalChange?.(false)}>Close drawer modal</button>
      <button onClick={() => onViewChange?.({ kind: 'historical', revision: 2 })}>View revision 2</button>
      <button onClick={() => onViewChange?.({ kind: 'current' })}>Return current version</button>
    </section>,
}));

import { MapDesignWorkspace, parseMapDesignProjectView } from '../../src/map-design/MapDesignWorkspace';
import { I18nProvider } from '../../src/i18n';
interface ProjectAggregate {
  project: { projectId: string; lifecycle: 'importing' | 'ready' | 'failed' };
  conversationId: string | null;
  title: string;
  runtime: { agentId: string; model?: string; reasoning?: string; serviceTier?: string };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  api.project.mockReset();
  api.conversation.mockReset();
  api.conversations.mockReset();
  api.createConversation.mockReset();
  api.config.mockReset();
  api.agents.mockReset();
  api.retryImport.mockReset();
  vi.useRealTimers();
});

const project = (projectId: string, title: string, lifecycle: 'importing' | 'ready' | 'failed' = 'ready'): ProjectAggregate => ({
  project: { projectId, lifecycle },
  conversationId: `conversation-${projectId}`,
  title,
  runtime: { agentId: 'project-agent', model: 'project-model', reasoning: 'project-reasoning', serviceTier: 'project-tier' },
});
const conversation = (projectId: string) => ({ id: `conversation-${projectId}`, projectId, activeRun: null, messages: [] });
const conversationSummary = (projectId: string, conversationId = `conversation-${projectId}`, title = 'Project conversation') => ({
  conversationId,
  projectId,
  title,
  titleIsDefault: title === 'New conversation',
  messageCount: 0,
  createdAt: '2026-08-28T00:00:00.000Z',
  lastActivityAt: '2026-08-28T00:00:00.000Z',
  runState: 'idle' as const,
});
const configured = { config: { agentId: 'claude' } };

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.getBoundingClientRect().width; });
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) { return this.getBoundingClientRect().left; });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const slot = this.getAttribute('data-slot');
    const left = slot === 'resizable-handle' ? 380 : this.id === 'map' ? 388 : 0;
    const width = slot === 'resizable-handle' ? 8 : this.id === 'chat' ? 380 : 1400 - left;
    return { x: left, y: 0, left, top: 0, right: left + width, bottom: 900, width, height: 900, toJSON() {} };
  });
  api.conversations.mockImplementation((projectId: string) => Promise.resolve({ conversations: [conversationSummary(projectId)] }));
  api.agents.mockResolvedValue({ agents: [{
    id: 'project-agent', label: 'Project Agent', available: true, models: [],
    mapDesign: { nativeMapTools: true, publicReasoningSummary: true },
  }] });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('MapDesignWorkspace', () => {
  it('does not synthesize revision zero from project or global runtime configuration', async () => {
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.config.mockResolvedValue({ config: {
      agentId: 'different-global-agent',
      agentModels: { 'project-agent': { model: 'different-global-model' } },
    } });

    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    const chat = await screen.findByTestId('chat-pane');
    expect(chat).toHaveAttribute('data-runtime-bridge', 'absent');
    expect(api.config).not.toHaveBeenCalled();
  });

  it('parses invalid revision parameters as a bounded historical-view error instead of revision zero', () => {
    expect(parseMapDesignProjectView('?conversation=conversation-1&revision=1.5')).toEqual({
      view: { kind: 'current' },
      error: 'invalid-revision',
    });
    expect(parseMapDesignProjectView('?revision=0')).toEqual({
      view: { kind: 'historical', revision: 0 },
      error: null,
    });
  });

  it('preserves the selected conversation while URL-addressing a read-only historical revision', async () => {
    window.history.replaceState(null, '', '?conversation=conversation-1&revision=1');
    api.project.mockResolvedValue(project('map-project-1', 'Transit atlas'));
    api.config.mockResolvedValue(configured);
    api.conversations.mockResolvedValue({ conversations: [conversationSummary('map-project-1', 'conversation-1')] });

    render(<MapDesignWorkspace projectId="map-project-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    const studio = await screen.findByTestId('studio');
    expect(studio).toHaveAttribute('data-view-revision', '1');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('data-viewed-revision', '1');
    expect(screen.getByTestId('read-only-reason')).toHaveTextContent('Return to current version to edit this historical revision.');
  });

  it('disables no-conversation creation fallback in historical mode', async () => {
    window.history.replaceState(null, '', '?revision=1');
    api.project.mockResolvedValue(project('map-project-1', 'Transit atlas'));
    api.config.mockResolvedValue(configured);
    api.conversations.mockResolvedValue({ conversations: [] });

    render(<MapDesignWorkspace projectId="map-project-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'New conversation' })).toBeDisabled();
  });

  it('disables the no-conversation retry fallback in historical mode', async () => {
    window.history.replaceState(null, '', '?revision=1');
    api.project.mockResolvedValue(project('map-project-1', 'Transit atlas'));
    api.config.mockResolvedValue(configured);
    api.conversations.mockRejectedValue(new Error('list unavailable'));

    render(<MapDesignWorkspace projectId="map-project-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Retry' })).toBeDisabled();
  });

  it('updates only the revision query parameter when changing views', async () => {
    window.history.replaceState(null, '', '?conversation=conversation-1');
    api.project.mockResolvedValue(project('map-project-1', 'Transit atlas'));
    api.config.mockResolvedValue(configured);
    api.conversations.mockResolvedValue({ conversations: [conversationSummary('map-project-1', 'conversation-1')] });

    render(<MapDesignWorkspace projectId="map-project-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    await screen.findByTestId('studio');
    fireEvent.click(screen.getByRole('button', { name: 'View revision 2' }));
    expect(window.location.search).toBe('?conversation=conversation-1&revision=2');
    expect(screen.getByTestId('studio')).toHaveAttribute('data-view-revision', '2');

    fireEvent.click(screen.getByRole('button', { name: 'Return current version' }));
    expect(window.location.search).toBe('?conversation=conversation-1');
    expect(screen.getByTestId('studio')).toHaveAttribute('data-view-kind', 'current');
  });

  it('tracks browser popstate changes without replacing the conversation selection', async () => {
    window.history.replaceState(null, '', '?conversation=conversation-1&revision=1');
    api.project.mockResolvedValue(project('map-project-1', 'Transit atlas'));
    api.config.mockResolvedValue(configured);
    api.conversations.mockResolvedValue({ conversations: [conversationSummary('map-project-1', 'conversation-1')] });

    render(<MapDesignWorkspace projectId="map-project-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    await screen.findByTestId('studio');
    window.history.replaceState(null, '', '?conversation=conversation-1&revision=2');
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    await waitFor(() => expect(screen.getByTestId('studio')).toHaveAttribute('data-view-revision', '2'));
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('data-viewed-revision', '2');
  });

  it('blocks an existing project composer when its persisted agent lacks native map tools', async () => {
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.config.mockResolvedValue(configured);
    api.agents.mockResolvedValue({ agents: [{
      id: 'project-agent', label: 'Project Agent', available: true, models: [],
      mapDesign: { nativeMapTools: false, publicReasoningSummary: true, reason: 'native-tools-unavailable' },
    }] });

    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(await screen.findByText('Map editing unavailable')).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('refreshes the visible conversation header after a user message is accepted', async () => {
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.config.mockResolvedValue(configured);
    api.conversations
      .mockResolvedValueOnce({ conversations: [conversationSummary('map-1', 'conversation-map-1', 'New conversation')] })
      .mockResolvedValueOnce({ conversations: [conversationSummary('map-1', 'conversation-map-1', 'Review park colors')] });

    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    await screen.findByTestId('chat-pane');
    expect(screen.getAllByRole('button', { name: 'New conversation' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Accepted run' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Project conversations' })).toHaveTextContent('Review park colors'));
  });

  it('renders a labelled chat resize separator without remounting the studio', async () => {
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);

    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    await screen.findByTestId('studio');
    expect(screen.getByRole('separator', { name: 'Resize design conversation' })).toBeInTheDocument();
  });

  it('keeps the persisted chat preference inline while fullscreen and collapse retain workspace state wiring', async () => {
    window.localStorage.setItem('map-design:workspace:v1:chat-width', '520');
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);

    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    const studio = await screen.findByTestId('studio');
    const workspace = studio.closest<HTMLElement>('[data-chat-collapsed]');
    if (!workspace) throw new Error('Workspace root was not rendered');
    expect(workspace.style.getPropertyValue('--map-chat-preferred-width')).toBe('520px');
    expect(workspace.style.getPropertyValue('--map-chat-width')).toBe('');

    const resize = screen.getByRole('separator', { name: 'Resize design conversation' });
    fireEvent.keyDown(resize, { key: 'ArrowLeft' });
    fireEvent.keyUp(resize, { key: 'ArrowLeft' });
    const expectedWidth = 520 - (1400 - 8) * 0.05;
    expect(Number(window.localStorage.getItem('map-design:workspace:v1:chat-width'))).toBeCloseTo(expectedWidth, 1);
    expect(Number.parseFloat(workspace.style.getPropertyValue('--map-chat-preferred-width'))).toBeCloseTo(expectedWidth, 1);

    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(workspace).toHaveAttribute('data-fullscreen', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse chat' }));
    expect(workspace).toHaveAttribute('data-chat-collapsed', 'true');
  });

  it('switches mobile Chat and Map visibility without unmounting either surface', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 767px)', media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);

    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    const chatPanel = await screen.findByRole('tabpanel', { name: 'Chat' });
    const mapPanel = document.getElementById('map-design-map-surface');
    if (!mapPanel) throw new Error('Map panel was not rendered');
    const chat = screen.getByRole('region', { name: 'Map design agent chat' });
    const map = screen.getByRole('region', { name: 'Map canvas', hidden: true });
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-controls', chatPanel.id);
    expect(screen.getByRole('tab', { name: 'Map' })).toHaveAttribute('aria-controls', mapPanel.id);
    expect(chat).toBeVisible();
    expect(map).not.toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Map' }));
    expect(map).toBeVisible();
    expect(chat).not.toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(chat).toBeVisible();
    expect(screen.getByRole('region', { name: 'Map canvas', hidden: true })).toBe(map);
  });

  it('issues a final layout revision after a grid transition ends', async () => {
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);

    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const computed = vi.spyOn(window, 'getComputedStyle').mockImplementation((...args) => {
      const style = nativeGetComputedStyle(...args);
      return new Proxy(style, {
        get(target, property) {
          if (property === 'transitionProperty') return 'grid-template-columns';
          if (property === 'transitionDuration') return '200ms';
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as CSSStyleDeclaration;
    });
    try {
      render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

      const studio = await screen.findByTestId('studio');
      const workspace = studio.closest<HTMLElement>('[data-chat-collapsed]');
      if (!workspace) throw new Error('Workspace root was not rendered');
      expect(studio).toHaveAttribute('data-layout-revision', '0');
      fireEvent.click(screen.getByRole('button', { name: 'Collapse chat' }));
      expect(studio).toHaveAttribute('data-layout-revision', '1');
      fireEvent.transitionEnd(workspace, { propertyName: 'grid-template-columns' });
      expect(studio).toHaveAttribute('data-layout-revision', '2');
    } finally {
      computed.mockRestore();
    }
  });

  it('does not let an outgoing transition cancel consume a replacement transition', async () => {
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const computed = vi.spyOn(window, 'getComputedStyle').mockImplementation((...args) => {
      const style = nativeGetComputedStyle(...args);
      return new Proxy(style, {
        get(target, property) {
          if (property === 'transitionProperty') return 'grid-template-columns';
          if (property === 'transitionDuration') return '200ms';
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as CSSStyleDeclaration;
    });
    try {
      api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
      api.conversation.mockResolvedValue(conversation('map-1'));
      api.config.mockResolvedValue(configured);
      render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
      const studio = await screen.findByTestId('studio');
      const workspace = studio.closest<HTMLElement>('[data-chat-collapsed]');
      if (!workspace) throw new Error('Workspace root was not rendered');

      fireEvent.click(screen.getByRole('button', { name: 'Collapse chat' }));
      fireEvent.transitionRun(workspace, { propertyName: 'grid-template-columns' });
      fireEvent.click(screen.getByRole('button', { name: 'Expand design conversation' }));
      expect(studio).toHaveAttribute('data-layout-revision', '2');
      fireEvent.transitionCancel(workspace, { propertyName: 'grid-template-columns' });
      expect(studio).toHaveAttribute('data-layout-revision', '2');
      fireEvent.transitionRun(workspace, { propertyName: 'grid-template-columns' });
      fireEvent.transitionEnd(workspace, { propertyName: 'grid-template-columns' });
      expect(studio).toHaveAttribute('data-layout-revision', '3');
    } finally {
      computed.mockRestore();
    }
  });

  it('finalizes a cancelled grid transition that has no successor', async () => {
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const computed = vi.spyOn(window, 'getComputedStyle').mockImplementation((...args) => {
      const style = nativeGetComputedStyle(...args);
      return new Proxy(style, {
        get(target, property) {
          if (property === 'transitionProperty') return 'grid-template-columns';
          if (property === 'transitionDuration') return '200ms';
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as CSSStyleDeclaration;
    });
    try {
      api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
      api.conversation.mockResolvedValue(conversation('map-1'));
      api.config.mockResolvedValue(configured);
      render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
      const studio = await screen.findByTestId('studio');
      const workspace = studio.closest<HTMLElement>('[data-chat-collapsed]');
      if (!workspace) throw new Error('Workspace root was not rendered');

      fireEvent.click(screen.getByRole('button', { name: 'Collapse chat' }));
      fireEvent.transitionRun(workspace, { propertyName: 'grid-template-columns' });
      fireEvent.transitionCancel(workspace, { propertyName: 'grid-template-columns' });
      expect(studio).toHaveAttribute('data-layout-revision', '2');
    } finally {
      computed.mockRestore();
    }
  });

  it.each([
    ['collapse', (workspace: HTMLElement) => fireEvent.click(screen.getByRole('button', { name: 'Collapse chat' })), 1],
    ['expand', (workspace: HTMLElement) => {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse chat' }));
      fireEvent.click(screen.getByRole('button', { name: 'Expand design conversation' }));
    }, 2],
    ['pointer resize completion', (workspace: HTMLElement) => {
      const separator = screen.getByRole('separator', { name: 'Resize design conversation' });
      Object.defineProperty(workspace, 'getBoundingClientRect', { value: () => ({ left: 0 }) });
      fireEvent.pointerDown(separator, { pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1, clientX: 384, clientY: 450 });
      fireEvent.pointerMove(separator, { pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1, clientX: 440, clientY: 450 });
      expect(screen.getByTestId('studio')).toHaveAttribute('data-layout-revision', '0');
      fireEvent.pointerUp(separator, { pointerId: 7, pointerType: 'mouse', button: 0, clientX: 440, clientY: 450 });
    }, 1],
    ['keyboard resize completion', (workspace: HTMLElement) => {
      const separator = screen.getByRole('separator', { name: 'Resize design conversation' });
      fireEvent.keyDown(separator, { key: 'ArrowRight' });
      expect(screen.getByTestId('studio')).toHaveAttribute('data-layout-revision', '1');
      fireEvent.keyUp(separator, { key: 'ArrowRight' });
    }, 1],
    ['inspector open', (workspace: HTMLElement) => fireEvent.click(screen.getByRole('button', { name: 'Open inspector' })), 1],
    ['inspector pin', (workspace: HTMLElement) => {
      fireEvent.click(screen.getByRole('button', { name: 'Open inspector' }));
      fireEvent.click(screen.getByRole('button', { name: 'Dock inspector' }));
    }, 2],
    ['inspector width completion', (workspace: HTMLElement) => {
      fireEvent.click(screen.getByRole('button', { name: 'Grow inspector' }));
      fireEvent.pointerUp(workspace, { pointerId: 8 });
    }, 1],
    ['fullscreen', (workspace: HTMLElement) => fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' })), 1],
  ])('increments the immediate layout revision for %s', async (_name, action, revision) => {
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);
    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    const studio = await screen.findByTestId('studio');
    const workspace = studio.closest<HTMLElement>('[data-chat-collapsed]');
    if (!workspace) throw new Error('Workspace root was not rendered');

    action(workspace);
    expect(studio).toHaveAttribute('data-layout-revision', String(revision));
  });

  it('increments for breakpoint and hidden-to-visible mobile map commits', async () => {
    let compact = false;
    let mobile = false;
    const listeners = new Map<string, Set<() => void>>();
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      get matches() {
        if (query === '(prefers-reduced-motion: reduce)') return false;
        return query === '(max-width: 1199px)' ? compact : mobile;
      }, media: query, onchange: null,
      addEventListener: (_type: string, listener: () => void) => {
        const entries = listeners.get(query) ?? new Set<() => void>();
        entries.add(listener);
        listeners.set(query, entries);
      },
      removeEventListener: (_type: string, listener: () => void) => listeners.get(query)?.delete(listener),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);
    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    const studio = await screen.findByTestId('studio');

    await waitFor(() => expect(listeners.get('(max-width: 1199px)')?.size).toBeGreaterThan(0));
    compact = true;
    act(() => { listeners.get('(max-width: 1199px)')?.forEach((listener) => listener()); });
    expect(studio).toHaveAttribute('data-layout-revision', '1');
    mobile = true;
    act(() => { listeners.get('(max-width: 767px)')?.forEach((listener) => listener()); });
    expect(studio).toHaveAttribute('data-layout-revision', '2');
    const map = screen.getByRole('region', { name: 'Map canvas', hidden: true });
    fireEvent.click(screen.getByRole('tab', { name: 'Map' }));
    expect(studio).toHaveAttribute('data-layout-revision', '3');
    expect(map).toBeVisible();
  });

  it('finalizes the visible map resize when the layout leaves mobile', async () => {
    let compact = true;
    let mobile = true;
    const listeners = new Map<string, Set<() => void>>();
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      get matches() {
        if (query === '(prefers-reduced-motion: reduce)') return false;
        return query === '(max-width: 1199px)' ? compact : mobile;
      }, media: query, onchange: null,
      addEventListener: (_type: string, listener: () => void) => {
        const entries = listeners.get(query) ?? new Set<() => void>();
        entries.add(listener);
        listeners.set(query, entries);
      },
      removeEventListener: (_type: string, listener: () => void) => listeners.get(query)?.delete(listener),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const computed = vi.spyOn(window, 'getComputedStyle').mockImplementation((...args) => {
      const style = nativeGetComputedStyle(...args);
      return new Proxy(style, {
        get(target, property) {
          if (property === 'transitionProperty') return 'grid-template-columns';
          if (property === 'transitionDuration') return '200ms';
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as CSSStyleDeclaration;
    });
    try {
      api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
      api.conversation.mockResolvedValue(conversation('map-1'));
      api.config.mockResolvedValue(configured);
      render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
      const studio = await screen.findByTestId('studio');
      const workspace = studio.closest<HTMLElement>('[data-chat-collapsed]');
      if (!workspace) throw new Error('Workspace root was not rendered');
      await waitFor(() => expect(listeners.get('(max-width: 767px)')?.size).toBeGreaterThan(0));
      const map = screen.getByRole('region', { name: 'Map canvas', hidden: true });
      fireEvent.click(screen.getByRole('tab', { name: 'Map' }));
      expect(studio).toHaveAttribute('data-layout-revision', '1');

      mobile = false;
      act(() => { listeners.get('(max-width: 767px)')?.forEach((listener) => listener()); });
      expect(studio).toHaveAttribute('data-layout-revision', '2');
      fireEvent.transitionEnd(workspace, { propertyName: 'grid-template-columns' });
      expect(studio).toHaveAttribute('data-layout-revision', '3');
      expect(map).toBeVisible();

      mobile = true;
      act(() => { listeners.get('(max-width: 767px)')?.forEach((listener) => listener()); });
      expect(studio).toHaveAttribute('data-layout-revision', '4');
      fireEvent.transitionRun(workspace, { propertyName: 'grid-template-columns' });
      fireEvent.transitionEnd(workspace, { propertyName: 'grid-template-columns' });
      expect(studio).toHaveAttribute('data-layout-revision', '5');
      expect(screen.getByRole('region', { name: 'Map canvas' })).toBe(map);
      expect(map).toBeVisible();
    } finally {
      computed.mockRestore();
    }
  });

  it('isolates the mobile view switcher while the drawer modal is active', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 1199px)' || query === '(max-width: 767px)', media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);
    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    await screen.findByTestId('studio');
    const switcher = screen.getByRole('tablist', { name: 'Map studio modes' });
    fireEvent.click(screen.getByRole('tab', { name: 'Map' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer modal' }));
    expect(switcher).toHaveAttribute('inert');
    expect(switcher).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('tab', { name: 'Chat' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close drawer modal' }));
    expect(switcher).not.toHaveAttribute('inert');
    expect(switcher).not.toHaveAttribute('aria-hidden');
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument();
  });

  it('computes a drawer placement at the tablet breakpoint and keeps persisted width clamped', async () => {
    const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 1199px)', media: query, onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.delete(listener),
      addListener: (listener: (event: MediaQueryListEvent) => void) => mediaListeners.add(listener),
      removeListener: (listener: (event: MediaQueryListEvent) => void) => mediaListeners.delete(listener), dispatchEvent: vi.fn(),
    })));
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);

    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    const studio = await screen.findByTestId('studio');
    fireEvent.click(screen.getByRole('button', { name: 'Open inspector' }));
    expect(studio).toHaveAttribute('data-placement', 'drawer');
    fireEvent.click(screen.getByRole('button', { name: 'Dock inspector' }));
    expect(studio).toHaveAttribute('data-placement', 'drawer');
    fireEvent.click(screen.getByRole('button', { name: 'Grow inspector' }));
    expect(studio).toHaveAttribute('data-inspector-width', '420');
    expect(window.localStorage.getItem('map-design:workspace:v1:inspector-width')).toBe('420');
  });

  it('restores a persisted desktop pin and removes its media-query listener on unmount', async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    window.localStorage.setItem('map-design:workspace:v1:inspector-pinned', 'true');
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false, media: '(max-width: 1199px)', onchange: null,
      addEventListener, removeEventListener, addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);

    const view = render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    await screen.findByTestId('studio');
    fireEvent.click(screen.getByRole('button', { name: 'Open inspector' }));
    expect(screen.getByTestId('studio')).toHaveAttribute('data-placement', 'docked');
    view.unmount();
    expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('isolates chat and the workspace separator while the Studio drawer is active', async () => {
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);
    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    await screen.findByTestId('studio');
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer modal' }));
    const chat = document.querySelector('[aria-label="Map design agent chat"]');
    const separator = document.querySelector('[role="separator"]');
    expect(chat).toHaveAttribute('aria-hidden', 'true');
    expect(chat).toHaveAttribute('inert');
    expect(separator).toHaveAttribute('aria-hidden', 'true');
    expect(separator).toHaveAttribute('inert');
    fireEvent.click(screen.getByRole('button', { name: 'Close drawer modal' }));
    expect(chat).not.toHaveAttribute('inert');
    expect(separator).not.toHaveAttribute('inert');
  });

  it('creates and switches conversations without remounting the studio', async () => {
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.conversations.mockResolvedValue({ conversations: [conversationSummary('map-1')] });
    api.createConversation.mockResolvedValue({
      conversation: conversationSummary('map-1', 'conversation-new', 'New conversation'),
    });
    api.config.mockResolvedValue(configured);

    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    await screen.findByRole('region', { name: 'Map design agent chat' });
    const studio = screen.getByTestId('studio');
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    await screen.findByText('New conversation');
    expect(screen.getByTestId('chat-pane')).toHaveTextContent('map-1:conversation-new');
    expect(screen.getByTestId('studio')).toBe(studio);
  });

  it('offers an accessible recovery action when a reloaded project has no conversations', async () => {
    api.project.mockResolvedValue({ ...project('map-1', 'Transit atlas'), conversationId: null });
    api.conversations.mockResolvedValue({ conversations: [] });
    api.createConversation.mockResolvedValue({
      conversation: conversationSummary('map-1', 'conversation-recovered', 'New conversation'),
    });
    api.config.mockResolvedValue(configured);

    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(await screen.findByText('No conversation is available for this project.')).toHaveAttribute('role', 'status');
    const create = screen.getByRole('button', { name: 'New conversation' });
    fireEvent.click(create);
    await waitFor(() => expect(api.createConversation).toHaveBeenCalledOnce());
    expect(await screen.findByTestId('chat-pane')).toHaveTextContent('map-1:conversation-recovered');
    expect(window.location.search).toContain('conversation=conversation-recovered');
  });

  it('hands focus from the real header collapse control to the collapsed rail without stealing initial collapsed focus', async () => {
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);

    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    const collapse = await screen.findByRole('button', { name: 'Collapse chat' });
    collapse.focus();
    fireEvent.click(collapse);
    const expand = await screen.findByRole('button', { name: 'Expand design conversation' });
    await waitFor(() => expect(expand).toHaveFocus());
  });

  it('does not focus the rail on an initially persisted collapse', async () => {
    window.localStorage.setItem('map-design:workspace:v1:chat-collapsed', 'true');
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();

    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    await screen.findByRole('button', { name: 'Expand design conversation' });
    expect(other).toHaveFocus();
    other.remove();
  });

  it('delegates conversation runtime loading after a deep-link reload and keeps Chat mounted in fullscreen', async () => {
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue({ config: { agentId: 'different-global-agent', agentModels: { 'project-agent': { model: 'global-model', reasoning: 'global-reasoning', serviceTier: 'global-tier' } } } });
    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(await screen.findByTestId('studio')).toHaveTextContent('map-1:Transit atlas');
    expect(screen.getByTestId('chat-pane')).toHaveTextContent('map-1:conversation-map-1:project-agent:::');
    expect(screen.getByTestId('chat-pane')).toHaveAttribute('data-runtime-bridge', 'absent');
    expect(api.config).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(screen.getByTestId('chat-pane')).toBeInTheDocument();
  });

  it('never renders project A while route B is loading and ignores A completion after navigation', async () => {
    const pendingA = deferred<ProjectAggregate>();
    api.project.mockImplementation((id: string) => id === 'a'
      ? pendingA.promise
      : Promise.resolve(project('b', 'Map B')));
    api.conversation.mockImplementation((id: string) => Promise.resolve(conversation(id)));
    api.config.mockResolvedValue(configured);
    const view = render(<MapDesignWorkspace projectId="a" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    view.rerender(<MapDesignWorkspace projectId="b" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.queryByTestId('studio')).not.toBeInTheDocument();
    expect(await screen.findByTestId('studio')).toHaveTextContent('b:Map B');
    pendingA.resolve(project('a', 'Map A'));
    await Promise.resolve();
    expect(screen.getByTestId('studio')).toHaveTextContent('b:Map B');
  });
  it('returns Home for a real parsed project GET NOT_FOUND error', async () => {
    const realProject = api.realProject;
    if (!realProject) throw new Error('MapDesign client was not loaded');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'NOT_FOUND', message: 'missing', retryable: false },
    }), { status: 404 })));
    api.project.mockImplementation(realProject);
    const missing = vi.fn();
    render(<MapDesignWorkspace projectId="gone" onMissingProject={missing} onOpenSettings={vi.fn()} />);
    await waitFor(() => expect(missing).toHaveBeenCalledWith('That map is no longer available.'));
  });

  it.each([
    ['conversation list', () => api.conversations.mockRejectedValueOnce(new Error('failed')), 'The conversations could not be loaded.', true],
    ['network', () => api.project.mockRejectedValueOnce(new TypeError('offline')), 'Unable to load this map workspace.', false],
  ])('keeps the map workspace mounted when a %s request fails', async (_source, reject, error, mapStaysMounted) => {
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);
    reject();
    const missing = vi.fn();
    render(<MapDesignWorkspace projectId="map-1" onMissingProject={missing} onOpenSettings={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(error);
    expect(missing).not.toHaveBeenCalled();
    if (mapStaysMounted) expect(screen.getByTestId('studio')).toBeInTheDocument();
  });

  it('does not request global config while loading a map workspace', async () => {
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.config.mockRejectedValue(new Error('obsolete global config failed'));

    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(await screen.findByTestId('studio')).toBeInTheDocument();
    expect(screen.getByTestId('chat-pane')).toHaveAttribute('data-runtime-bridge', 'absent');
    expect(api.config).not.toHaveBeenCalled();
  });

  it('offers a localized retry after an initial conversation-list failure and preserves the mounted studio', async () => {
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.config.mockResolvedValue(configured);
    api.conversations
      .mockRejectedValueOnce(new Error('daemon unavailable'))
      .mockResolvedValueOnce({ conversations: [conversationSummary('map-1')] });

    render(<I18nProvider initial="de"><MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} /></I18nProvider>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Die Unterhaltungen konnten nicht geladen werden.');
    expect(screen.queryByText('daemon unavailable')).not.toBeInTheDocument();
    const studio = screen.getByTestId('studio');
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    await screen.findByTestId('chat-pane');
    expect(screen.queryByText('daemon unavailable')).not.toBeInTheDocument();
    expect(screen.getByTestId('studio')).toBe(studio);
    expect(screen.getByRole('separator', { name: 'Design-Unterhaltung vergrößern oder verkleinern' })).toBeInTheDocument();
  });

  it('routes localized create Retry to one same-key create operation', async () => {
    const retriedCreate = deferred<{ conversation: ReturnType<typeof conversationSummary> }>();
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.config.mockResolvedValue(configured);
    api.createConversation
      .mockRejectedValueOnce(new Error('private daemon detail'))
      .mockReturnValueOnce(retriedCreate.promise);

    render(<I18nProvider initial="de"><MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} /></I18nProvider>);

    await screen.findByTestId('chat-pane');
    fireEvent.click(screen.getAllByRole('button', { name: 'Neue Unterhaltung' })[0]!);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Die Unterhaltung konnte nicht erstellt werden.'));
    expect(screen.queryByText('private daemon detail')).not.toBeInTheDocument();

    const selectedBeforeRetry = screen.getByTestId('chat-pane').textContent;
    const urlBeforeRetry = window.location.href;
    const retry = screen.getByRole('button', { name: 'Erneut versuchen' });
    fireEvent.click(retry);
    fireEvent.click(retry);

    expect(api.createConversation).toHaveBeenCalledTimes(2);
    expect(api.createConversation.mock.calls[1]?.[1]).toEqual(api.createConversation.mock.calls[0]?.[1]);
    expect(screen.getByTestId('chat-pane')).toHaveTextContent(selectedBeforeRetry ?? '');
    expect(window.location.href).toBe(urlBeforeRetry);

    retriedCreate.resolve({ conversation: conversationSummary('map-1', 'conversation-created', 'Created conversation') });
    await waitFor(() => expect(screen.getByTestId('chat-pane')).toHaveTextContent('conversation-created'));
    expect(api.createConversation).toHaveBeenCalledTimes(2);
    expect(window.location.search).toBe('?conversation=conversation-created');
  });

  it('does not consult global config when the Agent catalog is available', async () => {
    api.project.mockResolvedValue(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue({ config: { agentId: null } });
    const missing = vi.fn();
    render(<MapDesignWorkspace projectId="map-1" onMissingProject={missing} onOpenSettings={vi.fn()} />);
    expect(await screen.findByTestId('chat-pane')).toHaveTextContent('project-agent:::');
    expect(api.config).not.toHaveBeenCalled();
    expect(missing).not.toHaveBeenCalled();
  });

  it('waits for an importing project before mounting Chat and Studio', async () => {
    vi.useFakeTimers();
    api.project.mockResolvedValueOnce(project('map-1', 'Transit atlas', 'importing'))
      .mockResolvedValueOnce(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);
    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('status')).toHaveTextContent('Importing map source');
    expect(screen.queryByTestId('chat-pane')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(screen.getByTestId('studio')).toBeInTheDocument();
  });

  it('removes each resolved import-poll abort listener before the next poll', async () => {
    vi.useFakeTimers();
    const removeListener = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    api.project.mockResolvedValueOnce(project('map-1', 'Transit atlas', 'importing'))
      .mockResolvedValueOnce(project('map-1', 'Transit atlas', 'importing'))
      .mockResolvedValueOnce(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);
    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(removeListener.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(2);
  });

  it('retries a failed import with a fresh key before mounting Chat and Studio', async () => {
    api.project.mockResolvedValueOnce(project('map-1', 'Transit atlas', 'failed'))
      .mockResolvedValueOnce(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);
    api.retryImport.mockResolvedValue(project('map-1', 'Transit atlas', 'importing').project);
    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Map import failed.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry import' }));
    await screen.findByTestId('studio');
    expect(api.retryImport).toHaveBeenCalledWith('map-1', expect.stringMatching(/^map-import-retry:map-1:/), expect.any(AbortSignal));
  });

  it('explains upstream rate limiting safely and permits retrying the same project', async () => {
    const failed = project('map-1', 'Transit atlas', 'failed');
    api.project.mockResolvedValueOnce({ ...failed, project: { ...failed.project,
      failure: { code: 'IMPORT_RATE_LIMITED', message: 'untrusted upstream body must not be displayed' },
    } }).mockResolvedValueOnce(project('map-1', 'Transit atlas'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);
    api.retryImport.mockResolvedValue(project('map-1', 'Transit atlas', 'importing').project);
    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 429');
    expect(screen.getByRole('alert')).not.toHaveTextContent('untrusted upstream body');
    fireEvent.click(screen.getByRole('button', { name: 'Retry import' }));
    await screen.findByTestId('studio');
    expect(api.retryImport).toHaveBeenCalledWith('map-1', expect.any(String), expect.any(AbortSignal));
  });

  it('shows import failure without loading companions when the lifecycle has failed', async () => {
    api.project.mockResolvedValue(project('map-1', 'Transit atlas', 'failed'));
    api.conversation.mockRejectedValue(new Error('companion must not load'));
    api.config.mockRejectedValue(new Error('companion must not load'));

    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Map import failed.');
    expect(api.conversation).not.toHaveBeenCalled();
    expect(api.config).not.toHaveBeenCalled();
  });

  it('aborts a pending import retry when the project changes', async () => {
    const retryPending = deferred<unknown>();
    api.project.mockImplementation((id: string) => Promise.resolve(
      id === 'a' ? project('a', 'Map A', 'failed') : project('b', 'Map B'),
    ));
    api.conversation.mockImplementation((id: string) => Promise.resolve(conversation(id)));
    api.config.mockResolvedValue(configured);
    api.retryImport.mockReturnValue(retryPending.promise);

    const view = render(<MapDesignWorkspace projectId="a" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry import' }));
    const retrySignal = api.retryImport.mock.calls[0]?.[2] as AbortSignal;

    view.rerender(<MapDesignWorkspace projectId="b" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(retrySignal.aborted).toBe(true);
    expect(await screen.findByTestId('studio')).toHaveTextContent('b:Map B');
    await act(async () => {
      retryPending.resolve(undefined);
      await Promise.resolve();
    });
    expect(api.project.mock.calls.filter(([id]) => id === 'b')).toHaveLength(1);
  });

  it('aborts an earlier retry when a new retry begins', async () => {
    const firstRetry = deferred<unknown>();
    api.project.mockResolvedValue(project('map-1', 'Transit atlas', 'failed'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);
    api.retryImport.mockReturnValueOnce(firstRetry.promise).mockResolvedValueOnce(undefined);

    render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry import' }));
    const firstRetrySignal = api.retryImport.mock.calls[0]?.[2] as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'Retry import' }));

    expect(firstRetrySignal.aborted).toBe(true);
  });

  it('aborts a pending import retry when unmounted', async () => {
    const retryPending = deferred<unknown>();
    api.project.mockResolvedValue(project('map-1', 'Transit atlas', 'failed'));
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);
    api.retryImport.mockReturnValue(retryPending.promise);

    const view = render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry import' }));
    const retrySignal = api.retryImport.mock.calls[0]?.[2] as AbortSignal;

    view.unmount();

    expect(retrySignal.aborted).toBe(true);
  });

  it('aborts import polling when unmounted', async () => {
    const pending = deferred<ProjectAggregate>();
    api.project.mockReturnValue(pending.promise);
    api.conversation.mockResolvedValue(conversation('map-1'));
    api.config.mockResolvedValue(configured);
    const view = render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
    view.unmount();
    expect((api.project.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
  });
});

 it('links the highlighted project specification directly to its preview', async () => {
  api.project.mockResolvedValue({ ...project('map-1', 'Transit atlas'), cartography: { id: 'quiet-atlas', name: 'Quiet Atlas', version: '0.4.0', description: '' } });
  render(<MapDesignWorkspace projectId="map-1" onMissingProject={vi.fn()} onOpenSettings={vi.fn()} />);
  expect(await screen.findByRole('link', { name: /Quiet Atlas/ })).toHaveAttribute('href', '/cartographies?cartography=quiet-atlas');
});
