// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loaded = vi.hoisted(() => new Set<string>());
vi.mock('../src/map-design/MapDesignHome', () => {
  loaded.add('home');
  return { MapDesignHome: () => createElement('div', null, 'Map home') };
});
vi.mock('../src/map-design/MapDesignWorkspace', () => {
  loaded.add('project');
  return { MapDesignWorkspace: ({ projectId }: { projectId: string }) => createElement('div', null, `Workspace ${projectId}`) };
});
vi.mock('../src/map-design/MapDesignSettings', () => {
  loaded.add('settings');
  return { MapDesignSettings: ({ section }: { section: string }) => createElement('div', null, `Map settings ${section}`) };
});
vi.mock('../src/map-design/MapDesignProjects', () => {
  loaded.add('projects');
  return { MapDesignProjects: () => createElement('div', null, 'Project list') };
});
vi.mock('../src/map-design/CartographyManager', () => {
  loaded.add('cartographies');
  return { CartographyManager: () => createElement('div', null, 'Cartography library') };
});
vi.mock('../src/map-design/CartographyEditor', () => {
  loaded.add('cartography-editor');
  return { CartographyEditor: ({ sessionId }: { sessionId: string }) => createElement('div', null, `Editor ${sessionId}`) };
});

import { App } from '../src/App';
import { navigate } from '../src/router';

afterEach(cleanup);

describe('App', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  });
  it('loads only the active page while preserving the navigation shell', async () => {
    window.history.replaceState({}, '', '/');
    render(createElement(App));
    expect(await screen.findByText('Map home')).toBeInTheDocument();
    expect([...loaded]).toEqual(['home']);
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(screen.queryByText(/workspace switcher|message center/i)).not.toBeInTheDocument();
  });

  it.each([
    [{ kind: 'settings', section: 'appearance' }, 'Map settings appearance'],
    [{ kind: 'projects' }, 'Project list'],
    [{ kind: 'project', projectId: 'project-1' }, 'Workspace project-1'],
    [{ kind: 'cartographies' }, 'Cartography library'],
    [{ kind: 'cartography-editor', sessionId: 'session-1' }, 'Editor session-1'],
  ] as const)('renders the requested lazy page after navigation to %j', async (route, content) => {
    window.history.replaceState({}, '', '/');
    render(createElement(App));
    await screen.findByText('Map home');

    act(() => navigate(route));

    expect(await screen.findByText(content)).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});
