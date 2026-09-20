// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MapDesignComposer } from '../../../src/map-design/chat/MapDesignComposer';
import { attachmentsCopy } from '../../../src/i18n/locales/attachments';
import { I18nProvider, type Locale, useT } from '../../../src/i18n';


afterEach(cleanup);
const runtime = {
  revision: 0,
  agentId: 'opencode',
  model: 'openai/gpt-5.6-terra',
  reasoning: 'high',
  updatedAt: '2026-09-02T00:00:00.000Z',
};
const agents = [{
  id: 'opencode', label: 'OpenCode', available: true,
  mapDesign: { nativeMapTools: true, publicReasoningSummary: true },
  models: [{
    id: 'openai/gpt-5.6-terra', label: 'GPT 5.6 Terra', enabled: true, default: true,
    reasoningOptions: ['high'], serviceTierOptions: [],
  }],
  modelCatalogSource: 'live' as const,
}];

type Translate = ReturnType<typeof useT>;

function ComposerHarness({
  sending = false,
  onCancel,
  onSend,
  onTranslate,
}: {
  sending?: boolean;
  onCancel?: () => void | Promise<void>;
  onSend(prompt: string): boolean | Promise<boolean>;
  onTranslate(translate: Translate): void;
}) {
  const [draft, setDraft] = useState('');
  onTranslate(useT());
  return <MapDesignComposer projectId="p" runtime={runtime} runtimeAgents={agents} runtimeSaving={false} runtimeNotice={null}
    onRuntimeChange={async () => undefined} sending={sending} draft={draft} onCancel={onCancel} onDraftChange={setDraft} onSend={onSend} />;
}

function renderComposer({
  locale = 'en',
  sending = false,
  onCancel,
  onSend,
}: {
  locale?: Locale;
  sending?: boolean;
  onCancel?: () => void | Promise<void>;
  onSend(prompt: string): boolean | Promise<boolean>;
}) {
  let translate: Translate | undefined;
  const view = render(<I18nProvider initial={locale}>
    <ComposerHarness sending={sending} onCancel={onCancel} onSend={onSend} onTranslate={(next) => { translate = next; }} />
  </I18nProvider>);
  return { ...view, t: translate! };
}

