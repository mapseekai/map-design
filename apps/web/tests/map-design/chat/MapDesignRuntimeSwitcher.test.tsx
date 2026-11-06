// @vitest-environment jsdom

import type { LocalAgentInfo, MapDesignConversationRuntimeChoice } from '@mapseekai/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import { MapDesignRuntimeSwitcher } from '../../../src/map-design/chat/MapDesignRuntimeSwitcher';

const runtime: MapDesignConversationRuntimeChoice = {
  agentId: 'opencode',
  model: 'openai/gpt-5.6-terra',
  modelOrigin: 'catalog',
  reasoning: 'high',
  serviceTier: 'priority',
  revision: 4,
  updatedAt: '2026-09-02T00:00:00.000Z',
};

const agents: LocalAgentInfo[] = [
  {
    id: 'claude', label: 'Claude Code', available: true,
    mapDesign: { nativeMapTools: false, publicReasoningSummary: true, reason: 'map-tools-policy-unsupported' },
    models: [], modelCatalogSource: 'live',
  },
  {
    id: 'missing', label: 'Missing Agent', available: false,
    mapDesign: { nativeMapTools: false, publicReasoningSummary: false, reason: 'agent-unavailable' },
    models: [], modelCatalogSource: 'fallback',
  },
  {
    id: 'opencode', label: 'OpenCode', available: true,
    mapDesign: { nativeMapTools: true, publicReasoningSummary: true },
    supportsReasoning: true, supportsServiceTier: true, supportsCustomModel: true, modelCatalogSource: 'live',
    models: [
      {
        id: 'openai/gpt-5.6-terra', label: 'GPT 5.6 Terra', enabled: true, default: true,
        reasoningOptions: ['low', 'high'], serviceTierOptions: ['standard', 'priority'],
        defaultReasoning: 'low', defaultServiceTier: 'standard',
      },
      {
        id: 'openai/gpt-5.6-luna', label: 'GPT 5.6 Luna', enabled: true, default: false,
        reasoningOptions: ['medium'], serviceTierOptions: [],
      },
      {
        id: 'openai/gpt-5.6-sol', label: 'GPT 5.6 Sol', enabled: true, default: false,
        reasoningOptions: ['medium', 'xhigh'], serviceTierOptions: ['standard', 'flex'],
        defaultReasoning: 'medium', defaultServiceTier: 'flex',
      },
      {
        id: 'legacy/model', label: 'Legacy Model', enabled: false, default: false,
        reasoningOptions: [], serviceTierOptions: [],
      },
    ],
  },
  {
    id: 'pi', label: 'Pi', available: true,
    mapDesign: { nativeMapTools: true, publicReasoningSummary: true },
    models: [{ id: 'anthropic/claude-sonnet', label: 'Claude Sonnet', enabled: true, default: true, reasoningOptions: [], serviceTierOptions: [] }],
    modelCatalogSource: 'fallback', modelCatalogWarning: 'Using bundled model metadata.',
  },
];

function Harness({ disabled = false, disabledReason = null, saving = false, notice = null }: {
  disabled?: boolean;
  disabledReason?: string | null;
  saving?: boolean;
  notice?: string | null;
}) {
  const [selected, setSelected] = useState(runtime);
  return <MapDesignRuntimeSwitcher
    agents={agents}
    runtime={selected}
    disabled={disabled}
    disabledReason={disabledReason}
    saving={saving}
    notice={notice}
    onChange={async (next) => setSelected((current) => ({
      agentId: next.agentId,
      ...(next.model === undefined ? {} : { model: next.model }),
      ...(next.modelOrigin === undefined ? {} : { modelOrigin: next.modelOrigin }),
      ...(next.reasoning === undefined ? {} : { reasoning: next.reasoning }),
      ...(next.serviceTier === undefined ? {} : { serviceTier: next.serviceTier }),
      revision: current.revision + 1,
      updatedAt: current.updatedAt,
    }))}
  />;
}

