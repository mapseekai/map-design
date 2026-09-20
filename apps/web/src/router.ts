import { useSyncExternalStore } from 'react';

export type MapDesignRoute =
  | { kind: 'home'; cartographyId?: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'settings' }
  | { kind: 'projects' }
  | { kind: 'cartography-editor'; sessionId: string }
  | { kind: 'cartographies' };

export type Route = MapDesignRoute;

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value) || null;
  } catch {
    return null;
  }
}

export function parseRoute(pathname: string): MapDesignRoute {
  const parts = pathname.replace(/\/+$/u, '').split('/').filter(Boolean);
  if (parts.length === 3 && parts[0] === 'cartographies' && parts[1] === 'edit') {
    const sessionId = decodeSegment(parts[2]!);
    if (sessionId) return { kind: 'cartography-editor', sessionId };
  }
  if (parts.length === 1 && parts[0] === 'cartographies') return { kind: 'cartographies' };
  if (parts.length === 1 && parts[0] === 'projects') return { kind: 'projects' };
  if (parts.length === 0) return { kind: 'home' };
  if (parts.length === 1 && parts[0] === 'settings') return { kind: 'settings' };
  if (parts.length === 2 && parts[0] === 'projects' && parts[1]) {
    const projectId = decodeSegment(parts[1]);
    if (projectId) return { kind: 'project', projectId };
  }
  return { kind: 'home' };
}

export function buildPath(route: MapDesignRoute): string {
  switch (route.kind) {
    case 'home': return route.cartographyId ? `/?cartography=${encodeURIComponent(route.cartographyId)}` : '/';
    case 'projects': return '/projects';
    case 'settings': return '/settings';
    case 'cartographies': return '/cartographies';
    case 'cartography-editor': return `/cartographies/edit/${encodeURIComponent(route.sessionId)}`;
    case 'project': return `/projects/${encodeURIComponent(route.projectId)}`;
  }
}

interface NavigationOptions {
  replace?: boolean;
  onCommit?: () => void;
}

const subscribers = new Set<() => void>();
let listenerInstalled = false;
let cachedPathname: string | null = null;
let cachedRoute: MapDesignRoute | null = null;

function notify(): void {
  cachedPathname = null;
  for (const subscriber of subscribers) subscriber();
}

function onPopstate(): void {
  notify();
}

function install(): void {
  if (listenerInstalled) return;
  window.addEventListener('popstate', onPopstate);
  listenerInstalled = true;
}

function uninstall(): void {
  if (!listenerInstalled || subscribers.size > 0) return;
  window.removeEventListener('popstate', onPopstate);
  listenerInstalled = false;
}

export function navigate(route: MapDesignRoute, options: NavigationOptions = {}): void {
  const path = buildPath(route);
  if (path === window.location.pathname) return;
  if (options.replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  options.onCommit?.();
  notify();
}

function snapshot(): MapDesignRoute {
  const pathname = window.location.pathname;
  if (cachedPathname !== pathname || cachedRoute === null) {
    cachedPathname = pathname;
    cachedRoute = parseRoute(pathname);
  }
  return cachedRoute;
}

function subscribe(onChange: () => void): () => void {
  subscribers.add(onChange);
  install();
  return () => {
    subscribers.delete(onChange);
    uninstall();
  };
}

export function useRoute(): MapDesignRoute {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
