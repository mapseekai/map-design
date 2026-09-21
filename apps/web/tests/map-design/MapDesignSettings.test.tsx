import { openSelect, selectValue } from '../helpers/select';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ agents: vi.fn(), config: vi.fn() }));
vi.mock('../../src/api/client', () => ({ getLocalAgents: api.agents, getMapDesignConfig: api.config }));

import { I18nProvider } from '../../src/i18n';
import { MapDesignSettings } from '../../src/map-design/MapDesignSettings';


afterEach(() => {
  cleanup();
  delete (window as typeof window & { __mapDesign__?: unknown }).__mapDesign__;
});
describe('MapDesignSettings', () => {
  beforeEach(() => {
    localStorage.clear();
    api.agents.mockResolvedValue({ agents: [{ id: 'claude', label: 'Claude', available: true, mapDesign: { nativeMapTools: false, publicReasoningSummary: false, reason: 'native-tools-unavailable' }, models: [{ id: 'sonnet', label: 'Sonnet' }] }] });
    api.config.mockResolvedValue({ config: { agentId: 'claude' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ config: {} }), { status: 200 })));
  });

  it('edits and validates API execution budgets without sending saved secrets', async () => {
    api.agents.mockResolvedValueOnce({ agents: [{ id: 'api', label: 'API Model', available: true, mapDesign: { nativeMapTools: true, publicReasoningSummary: true }, models: [{ id: 'default', label: 'Default' }] }] });
    api.config.mockResolvedValueOnce({ config: { agentId: 'api' } });
    render(<I18nProvider><MapDesignSettings /></I18nProvider>);
    const steps = await screen.findByLabelText(/Maximum model steps/);
    fireEvent.change(steps, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.change(steps, { target: { value: '64' } });
    fireEvent.change(screen.getByLabelText(/Output tokens per call/), { target: { value: '32768' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)))
      .toEqual({ apiExecution: { maxSteps: 64, maxToolCalls: 192, maxOutputTokens: 32768, cartographyMaxOutputTokens: 32768 } });
  });


  it('preserves other saved runtime preferences when editing one local agent model', async () => {
    api.config.mockResolvedValueOnce({ config: { agentId: 'claude', agentModels: {
      claude: { model: 'old-model' }, codex: { model: 'untouched-model', reasoning: 'high' },
    } } });
    render(<MapDesignSettings />);
    await screen.findByLabelText('Model');
    selectValue(screen.getByLabelText('Model'), 'sonnet');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)).agentModels).toEqual({
      claude: { model: 'sonnet' }, codex: { model: 'untouched-model', reasoning: 'high' },
    });
  });

  it('localizes settings labels and save errors in Chinese without changing the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
    render(<I18nProvider initial="zh-CN"><MapDesignSettings /></I18nProvider>);
    expect(await screen.findByText('配置本地地图设计智能体。')).toBeInTheDocument();
    for (const label of ['本地智能体', '模型', '协议', 'API 密钥', '基础 URL', '自备密钥模型', '自定义指令', '语言', '外观']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('自备 API 密钥')).toBeInTheDocument();
    expect(screen.getByText('浅色')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('自定义指令'), { target: { value: '测试说明' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法保存设置。');
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({ customInstructions: '测试说明' });
  });

  it('localizes loading and load errors in Chinese', async () => {
    let reject!: () => void;
    api.config.mockReturnValue(new Promise((_resolve, fail) => { reject = () => fail(new Error('unavailable')); }));
    render(<I18nProvider initial="zh-CN"><MapDesignSettings /></I18nProvider>);
    expect(screen.getByRole('status')).toHaveTextContent('正在加载设置…');
    await act(async () => reject());
    expect(screen.getByRole('alert')).toHaveTextContent('无法加载设置。');
  });

  it('sends only an explicitly entered API key in a PUT config update', async () => {
    render(<MapDesignSettings />);
    await screen.findByLabelText('Local agent');
    selectValue(screen.getByLabelText('Model'), 'sonnet');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-secret' } });
    fireEvent.change(screen.getByLabelText('Custom instructions'), { target: { value: 'Be concise' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/config', expect.objectContaining({ method: 'PUT' })));
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ agentModels: { claude: { model: 'sonnet' } }, customInstructions: 'Be concise' });
    expect(body.byokProviders.default).toMatchObject({ protocol: 'anthropic', apiKey: 'sk-secret' });
  });

  it('keeps a redacted API key out of metadata-only updates', async () => {
    api.config.mockResolvedValueOnce({ config: { agentId: 'claude', byokProviders: { default: { protocol: 'anthropic', apiKey: '[REDACTED]', baseUrl: 'https://old.example' } } } });
    render(<MapDesignSettings />);
    expect(await screen.findByLabelText('API key')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://new.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(body.byokProviders.default).toEqual({ protocol: 'anthropic', baseUrl: 'https://new.example' });
    expect(JSON.stringify(body)).not.toContain('[REDACTED]');
  });

  it('sends empty provider metadata to clear stored optional values without resending a secret', async () => {
    api.config.mockResolvedValueOnce({ config: {
      agentId: 'claude',
      byokProviders: { default: {
        protocol: 'anthropic',
        apiKey: '[REDACTED]',
        baseUrl: 'https://old.example',
        model: 'old-model',
      } },
    } });
    render(<MapDesignSettings />);
    await screen.findByLabelText('Base URL');
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('BYOK model'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(body.byokProviders.default).toEqual({ protocol: 'anthropic', baseUrl: '', model: '' });
    expect(JSON.stringify(body)).not.toContain('[REDACTED]');
  });

  it('keeps one Default option, omits the default model override, and saves another model', async () => {
    api.agents.mockResolvedValueOnce({ agents: [{ id: 'claude', label: 'Claude', available: true, mapDesign: { nativeMapTools: false, publicReasoningSummary: false, reason: 'native-tools-unavailable' }, models: [{ id: 'default', label: 'Default' }, { id: 'sonnet', label: 'Sonnet' }] }] });
    api.config.mockResolvedValueOnce({ config: { agentId: 'claude', agentModels: { claude: { model: 'default' } } } });
    render(<MapDesignSettings />);
    await screen.findByLabelText('Model');
    openSelect(screen.getByLabelText('Model'));
    expect(screen.getAllByRole('option', { name: 'Default' })).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole('option', { name: 'Default' }), { key: 'Escape' });
    expect(screen.getByLabelText('Model')).toHaveTextContent('Default');
    fireEvent.change(screen.getByLabelText('Custom instructions'), { target: { value: 'Be concise' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).not.toHaveProperty('agentModels');
    selectValue(screen.getByLabelText('Model'), 'sonnet');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body))).toMatchObject({ agentModels: { claude: { model: 'sonnet' } } });
  });

  it('clears the agent override when Default is saved so the provider model can govern', async () => {
    api.agents.mockResolvedValueOnce({ agents: [{ id: 'byok-opencode', label: 'BYOK', available: true, mapDesign: { nativeMapTools: false, publicReasoningSummary: false, reason: 'native-tools-unavailable' }, models: [{ id: 'sonnet', label: 'Sonnet' }] }] });
    api.config.mockResolvedValueOnce({ config: {
      agentId: 'byok-opencode',
      agentModels: { 'byok-opencode': { model: 'sonnet' } },
      byokProviders: { default: { protocol: 'openai', apiKey: '[REDACTED]', model: 'provider-model' } },
    } });
    render(<MapDesignSettings />);
    await screen.findByLabelText('Model');
    selectValue(screen.getByLabelText('Model'), '');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(body.agentModels).toEqual({});
    expect(body.byokProviders).toBeUndefined();
  });

  it('persists the appearance preference without a desktop bridge', async () => {
    localStorage.setItem('map-design.appearance', 'system');
    render(<I18nProvider initial="en"><MapDesignSettings /></I18nProvider>);
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
    render(<MapDesignSettings />);
    await screen.findByLabelText('Appearance');
    selectValue(screen.getByLabelText('Appearance'), 'light');

    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('keeps unsupported Agents visible with their Map Studio capability labels', async () => {
    api.agents.mockResolvedValueOnce({ agents: [
      { id: 'codex', label: 'Codex', available: true, mapDesign: { nativeMapTools: true, publicReasoningSummary: true } },
      { id: 'text-only', label: 'Text Agent', available: true, mapDesign: { nativeMapTools: false, publicReasoningSummary: false, reason: 'native-tools-unavailable' } },
    ] });
    api.config.mockResolvedValueOnce({ config: { agentId: 'text-only' } });
    render(<MapDesignSettings />);

    openSelect(await screen.findByLabelText('Local agent'));
    expect(await screen.findByRole('option', { name: 'Text Agent — Map editing unavailable' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Codex — Public reasoning summaries available' })).toBeInTheDocument();
  });

  it('serializes a pending save and preserves the draft until it completes', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((complete) => { resolve = complete; })));
    render(<MapDesignSettings />);
    await screen.findByLabelText('Custom instructions');
    fireEvent.change(screen.getByLabelText('Custom instructions'), { target: { value: 'First' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    expect(screen.getByLabelText('API key')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save settings' }).closest('section')).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(fetch).toHaveBeenCalledOnce();
    await act(async () => { resolve(new Response(JSON.stringify({ config: {} }), { status: 200 })); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled());
    expect(screen.getByLabelText('Custom instructions')).toHaveValue('First');
  });
});

it('saves response format in the named model editor without resending a stored key', async () => {
  api.agents.mockResolvedValueOnce({ agents: [{ id: 'api', label: 'API Model', available: true, mapDesign: { nativeMapTools: true }, models: [] }] });
  api.config.mockResolvedValueOnce({ config: { agentId: 'api', byokProviders: { default: { protocol: 'openai', apiKey: '[REDACTED]', model: 'configured-model' } } } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ activeProfileId: 'default', profiles: [
    { id: 'default', name: 'configured-model', protocol: 'openai', apiFormat: 'responses', baseUrl: '', model: 'configured-model', hasApiKey: true, requiresApiKey: true }
  ] }), { status: 200 })));
  render(<MapDesignSettings />);
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
  fireEvent.change(await screen.findByLabelText('Configuration name'), { target: { value: 'Not saved yet' } });
  expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  expect(screen.queryByText('Settings saved')).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});