function renderSwitcher(props: Parameters<typeof Harness>[0] = {}) {
  return render(<I18nProvider initial="en"><Harness {...props} /></I18nProvider>);
}

function chooseSelectOption(label: string) {
  const option = screen.getByRole('option', { name: label });
  fireEvent.pointerDown(option, { pointerType: 'mouse', button: 0 });
  fireEvent.click(option);
}

afterEach(() => cleanup());

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })));
});

describe('MapDesignRuntimeSwitcher', async () => {
  it('restores each model last confirmed reasoning and displays it in the model list', async () => {
    const view = renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));
    fireEvent.click(screen.getByRole('option', { name: /GPT 5.6 Sol/iu }));
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Reasoning' }), { key: 'ArrowDown' });
    chooseSelectOption('xhigh');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Reasoning' })).toHaveTextContent('xhigh'));
    await confirmSelection();
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));
    fireEvent.click(screen.getByRole('option', { name: /GPT 5.6 Terra/iu }));
    expect(screen.getByRole('combobox', { name: 'Reasoning' })).toHaveTextContent('high');
    expect(screen.getByRole('option', { name: /GPT 5.6 Sol/iu })).toHaveTextContent('Reasoning: xhigh');
    fireEvent.click(screen.getByRole('option', { name: /GPT 5.6 Sol/iu }));
    expect(screen.getByRole('combobox', { name: 'Reasoning' })).toHaveTextContent('xhigh');
    expect(screen.getByRole('option', { name: /GPT 5.6 Sol/iu })).not.toHaveTextContent('openai/gpt-5.6-sol');
    view.unmount();
    renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));
    fireEvent.click(screen.getByRole('option', { name: /GPT 5.6 Sol/iu }));
    expect(screen.getByRole('combobox', { name: 'Reasoning' })).toHaveTextContent('xhigh');
  });

  it('remembers an explicit default instead of restoring another model intensity', async () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Reasoning' }), { key: 'ArrowDown' });
    chooseSelectOption('Default');
    await confirmSelection();
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));
    fireEvent.click(screen.getByRole('option', { name: /GPT 5.6 Sol/iu }));
    expect(screen.getByRole('combobox', { name: 'Reasoning' })).toHaveTextContent('medium');
    fireEvent.click(screen.getByRole('option', { name: /GPT 5.6 Terra/iu }));
    expect(screen.getByRole('combobox', { name: 'Reasoning' })).toHaveTextContent('Default');
  });

  it('ignores removed reasoning values and malformed saved preferences', async () => {
    localStorage.setItem('map-design.runtime-reasoning.v1', JSON.stringify({
      [JSON.stringify(['opencode', 'openai/gpt-5.6-sol'])]: 'removed-option',
    }));
    const view = renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));
    fireEvent.click(screen.getByRole('option', { name: /GPT 5.6 Sol/iu }));
    expect(screen.getByRole('combobox', { name: 'Reasoning' })).toHaveTextContent('medium');
    view.unmount();
    localStorage.setItem('map-design.runtime-reasoning.v1', '{invalid json');
    renderSwitcher();
    expect(screen.getByRole('button', { name: /Change runtime/iu })).toHaveTextContent('high');
  });

  it('does not persist a pending runtime and remembers only confirmed props', async () => {
    const view = renderSwitcher({ saving: true });
    expect(localStorage.getItem('map-design.runtime-reasoning.v1')).toBeNull();
    view.rerender(<I18nProvider initial="en"><Harness saving={false} /></I18nProvider>);
    expect(JSON.parse(localStorage.getItem('map-design.runtime-reasoning.v1')!))
      .toEqual({ [JSON.stringify(['opencode', 'openai/gpt-5.6-terra'])]: 'high' });
  });

  it('does not remember a requested selection without a confirmed runtime update', async () => {
    render(<I18nProvider initial="en"><MapDesignRuntimeSwitcher agents={agents} runtime={runtime}
      disabled={false} disabledReason={null} saving={false} notice={null} onChange={async () => undefined} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));
    fireEvent.click(screen.getByRole('option', { name: /GPT 5.6 Sol/iu }));
    const preferences = JSON.parse(localStorage.getItem('map-design.runtime-reasoning.v1')!);
    expect(preferences[JSON.stringify(['opencode', 'openai/gpt-5.6-sol'])]).toBeUndefined();
  });

  it('remains usable when preference storage is unavailable', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    try {
      renderSwitcher();
      fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));
      expect(screen.getByRole('dialog', { name: 'Runtime settings' })).toBeInTheDocument();
    } finally { get.mockRestore(); set.mockRestore(); }
  });

  it('renders the compact Agent, model, and reasoning chip', async () => {
    renderSwitcher();
    expect(screen.getByRole('button', { name: /Change runtime.*OpenCode.*GPT 5\.6 Terra.*high/iu }))
      .toHaveTextContent('OpenCode · GPT 5.6 Terra · high');
  });

  it('lists only supported available Agents', async () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));
    const list = screen.getByRole('listbox', { name: 'Agents' });
    const options = within(list).getAllByRole('option');

    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('OpenCode'),
      expect.stringContaining('Pi'),
    ]);
    expect(within(list).queryByRole('option', { name: /Claude Code/iu })).not.toBeInTheDocument();
    expect(within(list).queryByRole('option', { name: /Missing Agent/iu })).not.toBeInTheDocument();
  });

  it('searches models and exposes only the selected model reasoning and tier controls', async () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search models' }), { target: { value: 'Luna' } });

    expect(screen.getByRole('option', { name: /GPT 5.6 Luna/iu })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /GPT 5.6 Terra/iu })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /GPT 5.6 Luna/iu }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Change runtime/iu, hidden: true })).toHaveTextContent('OpenCode · GPT 5.6 Terra'));
    expect(screen.getByRole('combobox', { name: 'Reasoning' })).toHaveTextContent('Default');
    expect(screen.queryByRole('combobox', { name: 'Service tier' })).not.toBeInTheDocument();
  });

  it('writes catalog origin for catalog rows and custom origin only through the supported custom entry', async () => {
    const onChange = vi.fn(async () => undefined);
    render(<I18nProvider initial="en"><MapDesignRuntimeSwitcher agents={agents} runtime={runtime}
      disabled={false} disabledReason={null} saving={false} notice={null} onChange={onChange} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));

    fireEvent.click(screen.getByRole('option', { name: /GPT 5\.6 Luna/iu }));
    await confirmSelection();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      model: 'openai/gpt-5.6-luna', modelOrigin: 'catalog',
    }));

    fireEvent.change(screen.getByRole('textbox', { name: 'Custom model' }), {
      target: { value: 'provider/deliberate-custom' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use custom model' }));
    await confirmSelection();
    expect(onChange).toHaveBeenLastCalledWith({
      agentId: 'opencode', model: 'provider/deliberate-custom', modelOrigin: 'custom',
    });
  });

  it('can replace a same-id custom model with the explicit catalog selection', async () => {
    const onChange = vi.fn(async () => undefined);
    render(<I18nProvider initial="en"><MapDesignRuntimeSwitcher agents={agents} runtime={{
      ...runtime,
      modelOrigin: 'custom',
    }} disabled={false} disabledReason={null} saving={false} notice={null}
      onChange={onChange} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));

    fireEvent.click(screen.getByRole('option', { name: /GPT 5\.6 Terra/iu }));

    await confirmSelection();

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({
      agentId: 'opencode',
      model: 'openai/gpt-5.6-terra',
      modelOrigin: 'catalog',
      reasoning: 'high',
      serviceTier: 'priority',
    });
  });

  it('preserves valid options, uses explicit defaults, and otherwise omits them on model changes', async () => {
    const onChange = vi.fn(async () => undefined);
    render(<I18nProvider initial="en"><MapDesignRuntimeSwitcher agents={agents} runtime={runtime}
      disabled={false} disabledReason={null} saving={false} notice={null} onChange={onChange} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));

    fireEvent.click(screen.getByRole('option', { name: /GPT 5\.6 Luna/iu }));
    await confirmSelection();
    expect(onChange).toHaveBeenLastCalledWith({
      agentId: 'opencode',
      model: 'openai/gpt-5.6-luna',
      modelOrigin: 'catalog',
    });

    fireEvent.click(screen.getByRole('option', { name: /GPT 5\.6 Sol/iu }));
    await confirmSelection();
    expect(onChange).toHaveBeenLastCalledWith({
      agentId: 'opencode',
      model: 'openai/gpt-5.6-sol',
      modelOrigin: 'catalog',
      reasoning: 'medium',
      serviceTier: 'flex',
    });
  });

  it('renders localized Default options that clear saved reasoning and service tier', async () => {
    const onChange = vi.fn(async () => undefined);
    render(<I18nProvider initial="en"><MapDesignRuntimeSwitcher agents={agents} runtime={runtime}
      disabled={false} disabledReason={null} saving={false} notice={null} onChange={onChange} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));

    const reasoning = screen.getByRole('combobox', { name: 'Reasoning' });
    const serviceTier = screen.getByRole('combobox', { name: 'Service tier' });
    fireEvent.keyDown(reasoning, { key: 'ArrowDown' });
    chooseSelectOption('Default');
    await confirmSelection();
    expect(onChange).toHaveBeenLastCalledWith({
      agentId: 'opencode',
      model: 'openai/gpt-5.6-terra',
      modelOrigin: 'catalog',
      serviceTier: 'priority',
    });
    fireEvent.keyDown(serviceTier, { key: 'ArrowDown' });
    chooseSelectOption('Default');
    await confirmSelection();
    expect(onChange).toHaveBeenLastCalledWith({
      agentId: 'opencode',
      model: 'openai/gpt-5.6-terra',
      modelOrigin: 'catalog',
    });
  });

  it('does not reset valid high and priority options when reselecting the current Agent', async () => {
    const onChange = vi.fn(async () => undefined);
    render(<I18nProvider initial="en"><MapDesignRuntimeSwitcher agents={agents} runtime={runtime}
      disabled={false} disabledReason={null} saving={false} notice={null} onChange={onChange} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));

    fireEvent.click(screen.getByRole('option', { name: /OpenCode/iu }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Change runtime/iu, hidden: true })).toHaveTextContent('OpenCode · GPT 5.6 Terra · high');
    expect(screen.getByRole('combobox', { name: 'Reasoning' })).toHaveTextContent('high');
    expect(screen.getByRole('combobox', { name: 'Service tier' })).toHaveTextContent('priority');
  });

  it('does not reset valid high and priority options when reselecting the current model', async () => {
    const onChange = vi.fn(async () => undefined);
    render(<I18nProvider initial="en"><MapDesignRuntimeSwitcher agents={agents} runtime={runtime}
      disabled={false} disabledReason={null} saving={false} notice={null} onChange={onChange} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));

    fireEvent.click(screen.getByRole('option', { name: /GPT 5.6 Terra/iu }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Reasoning' })).toHaveTextContent('high');
    expect(screen.getByRole('combobox', { name: 'Service tier' })).toHaveTextContent('priority');
  });

  it('disables unavailable model rows and surfaces fallback catalog warnings and normalization notices', async () => {
    renderSwitcher({ notice: 'The daemon adjusted this runtime to an available model.' });
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));
    expect(screen.getByRole('option', { name: /Legacy Model/iu })).toBeDisabled();
    fireEvent.click(screen.getByRole('option', { name: /Pi/iu }));

    expect(await screen.findByRole('status')).toHaveTextContent('Using bundled model metadata.');
    expect(screen.getByText('The daemon adjusted this runtime to an available model.')).toBeInTheDocument();
  });

  it('uses a portalled modal with focus containment and restores focus on close', async () => {
    render(<I18nProvider initial="en">
      <button type="button">Background action</button>
      <Harness />
    </I18nProvider>);
    const trigger = screen.getByRole('button', { name: /Change runtime/iu });
    const background = screen.getByRole('button', { name: 'Background action' });
    fireEvent.click(trigger);

    const panel = screen.getByRole('dialog', { name: 'Runtime settings' });
    const close = within(panel).getByRole('button', { name: 'Close' });
    const last = within(panel).getByRole('button', { name: 'Confirm' });
    expect(document.body).toContainElement(panel);
    expect(trigger.parentElement).not.toContainElement(panel);
    expect(background.closest('[aria-hidden="true"]')).not.toBeNull();
    await waitFor(() => expect(screen.getByRole('option', { name: /OpenCode/iu })).toHaveFocus());
    last.focus();
    // jsdom does not perform native Tab traversal; enter Base UI's after guard.
    (panel.nextElementSibling as HTMLElement).focus();
    await waitFor(() => expect(close).toHaveFocus());
    close.focus();
    (panel.previousElementSibling as HTMLElement).focus();
    await waitFor(() => expect(last).toHaveFocus());
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Runtime settings' })).not.toBeInTheDocument();
    expect(background.closest('[aria-hidden="true"]')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('supports arrow navigation, Enter selection, Escape close, focus restoration, and live announcements', async () => {
    renderSwitcher();
    const trigger = screen.getByRole('button', { name: /Change runtime/iu });
    fireEvent.click(trigger);
    const openCode = screen.getByRole('option', { name: /OpenCode/iu });
    await waitFor(() => expect(openCode).toHaveFocus());
    fireEvent.keyDown(openCode, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Pi/iu })).toHaveFocus();
    fireEvent.keyDown(document.activeElement ?? openCode, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('option', { name: /Pi/iu })).toHaveAttribute('aria-selected', 'true'));
    expect(trigger).toHaveTextContent('OpenCode · GPT 5.6 Terra');
    expect(screen.getByText('Pi · Models: Claude Sonnet (anthropic/claude-sonnet)')).toBeVisible();
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Runtime settings' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Runtime settings' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('disables the trigger with precise historical and active-run reasons', async () => {
    const view = renderSwitcher({ disabled: true, disabledReason: 'Runtime cannot change while a run is active.' });
    const disabledTrigger = screen.getByRole('button', { name: /Change runtime/iu });
    expect(disabledTrigger).toBeDisabled();
    expect(screen.getByText('Runtime cannot change while a run is active.')).toBeInTheDocument();
    expect(disabledTrigger).toHaveAttribute('aria-describedby', expect.stringMatching(/runtime-disabled/u));
    expect(document.getElementById(disabledTrigger.getAttribute('aria-describedby')!))
      .toHaveTextContent('Runtime cannot change while a run is active.');
    view.rerender(<I18nProvider initial="en"><Harness disabled disabledReason="Return to current version to change runtime." /></I18nProvider>);
    expect(screen.getByRole('button', { name: /Change runtime/iu })).toBeDisabled();
    expect(screen.getByText('Return to current version to change runtime.')).toBeInTheDocument();
  });

  it('announces saving without allowing another runtime mutation', async () => {
    renderSwitcher({ saving: true });
    expect(screen.getByRole('button', { name: /Change runtime/iu })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Saving runtime…');
  });

  it('keeps the portalled picker open while saving so the model can be selected next', async () => {
    const view = renderSwitcher({ saving: false });
    const trigger = screen.getByRole('button', { name: /Change runtime/iu });
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole('option', { name: /OpenCode/iu })).toHaveFocus());

    view.rerender(<I18nProvider initial="en"><Harness saving /></I18nProvider>);
    expect(view.container).not.toContainElement(screen.getByRole('dialog', { name: 'Runtime settings' }));
    expect(screen.getByRole('option', { name: /OpenCode/iu })).toBeDisabled();
    expect(trigger).toBeDisabled();

    view.rerender(<I18nProvider initial="en"><Harness saving={false} /></I18nProvider>);
    await waitFor(() => expect(trigger).toBeEnabled());
    expect(screen.getByRole('option', { name: /OpenCode/iu })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(trigger).toHaveFocus();
  });
});

