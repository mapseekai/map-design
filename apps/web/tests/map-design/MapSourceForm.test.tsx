import { openSelect, selectValue } from '../helpers/select';
// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalAgentInfo } from '@mapseekai/contracts';

vi.mock('../../src/map-design/client', async (original) => ({
  ...await original<typeof import('../../src/map-design/client')>(),
  listCartographies: vi.fn(async () => ({ documents: [] })),
}));

const previewHarness = vi.hoisted(() => ({
  ready: new Map<string, () => void>(),
  error: new Map<string, () => void>(),
}));

vi.mock('../../src/map-design/components/MapSourcePreflight', () => ({
  MapSourcePreflight: ({ result, error, onPreviewReady, onPreviewError }: {
    result: { preview: { previewId: string } } | null;
    error?: string | null;
    onPreviewReady?: (previewId: string) => void;
    onPreviewError?: (previewId: string) => void;
  }) => {
    const previewId = result?.preview.previewId;
    if (previewId) {
      previewHarness.ready.set(previewId, () => onPreviewReady?.(previewId));
      previewHarness.error.set(previewId, () => onPreviewError?.(previewId));
    }
    return <section role="region" aria-label="Preview">
      {previewId ? <button type="button" onClick={() => onPreviewReady?.(previewId)}>Mark preview ready</button> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>;
  },
}));

import { I18nProvider } from '../../src/i18n';
import { MapSourceForm } from '../../src/map-design/components/MapSourceForm';
import { listCartographies } from '../../src/map-design/client';

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function preflightPayload(previewId = 'preview-1') {
  return {
    kind: 'style', requestedHost: 'maps.example.com', finalHost: 'maps.example.com', redirectCount: 0,
    reachability: 'reachable', security: { scheme: 'https', allResolvedAddressesPublic: true, credentialsPresent: false },
    mediaType: 'application/json', byteLength: 1,
    preview: {
      previewId,
      styleUrl: `/api/map-design/source-previews/${previewId}/style`,
      expiresAt: '2026-09-04T03:10:00.000Z',
    },
  };
}

function preflightFetch(previewId = 'preview-1') {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(
    init?.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : json(preflightPayload(previewId)),
  )) as typeof fetch;
}

const defaultAgents: LocalAgentInfo[] = [
  { id: 'offline', label: 'Offline agent', available: false, modelCatalogSource: 'fallback', mapDesign: { nativeMapTools: false, publicReasoningSummary: false, reason: 'agent-unavailable' } },
  { id: 'codex', label: 'Codex', available: true, modelCatalogSource: 'fallback', mapDesign: { nativeMapTools: true, publicReasoningSummary: true } },
];

function renderForm(
  agents: LocalAgentInfo[] = defaultAgents,
  onCreate = vi.fn().mockResolvedValue({ project: { projectId: 'map-1' }, conversationId: 'conversation-1' }),
) {
  render(<I18nProvider><MapSourceForm agents={agents} onCreate={onCreate} /></I18nProvider>);
  return onCreate;
}

afterEach(() => {
  cleanup();
  delete (window as typeof window & { __mapDesign__?: unknown }).__mapDesign__;
  previewHarness.ready.clear();
  previewHarness.error.clear();
  vi.restoreAllMocks();
});

