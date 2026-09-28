// @vitest-environment jsdom
import { selectValue } from '../helpers/select';
import type { LocalAgentInfo, MapDesignAppConfig } from '@mapseekai/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ agents: vi.fn(), config: vi.fn() }));
vi.mock('../../src/api/client', () => ({ getLocalAgents: api.agents, getMapDesignConfig: api.config }));
import { I18nProvider } from '../../src/i18n';
import { MapDesignSettings } from '../../src/map-design/MapDesignSettings';

const agents: LocalAgentInfo[] = [{ id: 'oh-my-pi', label: 'Oh My Pi', version: '18.1', available: true,
  mapDesign: { nativeMapTools: true, publicReasoningSummary: true }, modelCatalogSource: 'live', models: [
    { id: 'default', label: 'Default', enabled: true, default: true, reasoningOptions: [], serviceTierOptions: [] },
    { id: 'kimi-code/k3', label: 'Kimi K3', enabled: true, default: false, reasoningOptions: [], serviceTierOptions: [] },
  ] }, { id: 'missing', label: 'Missing runtime', available: false, modelCatalogSource: 'fallback', mapDesign: { nativeMapTools: false, publicReasoningSummary: false } }];
let config: MapDesignAppConfig;
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  config = { agentId: 'oh-my-pi', agentCliEnv: { 'oh-my-pi': { TOKEN: '[REDACTED]' } }, byokProviders: { default: { protocol: 'openai', apiKey: '[REDACTED]', model: 'configured-model' } } };
  api.agents.mockResolvedValue({ agents }); api.config.mockImplementation(async () => ({ config }));
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const patch = JSON.parse(String(init?.body ?? '{}'));
    config = { ...config, ...patch, runtimePreferences: { ...config.runtimePreferences, ...patch.runtimePreferences } };
    return new Response(JSON.stringify({ config }), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as typeof window & { __mapDesign__?: unknown }).__mapDesign__; });

it('separates model settings from appearance and retains unsaved model edits across sections', async () => {
  const view = render(<I18nProvider initial="en"><MapDesignSettings /></I18nProvider>);
  const input = await screen.findByRole('textbox', { name: 'Custom instructions' });
  fireEvent.change(input, { target: { value: 'Keep this draft' } });
  expect(screen.queryByRole('combobox', { name: 'Language' })).not.toBeInTheDocument();
  view.rerender(<I18nProvider initial="en"><MapDesignSettings section="appearance" /></I18nProvider>);
  expect(screen.getByRole('combobox', { name: 'Language' })).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'Appearance' })).toBeVisible();
  expect(screen.queryByRole('tab', { name: 'Local runtimes' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();
  view.rerender(<I18nProvider initial="en"><MapDesignSettings section="models" /></I18nProvider>);
  expect(screen.getByRole('textbox', { name: 'Custom instructions' })).toHaveValue('Keep this draft');
});

it('uses local configuration without displaying key or endpoint fields and separates online API in a tab', async () => {
  render(<I18nProvider initial="en"><MapDesignSettings /></I18nProvider>);
  expect(await screen.findByRole('tab', { name: 'Local runtimes' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('region', { name: 'Settings' })).toHaveClass('max-w-7xl', 'px-6', 'md:px-10');
  expect(screen.getByText('Kimi K3')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Test connection: kimi-code/k3' }).parentElement?.parentElement).toHaveStyle({ paddingBlockEnd: '1rem' });
  expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  expect(screen.queryByText('Missing runtime')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Model providers' }));
  expect(screen.getByRole('button', { name: 'Add model' })).toBeVisible();
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
});

it('saves model and runtime switches without sending local credentials or changing API settings', async () => {
  render(<MapDesignSettings />);
  fireEvent.click(await screen.findByRole('switch', { name: 'Enabled: kimi-code/k3' }));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Enabled: kimi-code/k3' })).not.toBeChecked());
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({ runtimePreferences: { 'oh-my-pi': { disabledModels: ['kimi-code/k3'] } } });
  fireEvent.click(screen.getByRole('switch', { name: 'Enabled: Oh My Pi' }));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Enabled: Oh My Pi' })).not.toBeChecked());
  expect(config.runtimePreferences?.['oh-my-pi']).toEqual({ enabled: false, disabledModels: ['kimi-code/k3'] });
  expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain('[REDACTED]');
});

it('tests the chosen local model and displays the server result', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ status: 'passed', testedAt: new Date().toISOString(), latencyMs: 42 })));
  render(<MapDesignSettings />);
  fireEvent.click(await screen.findByRole('button', { name: 'Test connection: kimi-code/k3' }));
  expect(await screen.findByText('Connection verified · 42 ms')).toBeVisible();
  expect(fetch).toHaveBeenCalledWith('/api/agents/oh-my-pi/test', expect.objectContaining({ method: 'POST', body: JSON.stringify({ model: 'kimi-code/k3' }) }));
  fireEvent.click(screen.getByRole('tab', { name: 'Model providers' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Local runtimes' }));
  expect(screen.getByText('Connection verified · 42 ms')).toBeVisible();
});

it('keeps switches unchanged when persistence fails', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 500 }));
  render(<MapDesignSettings />);
  fireEvent.click(await screen.findByRole('switch', { name: 'Enabled: Oh My Pi' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.getByRole('switch', { name: 'Enabled: Oh My Pi' })).toBeChecked();
});

it('refreshes installed runtimes and replaces stale model metadata', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ agents: [{ ...agents[0], models: [] }] })));
  render(<MapDesignSettings />);
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh local runtimes' }));
  await waitFor(() => expect(screen.queryByText('Kimi K3')).not.toBeInTheDocument());
  expect(fetch).toHaveBeenCalledWith('/api/agents/refresh', expect.objectContaining({ method: 'POST' }));
});

