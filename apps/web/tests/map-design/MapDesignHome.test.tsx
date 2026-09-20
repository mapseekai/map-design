import { openSelect, selectValue } from '../helpers/select';
// @vitest-environment jsdom

vi.mock('../../src/map-design/client', async (original) => ({
  ...await original<typeof import('../../src/map-design/client')>(),
  listCartographies: vi.fn(async () => ({ documents: [] })),
}));

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../src/i18n';
import { MapDesignHome } from '../../src/map-design/MapDesignHome';

const agentResponse = {
  agents: [
    {
      id: 'codex', label: 'Codex', available: true, modelCatalogSource: 'live',
      mapDesign: { nativeMapTools: true, publicReasoningSummary: true },
      models: [{
        id: 'gpt-5.6', label: 'GPT-5.6', enabled: true, default: true,
        reasoningOptions: [], serviceTierOptions: [],
      }],
    },
    {
      id: 'missing', label: 'Missing CLI', available: false, modelCatalogSource: 'fallback',
      mapDesign: { nativeMapTools: false, publicReasoningSummary: false, reason: 'agent-unavailable' },
    },
  ],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function project(projectId: string, title: string) {
  return {
    projectId, title, lifecycle: 'failed', sourceKind: 'style', draftRevision: 0,
    committedRevision: null, validationStatus: 'unknown', updatedAt: '2026-08-26T00:00:00.000Z',
  };
}

function renderHome() {
  return render(
    <I18nProvider>
      <MapDesignHome onOpenProject={vi.fn()} />
    </I18nProvider>,
  );
}

describe('MapDesignHome', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      switch (String(input)) {
        case '/api/agents': return Promise.resolve(json(agentResponse));
        case '/api/map-design/projects': return Promise.resolve(json({ projects: [] }));
        default: return Promise.resolve(json({}));
      }
    }) as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('loads only local agents and local map projects without workspace controls', async () => {
    renderHome();

    expect(await screen.findByRole('heading', { name: /MapDesign/i })).toBeVisible();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url))).toEqual([
      '/api/agents',
      '/api/map-design/projects',
    ]);
    openSelect(screen.getByLabelText(/local agent/i));
    expect(screen.getByRole('option', { name: /Missing CLI/i })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByTestId('workspace-switcher')).toBeNull();
    expect(screen.queryByText(/sign in|template|media/i)).toBeNull();
    expect(screen.getByLabelText('Map design system')).toBeInTheDocument();
  });

  it('uses a labelled home section without a duplicate Settings control', async () => {
    renderHome();
    await screen.findByRole('heading', { name: /MapDesign/i });
    expect(screen.getByRole('region', { name: 'Map design home' }).tagName).toBe('SECTION');
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  });

  it('retries and deletes through the canonical local project list', async () => {
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/agents') return Promise.resolve(json(agentResponse));
      if (url === '/api/map-design/projects' && !init?.method) return Promise.resolve(json({
        projects: [{
          projectId: 'failed-map', title: 'Failed map', lifecycle: 'failed', sourceKind: 'style',
          draftRevision: 0, committedRevision: null, validationStatus: 'unknown', updatedAt: '2026-08-26T00:00:00.000Z',
        }],
      }));
      if (url.endsWith('/retry-import')) return Promise.resolve(json({
        projectId: 'failed-map', lifecycle: 'importing', sourceKind: 'style', designSystemId: 'quiet-atlas',
        designSystemDigest: 'a'.repeat(64), draftRevision: 0, committedRevision: null, failure: null,
        createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T01:00:00.000Z',
      }));
      if (url.endsWith('/failed-map') && init?.method === 'DELETE') return Promise.resolve(json({}));
      return Promise.resolve(json({}));
    }) as typeof fetch;
    renderHome();

    expect(await screen.findByText('Failed map')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'More actions: Failed map' }));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(vi.mocked(globalThis.fetch).mock.calls.some(([url]) => String(url).endsWith('/retry-import'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'More actions: Failed map' }));
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /delete/i }));
    await waitFor(() => expect(screen.queryByText('Failed map')).toBeNull());
  });

  it('keeps concurrent project mutation errors isolated in the rendered Home', async () => {
    const alphaRetry = deferred<Response>();
    const betaRetry = deferred<Response>();
    const secondAlphaRetry = deferred<Response>();
    let alphaAttempts = 0;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/agents') return Promise.resolve(json(agentResponse));
      if (url === '/api/map-design/projects' && !init?.method) {
        return Promise.resolve(json({ projects: [project('alpha-map', 'Alpha map'), project('beta-map', 'Beta map')] }));
      }
      if (url.endsWith('/alpha-map/retry-import')) return alphaAttempts++ === 0 ? alphaRetry.promise : secondAlphaRetry.promise;
      if (url.endsWith('/beta-map/retry-import')) return betaRetry.promise;
      return Promise.resolve(json({}));
    }) as typeof fetch;
    renderHome();

    const alphaCard = (await screen.findByText('Alpha map')).closest('li');
    const betaCard = screen.getByText('Beta map').closest('li');
    expect(alphaCard).not.toBeNull();
    expect(betaCard).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More actions: Alpha map' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'More actions: Beta map' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(alphaAttempts).toBe(1));

    alphaRetry.reject(new Error('Alpha import failed'));
    expect(await screen.findByText('Alpha import failed')).toBeVisible();
    expect(within(betaCard!).queryByRole('alert')).toBeNull();
    expect(screen.getByText('Alpha map')).toBeVisible();
    expect(screen.getByText('Beta map')).toBeVisible();

    betaRetry.resolve(json({
      ...project('beta-map', 'Beta map'), lifecycle: 'importing', designSystemId: 'quiet-atlas',
      designSystemDigest: 'a'.repeat(64), failure: null, createdAt: '2026-08-26T00:00:00.000Z',
    }));
    await waitFor(() => expect(within(betaCard!).queryByRole('alert')).toBeNull());
    expect(screen.getByText('Alpha import failed')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'More actions: Alpha map' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(alphaAttempts).toBe(2));
    expect(screen.queryByText('Alpha import failed')).toBeNull();
    expect(screen.getByText('Beta map')).toBeVisible();
  });

  it('shows local load failures and aborts outstanding requests on unmount', async () => {
    let agentSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/agents') {
        agentSignal = init?.signal ?? undefined;
        return Promise.reject(new Error('agent service unavailable'));
      }
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;
    const view = renderHome();

    expect(await screen.findByRole('alert')).toHaveTextContent('agent service unavailable');
    view.unmount();
    expect(agentSignal?.aborted).toBe(true);
  });
});