describe('MapDesignComposer', () => {
  it('uses the same action button for send and stop', async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    const props = { projectId: 'p', runtime, draft: 'Ready', onDraftChange: vi.fn(), onSend: vi.fn().mockResolvedValue(true), onCancel };
    const view = render(<MapDesignComposer {...props} sending={false} />);
    const button = screen.getByRole('button', { name: 'Send' });
    view.rerender(<MapDesignComposer {...props} sending />);
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBe(button);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    await act(async () => fireEvent.click(button));
    expect(onCancel).toHaveBeenCalledOnce();
    view.rerender(<MapDesignComposer {...props} sending={false} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBe(button);
  });

  it('opens a format menu before invoking the file picker', () => {
    render(<MapDesignComposer projectId="p" runtime={runtime} draft="" onDraftChange={vi.fn()} onSend={vi.fn()} sending={false} onAttachmentsChange={vi.fn()} />);
    const input = screen.getByLabelText(attachmentsCopy.en.select) as HTMLInputElement;
    const picker = vi.spyOn(input, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: attachmentsCopy.en.attach }));
    expect(picker).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'CSV / TSV' }));
    expect(input.accept).toBe('.csv,.tsv');
    expect(picker).toHaveBeenCalledOnce();
  });

  it('keeps and refocuses a rejected prompt', async () => {
    const onSend = vi.fn().mockResolvedValue(false);
    const { t } = renderComposer({ onSend });
    const input = screen.getByLabelText(t('mapDesign.composer.label'));
    fireEvent.change(input, { target: { value: 'Keep this prompt' } });
    fireEvent.click(screen.getByRole('button', { name: t('mapDesign.composer.send') }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Keep this prompt'));
    expect(input).toHaveValue('Keep this prompt');
    expect(input).toHaveFocus();
  });

  it('clears a prompt only after the run is accepted', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const { t } = renderComposer({ onSend });
    const input = screen.getByLabelText(t('mapDesign.composer.label'));
    fireEvent.change(input, { target: { value: 'Send this prompt' } });
    fireEvent.click(screen.getByRole('button', { name: t('mapDesign.composer.send') }));
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('keeps newer edits when an earlier prompt is accepted', async () => {
    let resolveSend: (accepted: boolean) => void = () => {};
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveSend = resolve;
    }));
    const { t } = renderComposer({ onSend });
    const input = screen.getByLabelText(t('mapDesign.composer.label'));
    fireEvent.change(input, { target: { value: 'First prompt' } });
    fireEvent.click(screen.getByRole('button', { name: t('mapDesign.composer.send') }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('First prompt'));
    fireEvent.change(input, { target: { value: 'Second prompt' } });
    await act(async () => resolveSend(true));
    expect(input).toHaveValue('Second prompt');
  });

  it('keeps the localized send control name without the keyboard shortcut hint', () => {
    const { t } = renderComposer({ onSend: vi.fn() });
    expect(screen.getByRole('button', { name: t('mapDesign.composer.send') })).toBeInTheDocument();
    expect(screen.queryByText('Press Enter to send')).not.toBeInTheDocument();
  });

  it('shows only the stop action while running', async () => {
    const onCancel = vi.fn();
    const { t } = renderComposer({ sending: true, onCancel, onSend: vi.fn() });
    const group = screen.getByRole('group', { name: t('mapDesign.composer.runActions') });

    expect(within(group).getByRole('button', { name: t('mapDesign.conversation.cancelRun') })).toBeEnabled();
    expect(within(group).queryByRole('button', { name: t('mapDesign.composer.send') })).toBeNull();

    fireEvent.click(within(group).getByRole('button', { name: t('mapDesign.conversation.cancelRun') }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('keeps a single cancel action beside the runtime chip', () => {
    const { t } = renderComposer({ sending: true, onCancel: vi.fn(), onSend: vi.fn() });
    const form = screen.getByRole('textbox', { name: t('mapDesign.composer.label') }).closest('form');
    const chip = screen.getByRole('button', { name: /Change runtime/iu });
    const group = screen.getByRole('group', { name: t('mapDesign.composer.runActions') });
    const actions = within(group).getAllByRole('button');

    expect(form).toContainElement(chip);
    expect(actions.map((action) => action.getAttribute('aria-label'))).toEqual([
      t('mapDesign.conversation.cancelRun'),
    ]);
  });

  it('does not submit a nonempty map draft when Enter is pressed in runtime model search', () => {
    const onSend = vi.fn();
    const { t } = renderComposer({ onSend });
    const draft = screen.getByRole('textbox', { name: t('mapDesign.composer.label') });
    fireEvent.change(draft, { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));
    const search = screen.getByRole('searchbox', { name: 'Search models' });

    const browserMaySubmit = fireEvent.keyDown(search, { key: 'Enter' });
    if (browserMaySubmit) fireEvent.submit(search.closest('form')!);

    expect(onSend).not.toHaveBeenCalled();
    expect(draft).toHaveValue('Keep this draft');
  });

  it('coalesces rapid stop activations while cancellation is pending', async () => {
    let resolveCancel: () => void = () => {};
    const onCancel = vi.fn(() => new Promise<void>((resolve) => { resolveCancel = resolve; }));
    const { t } = renderComposer({ sending: true, onCancel, onSend: vi.fn() });
    const cancel = screen.getByRole('button', { name: t('mapDesign.conversation.cancelRun') });

    fireEvent.click(cancel);
    fireEvent.click(cancel);

    expect(onCancel).toHaveBeenCalledOnce();
    expect(cancel).toBeDisabled();
    await act(async () => resolveCancel());
    await waitFor(() => expect(cancel).toBeEnabled());
  });

  it('keeps a prompt edited back to its submitted value while send is pending', async () => {
    let resolveSend: (accepted: boolean) => void = () => {};
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveSend = resolve;
    }));
    const { t } = renderComposer({ onSend });
    const input = screen.getByLabelText(t('mapDesign.composer.label'));
    fireEvent.change(input, { target: { value: 'Original prompt' } });
    fireEvent.click(screen.getByRole('button', { name: t('mapDesign.composer.send') }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Original prompt'));
    fireEvent.change(input, { target: { value: 'Different prompt' } });
    fireEvent.change(input, { target: { value: 'Original prompt' } });
    await act(async () => resolveSend(true));
    expect(input).toHaveValue('Original prompt');
  });

  it('uses RTL locale names for the composer, attachment state, and send action', () => {
    const { t } = renderComposer({ locale: 'fa', onSend: vi.fn() });

    expect(screen.getByRole('textbox', { name: t('mapDesign.composer.label') })).toHaveAttribute('placeholder', t('mapDesign.composer.placeholder'));
    expect(screen.getByRole('button', { name: attachmentsCopy.fa.attach })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('mapDesign.composer.send') })).toBeInTheDocument();
    expect(screen.queryByText('Press Enter to send')).not.toBeInTheDocument();
  });
});

it('reuses the composer for specification requests with their runtime control and input limit', () => {
  render(<I18nProvider initial="en"><MapDesignComposer projectId="edit-session" runtime={{ agentId: 'api', label: 'API Model', revision: 0 }} maxPromptLength={8000} placeholder="Improve the specification"
    sending={false} draft={'x'.repeat(8001)} onDraftChange={() => undefined} onSend={vi.fn(async () => true)} />
  </I18nProvider>);
  expect(screen.getByRole('textbox', { name: 'Improve the specification' })).toBeInTheDocument();
  expect(screen.getByText('API Model')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('8,000');
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
});
