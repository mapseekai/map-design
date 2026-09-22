// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { MapDesignComposer } from '../../../src/map-design/chat/MapDesignComposer';
import { messageQueueCopy } from '../../../src/i18n/locales/message-queue';

afterEach(cleanup);
function Composer({ onSend, onCancel }: { onSend(prompt: string): boolean | Promise<boolean>; onCancel(): void }) {
  const [draft, setDraft] = useState('');
  return <MapDesignComposer projectId="queue-project" runtime={{ revision: 0, agentId: 'codex' }}
    sending queueEnabled draft={draft} onDraftChange={setDraft} onSend={onSend} onCancel={onCancel} />;
}

it('keeps the running composer editable and exposes separate queue and stop controls', async () => {
  const onSend = vi.fn(() => true);
  const onCancel = vi.fn();
  render(<Composer onSend={onSend} onCancel={onCancel} />);
  const input = screen.getByRole('textbox', { name: 'Message map agent' });
  expect(input).toBeEnabled();
  expect(input).toHaveAttribute('placeholder', messageQueueCopy.en.placeholder);
  fireEvent.change(input, { target: { value: 'Next request' } });
  fireEvent.click(screen.getByRole('button', { name: messageQueueCopy.en.enqueue }));
  await waitFor(() => expect(input).toHaveValue(''));
  expect(onSend).toHaveBeenCalledExactlyOnceWith('Next request');
  expect(onCancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
  expect(onCancel).toHaveBeenCalledOnce();
});

it('preserves Chinese composition and Shift+Enter, and coalesces duplicate submissions', async () => {
  let finish: (accepted: boolean) => void = () => undefined;
  const onSend = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  render(<Composer onSend={onSend} onCancel={vi.fn()} />);
  const input = screen.getByRole('textbox', { name: 'Message map agent' });
  fireEvent.change(input, { target: { value: '调整图层颜色' } });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.click(screen.getByRole('button', { name: messageQueueCopy.en.enqueue }));
  expect(onSend).toHaveBeenCalledOnce();
  fireEvent.change(input, { target: { value: '新的内容' } });
  await act(async () => finish(true));
  expect(input).toHaveValue('新的内容');
});
