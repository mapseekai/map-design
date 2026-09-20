// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MapDesignShell } from '../src/map-design/MapDesignShell';

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('MapDesignShell sidebar', () => {
  it('reserves the same explicit desktop height for the titlebar and project content', () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(min-width: 768px)', addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    window.history.replaceState({}, '', '/projects/project-1');
    const { container } = render(<MapDesignShell>Workspace</MapDesignShell>);
    const titlebar = container.querySelector('[data-app-titlebar]') as HTMLElement;
    expect(titlebar.style.height).toBe('52px');
    expect(titlebar.parentElement?.style.paddingTop).toBe('52px');
    expect(screen.getByRole('main').style.height).toBe('calc(100dvh - var(--app-titlebar-height))');
    expect(titlebar).toContainElement(screen.getByRole('button', { name: 'Back to home' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to home' }));
    expect(window.location.pathname).toBe('/');
    expect(titlebar).toContainElement(screen.getByRole('button', { name: 'Collapse sidebar' }));
  });

  it('navigates and remembers the collapsed sidebar across mounts', () => {
    const view = render(<MapDesignShell>Content</MapDesignShell>);
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: 'Map projects' }));
    expect(screen.getByRole('button', { name: 'Map projects' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(localStorage.getItem('mapdesign.sidebar.open')).toBe('false');
    view.unmount();
    render(<MapDesignShell>Content</MapDesignShell>);
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('filters navigation and keeps settings immediately after design specifications', () => {
    render(<MapDesignShell>Content</MapDesignShell>);
    const navigation = screen.getByRole('navigation');
    expect([...navigation.querySelectorAll('button')].map(button => button.textContent)).toEqual([
      'Home', 'Map projects', 'Design specifications', 'Settings',
    ]);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'settings' } });
    expect(screen.queryByRole('button', { name: 'Home' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });

  it('keeps the project workspace free of global navigation', () => {
    window.history.replaceState({}, '', '/projects/project-1');
    render(<MapDesignShell>Workspace</MapDesignShell>);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent('Workspace');
  });

  it('opens mobile navigation and closes it after choosing a destination', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<MapDesignShell>Content</MapDesignShell>);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(await screen.findByRole('dialog', { name: 'Primary navigation' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(window.location.pathname).toBe('/settings');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