it('switches named API profiles independently even when the remote model names match', async () => {
  const onChange = vi.fn(async () => undefined);
  const entries: LocalAgentInfo[] = [{ id: 'api', label: 'API Model', available: true,
    mapDesign: { nativeMapTools: true, publicReasoningSummary: true }, modelCatalogSource: 'configured',
    models: [
      { id: 'api-profile:a', label: 'Primary · shared-model', enabled: true, default: true, reasoningOptions: [], serviceTierOptions: [] },
      { id: 'api-profile:b', label: 'Secondary · shared-model', enabled: true, default: false, reasoningOptions: [], serviceTierOptions: [] },
    ] }];
  render(<I18nProvider initial="en"><MapDesignRuntimeSwitcher agents={entries}
    runtime={{ agentId: 'api', model: 'api-profile:a', modelOrigin: 'catalog', revision: 1, updatedAt: '2026-09-20T00:00:00Z' }}
    disabled={false} disabledReason={null} saving={false} notice={null} onChange={onChange} /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: /Change runtime/ }));
  expect(screen.getByText('Saved API models')).toBeVisible();
  fireEvent.click(screen.getByRole('option', { name: 'Secondary · shared-model' }));
  await confirmSelection();
  expect(onChange).toHaveBeenCalledWith({ agentId: 'api', model: 'api-profile:b', modelOrigin: 'catalog' });
});

