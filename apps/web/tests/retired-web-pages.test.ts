// @vitest-environment jsdom
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/map-design/MapDesignHome', () => ({
  MapDesignHome: () => createElement('main', { 'data-testid': 'map-home' }, 'Map home'),
}));
vi.mock('../src/map-design/MapDesignWorkspace', () => ({
  MapDesignWorkspace: ({ projectId }: { projectId: string }) => createElement('main', { 'data-testid': 'map-project' }, `Project ${projectId}`),
}));
vi.mock('../src/map-design/MapDesignSettings', () => ({
  MapDesignSettings: () => createElement('main', { 'data-testid': 'map-settings' }, 'Map settings'),
}));

import { App } from '../src/App';
import { parseRoute } from '../src/router';


const retiredModules = [
  'components/CommunityView.tsx',
  'components/MarketplaceView.tsx',
  'components/PluginsView.tsx',
  'components/HomeView.tsx',
  'components/WorkspaceTabsBar.tsx',
  'components/LibraryPicker.tsx',
  'components/LibrarySection.tsx',
] as const;

vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));

afterEach(() => cleanup());

describe('retired MapDesign web pages', () => {
  it.each(retiredModules)('does not retain %s', (relativePath) => {
    expect(existsSync(resolve(process.cwd(), 'src', relativePath))).toBe(false);
  });

  it.each([
    ['/', { kind: 'home' }],
    ['/settings', { kind: 'settings' }],
    ['/projects/transit%20atlas', { kind: 'project', projectId: 'transit atlas' }],
    ['/workspace', { kind: 'home' }],
    ['/teams/local', { kind: 'home' }],
    ['/library', { kind: 'home' }],
    ['/automations', { kind: 'home' }],
  ] as const)('parses %s into the dedicated MapDesign route table', (pathname, expected) => {
    expect(parseRoute(pathname)).toEqual(expected);
  });

  it.each([
    ['/', 'map-home'],
    ['/settings', 'map-settings'],
    ['/projects/transit', 'map-project'],
    ['/workspace', 'map-home'],
  ] as const)('renders only the mapped dedicated shell for %s', async (pathname, testId) => {
    window.history.replaceState({}, '', pathname);
    render(createElement(App));
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
    expect(screen.queryByText(/workspace switcher|message center|library/i)).not.toBeInTheDocument();
  });
});
