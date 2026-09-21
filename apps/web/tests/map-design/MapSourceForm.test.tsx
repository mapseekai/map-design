// @vitest-environment jsdom
import { openSelect, selectValue } from '../helpers/select';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalAgentInfo } from '@mapseekai/contracts';

vi.mock('../../src/map-design/client', async (original) => ({
  ...await original<typeof import('../../src/map-design/client')>(),
  listCartographies: vi.fn(async () => ({ documents: [] })),
}));
const previewHarness = vi.hoisted(() => ({ error: new Map<string, () => void>() }));
vi.mock('../../src/map-design/map/MapLibreCanvas', () => ({
  MapLibreCanvas: ({ style, onMapError }: { style: string; onMapError?: () => void }) => {
    previewHarness.error.set(style, () => onMapError?.());
    return <div data-testid="direct-preview" data-source={style} />;
  },
}));
import { I18nProvider } from '../../src/i18n';
import { MapSourceForm } from '../../src/map-design/components/MapSourceForm';
import { listCartographies } from '../../src/map-design/client';

const SOURCE_URL = 'https://demotiles.maplibre.org/styles/osm-bright-gl-terrain/style.json';
const defaultAgents: LocalAgentInfo[] = [
  { id: 'offline', label: 'Offline agent', available: false, modelCatalogSource: 'fallback', mapDesign: { nativeMapTools: false, publicReasoningSummary: false, reason: 'agent-unavailable' } },
  { id: 'codex', label: 'Codex', available: true, modelCatalogSource: 'fallback', mapDesign: { nativeMapTools: true, publicReasoningSummary: true } },
];
function json(body: unknown) { return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }); }
function renderForm(agents: LocalAgentInfo[] = defaultAgents,
  onCreate = vi.fn().mockResolvedValue({ project: { projectId: 'map-1' }, conversationId: 'conversation-1' })) {
  render(<I18nProvider><MapSourceForm agents={agents} onCreate={onCreate} /></I18nProvider>);
  return onCreate;
}
function fillForm() {
  fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: ' Atlas ' } });
  fireEvent.change(screen.getByLabelText(/public map url/i), { target: { value: SOURCE_URL } });
  fireEvent.change(screen.getByLabelText(/design requirement/i), { target: { value: ' Calm basemap ' } });
  selectValue(screen.getByLabelText(/local agent/i), 'codex');
}
const createButton = () => screen.getByRole('button', { name: /create map/i });
const submit = () => fireEvent.submit(createButton().closest('form')!);
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected source preflight request')));
  vi.mocked(listCartographies).mockResolvedValue({ documents: [] });
});
afterEach(() => {
  cleanup();
  delete (window as typeof window & { __mapDesign__?: unknown }).__mapDesign__;
  previewHarness.error.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MapSourceForm independent preview and creation', () => {
  it('shows CLI models, resets them on runtime switches and submits the selected model', async () => {
    const model = (id: string, label: string, isDefault = false) => ({ id, label, default: isDefault, enabled: true, reasoningOptions: [], serviceTierOptions: [] });
    const create = renderForm([
      { ...defaultAgents[1]!, models: [model('codex-default', 'Codex default', true), model('codex-other', 'Codex other')] },
      { ...defaultAgents[1]!, id: 'oh-my-pi', label: 'Oh My Pi', models: [model('kimi-code/k3-256k', 'Kimi K3', true)] },
    ]);
    fillForm();
    expect(screen.getByLabelText('Models')).toHaveTextContent('Codex default');
    selectValue(screen.getByLabelText('Models'), 'codex-other');
    selectValue(screen.getByLabelText(/local agent/i), 'oh-my-pi');
    expect(screen.getByLabelText('Models')).toHaveTextContent('Kimi K3');
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      runtime: { agentId: 'oh-my-pi', model: 'kimi-code/k3-256k' },
    }), expect.any(AbortSignal)));
  });

  it('previews a URL without a name, brief or agent and never requests preflight', async () => {
    renderForm([]);
    fireEvent.change(screen.getByLabelText(/public map url/i), { target: { value: SOURCE_URL } });
    expect(await screen.findByTestId('direct-preview')).toHaveAttribute('data-source', SOURCE_URL);
    expect(screen.queryByRole('button', { name: /check source/i })).toBeNull();
    expect(createButton()).toBeDisabled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('creates before preview readiness with one strict atomic body', async () => {
    const onCreate = renderForm();
    fillForm();
    expect(createButton()).toBeEnabled();
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    const input = onCreate.mock.calls[0]![0];
    expect(Object.keys(input).sort()).toEqual(['designRequirement', 'idempotencyKey', 'projectId', 'runtime', 'source', 'title']);
    expect(input).toMatchObject({ title: 'Atlas', source: { url: SOURCE_URL }, designRequirement: 'Calm basemap', runtime: { agentId: 'codex' } });
    expect(input.idempotencyKey).toBe(`map-create:${input.projectId}`);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('still creates after a preview error', async () => {
    const onCreate = renderForm();
    fillForm();
    await screen.findByTestId('direct-preview');
    act(() => previewHarness.error.get(SOURCE_URL)!());
    expect(screen.getByRole('alert')).toHaveTextContent('You can still create the project.');
    expect(createButton()).toBeEnabled();
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
  });

  it('submits the current URL without waiting for a replacement preview', async () => {
    const onCreate = renderForm();
    fillForm();
    await screen.findByTestId('direct-preview');
    fireEvent.change(screen.getByLabelText(/public map url/i), { target: { value: 'https://maps.example.com/other.json' } });
    expect(createButton()).toBeEnabled();
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ source: { url: 'https://maps.example.com/other.json' } }), expect.any(AbortSignal)));
  });

  it('validates required fields, URL syntax and agent capabilities on submit', async () => {
    const onCreate = renderForm();
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(/available local agent/i);
    fillForm();
    fireEvent.change(screen.getByLabelText(/public map url/i), { target: { value: 'not-a-map-url' } });
    expect(createButton()).toBeDisabled();
    submit();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid HTTP(S) map URL');
    expect(screen.getByRole('alert')).not.toHaveTextContent('invalid_format');
    fireEvent.change(screen.getByLabelText(/public map url/i), { target: { value: SOURCE_URL } });
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: '  ' } });
    submit();
    expect(screen.getByRole('alert')).toHaveTextContent('Complete the project name');
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('keeps unsupported agents visible but unavailable for map creation', async () => {
    const onCreate = renderForm([...defaultAgents, { id: 'text-only', label: 'Text Agent', available: true, modelCatalogSource: 'fallback', mapDesign: { nativeMapTools: false, publicReasoningSummary: false, reason: 'native-tools-unavailable' } }]);
    fillForm();
    openSelect(screen.getByLabelText(/local agent/i));
    expect(screen.getByRole('option', { name: 'Offline agent' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: 'Text Agent — Map editing unavailable' })).not.toHaveAttribute('aria-disabled', 'true');
    selectValue(screen.getByLabelText(/local agent/i), 'text-only');
    expect(createButton()).toBeDisabled();
    submit();
    expect(screen.getByRole('alert')).toHaveTextContent('Map editing unavailable');
    expect(onCreate).not.toHaveBeenCalled();
    selectValue(screen.getByLabelText(/local agent/i), 'codex');
    expect(createButton()).toBeEnabled();
  });

  it('passes the selected cartography and trusted desktop directory into creation', async () => {
    const document = { id: 'a'.repeat(64), name: 'Quiet Atlas', description: '', version: '0.4.0' };
    vi.mocked(listCartographies).mockResolvedValueOnce({ documents: [document] });
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...document, source: '---\nversion: "0.4.0"\nname: Quiet Atlas\n---' })));
    Object.assign(window, { __mapDesign__: {
      version: 1, client: { type: 'desktop', platform: 'linux' }, appearance: { setTheme: vi.fn() },
      project: { pickWorkingDirectory: vi.fn().mockResolvedValue({ ok: true, path: '/tmp/atlas', token: 'trusted-directory-grant' }) },
      shell: { openExternal: vi.fn() },
    } });
    const onCreate = renderForm();
    openSelect(screen.getByLabelText('Map design system'));
    await screen.findByRole('option', { name: 'Quiet Atlas' });
    selectValue(screen.getByLabelText('Map design system'), document.id);
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /choose working directory/i }));
    await screen.findByText('Working directory selected.');
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ cartographyId: document.id, workingDirectory: { path: '/tmp/atlas', token: 'trusted-directory-grant' } }), expect.any(AbortSignal)));
  });

  it('blocks duplicate submissions and aborts a pending create on unmount', async () => {
    const onCreate = vi.fn(() => new Promise(() => undefined));
    renderForm(defaultAgents, onCreate);
    fillForm();
    const button = createButton();
    const form = button.closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(onCreate).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    const signal = (onCreate.mock.calls[0] as unknown as [unknown, AbortSignal])[1];
    cleanup();
    expect(signal.aborted).toBe(true);
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

  it('preserves an explicit unavailable-Agent label instead of map-editing copy', () => {
    renderForm([
      { id: 'agent-unavailable', label: 'Unavailable Agent', available: true, modelCatalogSource: 'fallback', mapDesign: { nativeMapTools: false, publicReasoningSummary: false, reason: 'agent-unavailable' } },
    ]);

    openSelect(screen.getByLabelText(/local agent/i));
    expect(screen.getByRole('option', { name: 'Unavailable Agent' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /map editing unavailable/i })).not.toBeInTheDocument();
  });
});

