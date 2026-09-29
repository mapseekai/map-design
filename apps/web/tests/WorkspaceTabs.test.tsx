// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { App } from '../src/App';
import { navigate } from '../src/router';
import { TitlebarProject } from '../src/map-design/components/MapDesignTitlebar';
import { useWorkspaceTabDraft } from '../src/map-design/WorkspaceTabs';

function Workspace({ id, title }: { id: string; title: string }) {
  const [draft, setDraft] = useWorkspaceTabDraft('prompt', '');
  const [instance] = useState(() => crypto.randomUUID());
  return <><TitlebarProject title={title} /><label>{id}<input aria-label="Prompt" value={draft} onChange={event => setDraft(event.target.value)} /></label><span data-testid="instance">{instance}</span></>;
}

vi.mock('../src/map-design/MapDesignHome', () => ({ MapDesignHome: () => <p>Map home</p> }));
vi.mock('../src/map-design/MapDesignWorkspace', () => ({ MapDesignWorkspace: ({ projectId }: { projectId: string }) => <Workspace id={projectId} title={`Map ${projectId}`} /> }));
vi.mock('../src/map-design/CartographyEditor', () => ({ CartographyEditor: ({ sessionId }: { sessionId: string }) => <Workspace id={sessionId} title={`Specification ${sessionId}`} /> }));
vi.mock('../src/map-design/MapDesignSettings', () => ({ MapDesignSettings: () => <p>Settings content</p> }));

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(min-width: 768px)', addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('workspace titlebar tabs', () => {
  it('opens map and specification tabs once, preserving drafts and conversation/revision URLs across switches', async () => {
    render(<App />);
    act(() => navigate({ kind: 'project', projectId: 'a' }));
    expect(await screen.findByRole('tab', { name: 'Map a' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Map draft' } });
    window.history.replaceState({}, '', '/projects/a?conversation=chat-a&revision=4');
    const previousInstance = screen.getByTestId('instance').textContent;
    act(() => navigate({ kind: 'cartography-editor', sessionId: 'b' }));
    await screen.findByRole('tab', { name: 'Specification b' });
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Specification draft' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Map a' }));
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(window.location.search).toBe('?conversation=chat-a&revision=4');
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Map draft');
    expect(screen.getByTestId('instance').textContent).not.toBe(previousInstance);
    expect(screen.getByRole('tab', { name: 'Map a' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Map a');
    fireEvent.click(screen.getByRole('tab', { name: 'Specification b' }));
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Specification draft');
  });

  it('keeps tabs on home/settings, closes inactive tabs without navigating, and closes the last tab to home', async () => {
    render(<App />);
    act(() => navigate({ kind: 'project', projectId: 'a' }));
    await screen.findByRole('tab', { name: 'Map a' });
    act(() => navigate({ kind: 'cartography-editor', sessionId: 'b' }));
    await screen.findByRole('tab', { name: 'Specification b' });
    act(() => navigate({ kind: 'settings' }));
    await screen.findByText('Settings content');
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getAllByRole('tab').every(tab => tab.getAttribute('aria-selected') === 'false')).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Specification b' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close: Map a' }));
    expect(window.location.pathname).toBe('/cartographies/edit/b');
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close: Specification b' }));
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(await screen.findByText('Map home')).toBeInTheDocument();
  });

  it('closes the active tab to its neighbor and restores keyboard focus', async () => {
    render(<App />);
    act(() => navigate({ kind: 'project', projectId: 'a' }));
    await screen.findByRole('tab', { name: 'Map a' });
    act(() => navigate({ kind: 'cartography-editor', sessionId: 'b' }));
    await screen.findByRole('tab', { name: 'Specification b' });
    act(() => navigate({ kind: 'project', projectId: 'c' }));
    await screen.findByRole('tab', { name: 'Map c' });
    fireEvent.click(screen.getByRole('tab', { name: 'Specification b' }));
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Specification b' }), { key: 'Delete' });
    expect(window.location.pathname).toBe('/projects/c');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Map c' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Close: Map c' }));
    expect(window.location.pathname).toBe('/projects/a');
  });

  it('opens deep links and restores a closed tab when browser history revisits it', async () => {
    window.history.replaceState({}, '', '/cartographies/edit/b?conversation=chat-b');
    render(<App />);
    expect(await screen.findByRole('tab', { name: 'Specification b' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Close: Specification b' }));
    act(() => { window.history.replaceState({}, '', '/cartographies/edit/b?conversation=chat-b'); window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'Specification b' })).toHaveAttribute('aria-selected', 'true');
  });
});