describe('MapSourceForm', () => {
  it('presents invalid URLs as readable guidance instead of schema diagnostics', async () => {
    globalThis.fetch = preflightFetch();
    renderForm();
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Atlas' } });
    fireEvent.change(screen.getByLabelText(/public map url/i), { target: { value: 'not-a-map-url' } });
    fireEvent.change(screen.getByLabelText(/design requirement/i), { target: { value: 'Calm map' } });
    selectValue(screen.getByLabelText(/local agent/i), 'codex');
    fireEvent.click(screen.getByRole('button', { name: /check source/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Verify that the map URL is valid and publicly accessible.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('invalid_format');
    expect(screen.getByRole('button', { name: /create map/i })).toBeDisabled();
  });

  it('passes the chosen saved cartography in the atomic create request', async () => {
    const document = { id: 'a'.repeat(64), name: 'Quiet Atlas', description: '', version: '0.4.0' };
    vi.mocked(listCartographies).mockResolvedValueOnce({ documents: [document] });
    globalThis.fetch = vi.fn((url, init) => Promise.resolve(json(String(url).includes('/cartographies/')
      ? { ...document, source: '---\nversion: "0.4.0"\nname: Quiet Atlas\n---' }
      : preflightPayload()))) as typeof fetch;
    const onCreate = renderForm();
    openSelect(screen.getByLabelText('Map design system'));
    await screen.findByRole('option', { name: 'Quiet Atlas' });
    selectValue(screen.getByLabelText('Map design system'), document.id);
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Atlas' } });
    fireEvent.change(screen.getByLabelText(/public map url/i), { target: { value: 'https://maps.example.com/style.json' } });
    fireEvent.change(screen.getByLabelText(/design requirement/i), { target: { value: 'Calm basemap' } });
    selectValue(screen.getByLabelText(/local agent/i), 'codex');
    fireEvent.click(screen.getByRole('button', { name: /check source/i }));
    fireEvent.click(await screen.findByRole('button', { name: /mark preview ready/i }));
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ cartographyId: document.id }), expect.any(AbortSignal)));
  });

  it('requires a loaded map preview and posts one strict atomic create body', async () => {
    globalThis.fetch = preflightFetch();
    const onCreate = renderForm();

    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Atlas' } });
    fireEvent.change(screen.getByLabelText(/public map url/i), { target: { value: 'https://maps.example.com/style.json' } });
    fireEvent.change(screen.getByLabelText(/design requirement/i), { target: { value: 'Calm blue basemap' } });
    selectValue(screen.getByLabelText(/local agent/i), 'codex');
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /check source/i }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/map-design/source-preflight', expect.any(Object)));
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /mark preview ready/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /create/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const input = onCreate.mock.calls[0]?.[0];
    expect(input).toBeDefined();
    expect(Object.keys(input!).sort()).toEqual(['designRequirement', 'idempotencyKey', 'projectId', 'runtime', 'source', 'title']);
    expect(input).toMatchObject({ title: 'Atlas', source: { url: 'https://maps.example.com/style.json' }, designRequirement: 'Calm blue basemap', runtime: { agentId: 'codex' } });
    expect(input!.idempotencyKey).toBe(`map-create:${input!.projectId}`);
  });

  it('maps a trusted desktop directory grant into the atomic create request', async () => {
    globalThis.fetch = preflightFetch();
    const bridge = {
      version: 1,
      client: { type: 'desktop', platform: 'linux' },
      appearance: { setTheme: vi.fn() },
      project: { pickWorkingDirectory: vi.fn().mockResolvedValue({ ok: true, path: '/tmp/atlas', token: 'trusted-token' }) },
      shell: { openExternal: vi.fn() },
    };
    Object.assign(window, { __mapDesign__: bridge });
    const onCreate = renderForm();

    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Atlas' } });
    fireEvent.change(screen.getByLabelText(/public map url/i), { target: { value: 'https://maps.example.com/style.json' } });
    fireEvent.change(screen.getByLabelText(/design requirement/i), { target: { value: 'Calm blue basemap' } });
    selectValue(screen.getByLabelText(/local agent/i), 'codex');
    fireEvent.click(screen.getByRole('button', { name: /choose working directory/i }));
    await waitFor(() => expect(bridge.project.pickWorkingDirectory).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /check source/i }));
    await screen.findByRole('button', { name: /mark preview ready/i });
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /mark preview ready/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /create/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      workingDirectory: { path: '/tmp/atlas', token: 'trusted-token' },
    });
  });

  it('keeps a selected directory and no alert when the next desktop picker is cancelled', async () => {
    const pickWorkingDirectory = vi.fn()
      .mockResolvedValueOnce({ ok: true, path: '/tmp/atlas', token: 'trusted-token' })
      .mockResolvedValueOnce({ ok: false, cancelled: true });
    Object.assign(window, {
      __mapDesign__: {
        version: 1, client: { type: 'desktop', platform: 'linux' },
        appearance: { setTheme: vi.fn() }, project: { pickWorkingDirectory }, shell: { openExternal: vi.fn() },
      },
    });
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: /choose working directory/i }));
    await screen.findByRole('status');
    fireEvent.click(screen.getByRole('button', { name: /choose working directory/i }));
    await waitFor(() => expect(pickWorkingDirectory).toHaveBeenCalledTimes(2));

    expect(screen.getByRole('status')).toHaveTextContent(/working directory selected/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a safe alert when the desktop picker fails', async () => {
    Object.assign(window, {
      __mapDesign__: {
        version: 1, client: { type: 'desktop', platform: 'linux' },
        appearance: { setTheme: vi.fn() },
        project: { pickWorkingDirectory: vi.fn().mockResolvedValue({ ok: false, message: 'internal path disclosure' }) },
        shell: { openExternal: vi.fn() },
      },
    });
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: /choose working directory/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to choose a working directory.');
    expect(screen.queryByText('internal path disclosure')).not.toBeInTheDocument();
  });

  it('keeps unavailable agents unselectable and explains the gate', async () => {
    renderForm();
    openSelect(screen.getByLabelText(/local agent/i));
    expect(screen.getByRole('option', { name: 'Offline agent' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /check source/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/available local agent/i);
  });

  it('preserves an explicit unavailable-Agent label instead of map-editing copy', () => {
    renderForm([
      { id: 'agent-unavailable', label: 'Unavailable Agent', available: true, modelCatalogSource: 'fallback', mapDesign: { nativeMapTools: false, publicReasoningSummary: false, reason: 'agent-unavailable' } },
    ]);

    openSelect(screen.getByLabelText(/local agent/i));
    expect(screen.getByRole('option', { name: 'Unavailable Agent' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /map editing unavailable/i })).not.toBeInTheDocument();
  });

  it('keeps unsupported Agents visible but blocks map creation until a compatible Agent is selected', async () => {
    globalThis.fetch = preflightFetch();
    const onCreate = renderForm([
      { id: 'codex', label: 'Codex', available: true, modelCatalogSource: 'fallback', mapDesign: { nativeMapTools: true, publicReasoningSummary: true } },
      { id: 'text-only', label: 'Text Agent', available: true, modelCatalogSource: 'fallback', mapDesign: { nativeMapTools: false, publicReasoningSummary: false, reason: 'native-tools-unavailable' } },
    ]);

    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Atlas' } });
    fireEvent.change(screen.getByLabelText(/public map url/i), { target: { value: 'https://maps.example.com/style.json' } });
    fireEvent.change(screen.getByLabelText(/design requirement/i), { target: { value: 'Calm blue basemap' } });
    selectValue(screen.getByLabelText(/local agent/i), 'codex');
    fireEvent.click(screen.getByRole('button', { name: /check source/i }));
    await screen.findByRole('button', { name: /mark preview ready/i });
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /mark preview ready/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /create/i })).toBeEnabled());

    openSelect(screen.getByLabelText(/local agent/i));
    expect(screen.getByRole('option', { name: 'Text Agent — Map editing unavailable' })).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: 'Codex — Public reasoning summaries available' })).toBeInTheDocument();
    selectValue(screen.getByLabelText(/local agent/i), 'text-only');
    expect(screen.getByText('Map editing unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /check source/i }));
    expect(screen.getByRole('alert')).toHaveTextContent('Map editing unavailable');
    fireEvent.submit(screen.getByRole('button', { name: /create/i }).closest('form')!);
    expect(onCreate).not.toHaveBeenCalled();

    selectValue(screen.getByLabelText(/local agent/i), 'codex');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create/i })).toBeEnabled();
  });

  it('releases a replaced preview and ignores its stale ready callback', async () => {
    let preflightCount = 0;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(
      init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json(preflightPayload(`preview-${++preflightCount}`)),
    )) as typeof fetch;
    globalThis.fetch = fetcher;
    renderForm();

    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Atlas' } });
    fireEvent.change(screen.getByLabelText(/public map url/i), { target: { value: 'https://maps.example.com/style.json' } });
    fireEvent.change(screen.getByLabelText(/design requirement/i), { target: { value: 'Calm blue basemap' } });
    selectValue(screen.getByLabelText(/local agent/i), 'codex');
    fireEvent.click(screen.getByRole('button', { name: /check source/i }));
    await waitFor(() => expect(previewHarness.ready.has('preview-1')).toBe(true));
    const staleReady = previewHarness.ready.get('preview-1')!;
    act(() => staleReady());
    expect(screen.getByRole('button', { name: /create/i })).toBeEnabled();

    fireEvent.change(screen.getByLabelText(/public map url/i), { target: { value: 'https://maps.example.com/other.json' } });
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      '/api/map-design/source-previews/preview-1',
      expect.objectContaining({ method: 'DELETE' }),
    ));

    fireEvent.click(screen.getByRole('button', { name: /check source/i }));
    await waitFor(() => expect(previewHarness.ready.has('preview-2')).toBe(true));
    act(() => staleReady());
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
    act(() => previewHarness.ready.get('preview-2')!());
    expect(screen.getByRole('button', { name: /create/i })).toBeEnabled();
  });

  it('keeps creation disabled when the current map preview reports an error', async () => {
    globalThis.fetch = preflightFetch('preview-error');
    renderForm();

    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Atlas' } });
    fireEvent.change(screen.getByLabelText(/public map url/i), { target: { value: 'https://maps.example.com/style.json' } });
    fireEvent.change(screen.getByLabelText(/design requirement/i), { target: { value: 'Calm blue basemap' } });
    selectValue(screen.getByLabelText(/local agent/i), 'codex');
    fireEvent.click(screen.getByRole('button', { name: /check source/i }));
    await waitFor(() => expect(previewHarness.error.has('preview-error')).toBe(true));

    act(() => previewHarness.error.get('preview-error')!());

    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/could not load map studio/i);
  });
});