async function confirmSelection() {
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => {
    const button = screen.queryByRole('button', { name: 'Confirm' });
    if (button) expect(button).not.toBeDisabled();
  });
}

it('retains the draft after a failed confirmation and discards it on Escape', async () => {
  const onChange = vi.fn(async () => { throw new Error('Save failed'); });
  render(<I18nProvider initial="en"><MapDesignRuntimeSwitcher agents={agents} runtime={runtime}
    disabled={false} disabledReason={null} saving={false} notice={null} onChange={onChange} /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: /Change runtime/ }));
  fireEvent.click(screen.getByRole('option', { name: /GPT 5.6 Luna/ }));
  await confirmSelection();
  expect(screen.getByRole('option', { name: /GPT 5.6 Luna/ })).toHaveAttribute('aria-selected', 'true');
  expect(onChange).toHaveBeenCalledOnce();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: /Change runtime/ }));
  expect(screen.getByRole('option', { name: /GPT 5.6 Terra/ })).toHaveAttribute('aria-selected', 'true');
});

it('keeps choices local until confirmation and discards canceled changes', async () => {
  const onChange = vi.fn(async () => undefined);
  render(<I18nProvider initial="en"><MapDesignRuntimeSwitcher agents={agents} runtime={runtime}
    disabled={false} disabledReason={null} saving={false} notice={null} onChange={onChange} /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: /Change runtime/ }));
  fireEvent.click(screen.getByRole('option', { name: /GPT 5.6 Luna/ }));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Change runtime/ }));
  expect(screen.getByRole('option', { name: /GPT 5.6 Terra/ })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('option', { name: /GPT 5.6 Luna/ }));
  await confirmSelection();
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ agentId: 'opencode', model: 'openai/gpt-5.6-luna', modelOrigin: 'catalog' });
});