it('localizes runtime management and saves only changed general settings', async () => {
  render(<I18nProvider initial="zh-CN"><MapDesignSettings /></I18nProvider>);
  expect(await screen.findByRole('tab', { name: '本地运行时' })).toBeVisible();
  expect(screen.getByRole('tab', { name: '模型提供商' })).toBeVisible();
  fireEvent.change(screen.getByLabelText('自定义指令'), { target: { value: '测试说明' } });
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({ customInstructions: '测试说明' });
});

it('localizes loading and load errors', async () => {
  let reject!: () => void;
  api.config.mockReturnValue(new Promise((_resolve, fail) => { reject = () => fail(new Error('unavailable')); }));
  render(<I18nProvider initial="zh-CN"><MapDesignSettings /></I18nProvider>);
  expect(screen.getByRole('status')).toHaveTextContent('正在加载设置…');
  await act(async () => reject());
  expect(screen.getByRole('alert')).toHaveTextContent('无法加载设置。');
});

it('saves API budgets from the online tab without sending stored secrets', async () => {
  render(<MapDesignSettings />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Model providers' }));
  fireEvent.change(screen.getByLabelText(/Maximum model steps/), { target: { value: '64' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({ apiExecution: { maxSteps: 64 } });
});

it('restores automatic output budgeting when an explicit limit is cleared', async () => {
  config.apiExecution = { maxOutputTokens: 16384, maxSteps: 64 };
  render(<MapDesignSettings />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Model providers' }));
  const output = screen.getByLabelText(/Output tokens per call/);
  expect(output).toHaveValue(16384);
  fireEvent.change(output, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({ apiExecution: { maxSteps: 64 } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
  it('persists the appearance preference without a desktop bridge', async () => {
    localStorage.setItem('map-design.appearance', 'system');
    render(<I18nProvider initial="en"><MapDesignSettings section="appearance" /></I18nProvider>);
    await screen.findByLabelText('Language');
    selectValue(screen.getByLabelText('Language'), 'zh-CN');
    expect(localStorage.getItem('map-design:locale')).toBe('zh-CN');
    expect(localStorage.getItem('map-design.language')).toBeNull();
    expect(screen.getByLabelText('语言')).toHaveTextContent('简体中文');
    selectValue(screen.getByLabelText('外观'), 'light');
    expect(localStorage.getItem('map-design.appearance')).toBe('light');
    expect(screen.queryByText(/Notifications|Integrations|Workspace/i)).not.toBeInTheDocument();
  });

  it('forwards an appearance preference to the version-one desktop bridge', async () => {
    localStorage.setItem('map-design.appearance', 'system');
    const setTheme = vi.fn();
    Object.assign(window, {
      __mapDesign__: {
        version: 1,
        client: { type: 'desktop', platform: 'linux' },
        appearance: { setTheme },
        project: { pickWorkingDirectory: vi.fn() },
        shell: { openExternal: vi.fn() },
      },
    });
    render(<MapDesignSettings section="appearance" />);
    await screen.findByLabelText('Appearance');
    selectValue(screen.getByLabelText('Appearance'), 'light');

    expect(setTheme).toHaveBeenCalledWith('light');
  });


it('saves response format in the named model editor without resending a stored key', async () => {
  api.agents.mockResolvedValueOnce({ agents: [{ id: 'api', label: 'API Model', available: true, mapDesign: { nativeMapTools: true }, models: [] }] });
  api.config.mockResolvedValueOnce({ config: { agentId: 'api', byokProviders: { default: { protocol: 'openai', apiKey: '[REDACTED]', model: 'configured-model' } } } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ activeProfileId: 'default', profiles: [
    { id: 'default', name: 'configured-model', protocol: 'openai', apiFormat: 'responses', baseUrl: '', model: 'configured-model', hasApiKey: true, requiresApiKey: true }
  ] }), { status: 200 })));
  render(<MapDesignSettings />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Model providers' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  selectValue(screen.getByLabelText('Response format'), 'responses');
  fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
  expect(await screen.findByText('configured-model：Model saved')).toBeVisible();
  const call = vi.mocked(fetch).mock.calls[0]!;
  expect(call[0]).toBe('/api/map-design/api-profiles/default');
  expect(JSON.parse(String(call[1]?.body))).toMatchObject({ protocol: 'openai', apiFormat: 'responses', model: 'configured-model' });
  expect(JSON.parse(String(call[1]?.body))).not.toHaveProperty('apiKey');
});

it('never reports settings saved while an API profile draft is still unsaved', async () => {
  api.agents.mockResolvedValueOnce({ agents: [{ id: 'api', label: 'API Model', available: true, mapDesign: { nativeMapTools: true }, models: [] }] });
  api.config.mockResolvedValueOnce({ config: { agentId: 'api' } });
  vi.stubGlobal('fetch', vi.fn());
  render(<MapDesignSettings />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Model providers' }));
  fireEvent.change(await screen.findByLabelText('Configuration name'), { target: { value: 'Not saved yet' } });
  expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  expect(screen.queryByText('Settings saved')).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});


it('replaces the startup placeholder with discovered Oh My Pi models automatically', async () => {
  api.agents.mockResolvedValue({ agents: [{ ...agents[0], modelCatalogSource: 'fallback', models: [agents[0]!.models![0]] }] });
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ agents })));
  render(<MapDesignSettings />);
  expect(await screen.findByText('Kimi K3')).toBeVisible();
  expect(fetch).toHaveBeenCalledWith('/api/agents/refresh', expect.objectContaining({ method: 'POST' }));
});

it('updates models on window focus while retaining unsaved settings', async () => {
  render(<MapDesignSettings />);
  await screen.findByText('Kimi K3');
  fireEvent.change(screen.getByLabelText('Custom instructions'), { target: { value: 'Keep my draft' } });
  api.agents.mockResolvedValue({ agents: [{ ...agents[0], models: [
    ...agents[0]!.models!, { ...agents[0]!.models![1], id: 'openai-codex/gpt-6-astra', label: 'GPT 6 Astra' },
  ] }] });
  fireEvent(window, new Event('focus'));
  expect(await screen.findByText('GPT 6 Astra')).toBeVisible();
  expect(screen.getByLabelText('Custom instructions')).toHaveValue('Keep my draft');
  expect(api.config).toHaveBeenCalledTimes(1);
});
