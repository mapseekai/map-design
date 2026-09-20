// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildPath, navigate, parseRoute, useRoute } from '../src/router';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('MapDesign router', () => {
  it('parses and builds the supported routes', () => {
    expect(parseRoute('/')).toEqual({ kind: 'home' });
    expect(parseRoute('/cartographies/edit/edit-1')).toEqual({ kind: 'cartography-editor', sessionId: 'edit-1' });
    expect(buildPath({ kind: 'cartography-editor', sessionId: 'edit-1' })).toBe('/cartographies/edit/edit-1');
    expect(parseRoute('/settings/')).toEqual({ kind: 'settings' });
    expect(parseRoute('/projects/map%201')).toEqual({ kind: 'project', projectId: 'map 1' });
    expect(parseRoute('/projects/%E0%A4%A')).toEqual({ kind: 'home' });
    expect(parseRoute('/unknown')).toEqual({ kind: 'home' });

    expect(buildPath({ kind: 'home' })).toBe('/');
    expect(buildPath({ kind: 'settings' })).toBe('/settings');
    expect(buildPath({ kind: 'project', projectId: 'map 1' })).toBe('/projects/map%201');
  });

  it('updates subscribers after push and replace navigation', () => {
    const committed = vi.fn();
    const view = renderHook(() => useRoute());

    act(() => navigate({ kind: 'project', projectId: 'map-1' }, { onCommit: committed }));
    expect(view.result.current).toEqual({ kind: 'project', projectId: 'map-1' });
    expect(window.location.pathname).toBe('/projects/map-1');
    expect(committed).toHaveBeenCalledOnce();

    act(() => navigate({ kind: 'settings' }, { replace: true }));
    expect(view.result.current).toEqual({ kind: 'settings' });
    expect(window.location.pathname).toBe('/settings');
    view.unmount();
  });

  it('reacts to browser history traversal', () => {
    const view = renderHook(() => useRoute());
    window.history.pushState(null, '', '/projects/map-2');
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(view.result.current).toEqual({ kind: 'project', projectId: 'map-2' });
    view.unmount();
  });
});
