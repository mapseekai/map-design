import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { BookOpen, Folder, X } from 'lucide-react';
import { Button } from '@mapseekai/components';
import { Tabs, TabsList, TabsTrigger } from '@mapseekai/components/ui/tabs';
import { getLocaleDirection, useI18n } from '../i18n';
import { navigationCopy } from '../i18n/locales/navigation';
import { workspaceTabsCopy } from '../i18n/locales/workspace-tabs';
import { buildPath, navigate, parseRoute, subscribeBeforeNavigation, type MapDesignRoute } from '../router';

type WorkspaceRoute = Extract<MapDesignRoute, { kind: 'project' | 'cartography-editor' }>;
interface WorkspaceTab {
  id: string;
  route: WorkspaceRoute;
  title: string;
  search: string;
  hash: string;
  drafts: Map<string, unknown>;
}

function workspaceRoute(route: MapDesignRoute): route is WorkspaceRoute {
  return route.kind === 'project' || route.kind === 'cartography-editor';
}

const WorkspaceTabsContext = createContext<{
  tabs: WorkspaceTab[];
  active: WorkspaceTab | undefined;
  close(id: string): void;
  rename(id: string, title: string): void;
} | null>(null);

export function WorkspaceTabsProvider({ route, children }: { route: MapDesignRoute; children: ReactNode }) {
  const [storedTabs, setTabs] = useState<WorkspaceTab[]>([]);
  const id = workspaceRoute(route) ? buildPath(route) : null;
  const opened = useMemo<WorkspaceTab | null>(() => workspaceRoute(route)
    ? { id: buildPath(route), route, title: '', search: window.location.search, hash: window.location.hash, drafts: new Map() }
    : null, [route]);
  const tabs = opened && !storedTabs.some(tab => tab.id === id) ? [...storedTabs, opened] : storedTabs;
  const active = tabs.find(tab => tab.id === id);
  useLayoutEffect(() => {
    if (opened) setTabs(current => current.some(tab => tab.id === opened.id) ? current : [...current, opened]);
  }, [opened]);

  useEffect(() => subscribeBeforeNavigation(() => {
    const outgoingId = buildPath(parseRoute(window.location.pathname));
    const { search, hash } = window.location;
    setTabs(current => current.some(tab => tab.id === outgoingId && (tab.search !== search || tab.hash !== hash))
      ? current.map(tab => tab.id === outgoingId ? { ...tab, search, hash } : tab) : current);
  }), []);

  const rename = useCallback((tabId: string, title: string) => {
    setTabs(current => current.some(tab => tab.id === tabId && tab.title !== title)
      ? current.map(tab => tab.id === tabId ? { ...tab, title } : tab) : current);
  }, []);

  function close(tabId: string) {
    const index = tabs.findIndex(tab => tab.id === tabId);
    if (tabId === id) {
      const next = tabs[index + 1] ?? tabs[index - 1];
      if (next) navigate(next.route, { search: next.search, hash: next.hash });
      else navigate({ kind: 'home' });
    }
    setTabs(current => current.filter(tab => tab.id !== tabId));
  }

  return <WorkspaceTabsContext.Provider value={{ tabs, active, close, rename }}>{children}</WorkspaceTabsContext.Provider>;
}

export function useWorkspaceTabTitle(title: string) {
  const context = useContext(WorkspaceTabsContext);
  const id = context?.active?.id;
  const rename = context?.rename;
  useEffect(() => { if (id && rename) rename(id, title); }, [id, rename, title]);
  return context !== null;
}

// Keep unsent text in the open tab while inactive workspaces release their maps and subscriptions.
export function useWorkspaceTabDraft<T>(key: string, initial: T | (() => T)) {
  const cache = useContext(WorkspaceTabsContext)?.active?.drafts;
  const [value, setValue] = useState<T>(() => cache?.has(key) ? cache.get(key) as T : typeof initial === 'function' ? (initial as () => T)() : initial);
  useLayoutEffect(() => { cache?.set(key, value); }, [cache, key, value]);
  return [value, setValue] as const;
}

export function WorkspaceTabs() {
  const context = useContext(WorkspaceTabsContext);
  const { locale, t } = useI18n();
  const list = useRef<HTMLDivElement>(null);
  const activeId = context?.active?.id;
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);
  if (!context || !context.tabs.length) return null;
  const { tabs, active, close } = context;
  function closeAndFocus(id: string) {
    const index = tabs.findIndex(tab => tab.id === id);
    const next = active?.id === id ? tabs[index + 1] ?? tabs[index - 1] : active ?? tabs[index + 1] ?? tabs[index - 1];
    close(id);
    requestAnimationFrame(() => {
      if (next) document.getElementById(`workspace-tab-${next.id}`)?.focus();
      else document.querySelector<HTMLElement>('[data-app-titlebar] button')?.focus();
    });
  }
  return <Tabs value={active?.id ?? null} dir={getLocaleDirection(locale)} spacing="none"
    onValueChange={value => { const tab = tabs.find(item => item.id === value); if (tab) navigate(tab.route, { search: tab.search, hash: tab.hash }); }}>
    <div ref={list} className="min-w-0 overflow-x-auto" style={{ WebkitAppRegion: 'no-drag', scrollbarWidth: 'none' } as CSSProperties}>
      <TabsList variant="workspace" aria-label={workspaceTabsCopy[locale].label}>
        {tabs.map(tab => {
          const title = tab.title || navigationCopy[locale][tab.route.kind === 'project' ? 'projects' : 'cartographies'];
          const Icon = tab.route.kind === 'project' ? Folder : BookOpen;
          const closeLabel = `${t('common.close')}: ${title}`;
          return <div key={tab.id} className="relative shrink-0" role="presentation">
            <TabsTrigger value={tab.id} id={`workspace-tab-${tab.id}`} title={title}
              aria-controls={active?.id === tab.id ? 'workspace-panel' : undefined}
              onKeyDown={event => { if (event.key === 'Delete') { event.preventDefault(); closeAndFocus(tab.id); } }}>
              <Icon aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{title}</span>
            </TabsTrigger>
            <div className="absolute end-1 top-1/2 flex -translate-y-1/2">
              <Button variant="ghost" size="icon-xs" aria-label={closeLabel} title={closeLabel} onClick={() => closeAndFocus(tab.id)}><X aria-hidden="true" /></Button>
            </div>
          </div>;
        })}
      </TabsList>
    </div>
  </Tabs>;
}