it('creates with the selected saved API profile, not merely the shared remote model name', async () => {
  const api: LocalAgentInfo = { id: 'api', label: 'API Model', available: true, modelCatalogSource: 'configured',
    mapDesign: { nativeMapTools: true, publicReasoningSummary: true }, models: [
      { id: 'api-profile:a', label: 'Primary · shared', enabled: true, default: true, reasoningOptions: [], serviceTierOptions: [] },
      { id: 'api-profile:b', label: 'Secondary · shared', enabled: true, default: false, reasoningOptions: [], serviceTierOptions: [] },
    ] };
  const create = renderForm([...defaultAgents, api]); fillForm();
  selectValue(screen.getByLabelText(/local agent/i), 'api');
  selectValue(screen.getByLabelText('Saved API models'), 'api-profile:b');
  fireEvent.click(createButton());
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ runtime: { agentId: 'api', model: 'api-profile:b' } }), expect.any(AbortSignal)));
});

it('does not create with an empty saved API catalog', () => {
  const create = renderForm([...defaultAgents, { id: 'api', label: 'API Model', available: true, modelCatalogSource: 'configured',
    mapDesign: { nativeMapTools: true, publicReasoningSummary: true }, models: [] }]);
  fillForm(); selectValue(screen.getByLabelText(/local agent/i), 'api');
  expect(createButton()).toBeDisabled(); expect(create).not.toHaveBeenCalled();
});


