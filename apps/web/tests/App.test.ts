// @vitest-environment jsdom
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/map-design/MapDesignHome', () => ({ MapDesignHome: () => createElement('div', null, 'Map home') }));
vi.mock('../src/map-design/MapDesignWorkspace', () => ({ MapDesignWorkspace: ({ projectId }: { projectId: string }) => createElement('div', null, `Workspace ${projectId}`) }));
vi.mock('../src/map-design/MapDesignSettings', () => ({ MapDesignSettings: () => createElement('div', null, 'Map settings') }));

import { App } from '../src/App';

describe('App', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  });
  it('renders the MapDesign shell rather than retired generic surfaces', () => {
    window.history.replaceState({}, '', '/');
    render(createElement(App));
    expect(screen.getByText('Map home')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(screen.queryByText(/workspace switcher|message center/i)).not.toBeInTheDocument();
  });
});