it('does not replace an explicitly selected deleted API profile with another default', async () => {
  const models = [
    { id: 'api-profile:first', label: 'Primary saved model', enabled: true, default: true, reasoningOptions: [], serviceTierOptions: [] },
    { id: 'api-profile:second', label: 'Secondary saved model', enabled: true, default: false, reasoningOptions: [], serviceTierOptions: [] },
  ];
  const api: LocalAgentInfo = { id: 'api', label: 'API Model', available: true, modelCatalogSource: 'configured',
    mapDesign: { nativeMapTools: true, publicReasoningSummary: true }, models };
  const onCreate = vi.fn();
  const rendered = render(<I18nProvider><MapSourceForm agents={[api]} onCreate={onCreate} /></I18nProvider>);
  fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Map' } });
  fireEvent.change(screen.getByLabelText(/public map url/i), { target: { value: SOURCE_URL } });
  fireEvent.change(screen.getByLabelText(/design requirement/i), { target: { value: 'Keep map' } });
  selectValue(screen.getByLabelText(/local agent/i), 'api');
  selectValue(screen.getByLabelText('Saved API models'), 'api-profile:second');
  expect(createButton()).toBeEnabled();
  rendered.rerender(<I18nProvider><MapSourceForm agents={[{ ...api, models: [models[0]!] }]} onCreate={onCreate} /></I18nProvider>);
  expect(createButton()).toBeDisabled();
  expect(screen.getByLabelText('Saved API models')).toHaveTextContent('Select a saved API model');
  submit(); expect(onCreate).not.toHaveBeenCalled();
});
