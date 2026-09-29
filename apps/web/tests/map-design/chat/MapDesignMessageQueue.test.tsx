// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider, type Locale } from '../../../src/i18n';
import { messageQueueCopy } from '../../../src/i18n/locales/message-queue';
import { MapDesignMessageQueue } from '../../../src/map-design/chat/MapDesignMessageQueue';
import type { PendingMapMessage } from '../../../src/map-design/chat/useQueuedMapMessages';

afterEach(cleanup);

const first: PendingMapMessage = { id: 'first', requestId: 'request-first', prompt: 'Make the water blue', screenshots: [], attachments: [] };
const second: PendingMapMessage = { id: 'second', requestId: 'request-second', prompt: '然后检查中文图层名称', screenshots: [], attachments: [
  { id: 'a'.repeat(64), projectId: 'p', fileName: 'notes.txt', mediaType: 'text/plain', byteLength: 5, createdAt: '2026-09-22T00:00:00.000Z' },
] };

function QueueHarness({ onSave, onRemove, submittingId = null, locale = 'en' }: {
  onSave(id: string, prompt: string): void;
  onRemove(id: string): void;
  readonly submittingId?: string | null;
  readonly locale?: Locale;
}) {
  const [items, setItems] = useState([first, second]);
  const [editingId, setEditingId] = useState<string | null>(null);
  return <I18nProvider initial={locale}><MapDesignMessageQueue items={items} submittingId={submittingId} editingId={editingId}
    paused={false} disabled={false} onEdit={setEditingId} onCancelEdit={() => setEditingId(null)} onResume={vi.fn()}
    onSave={(id, prompt) => { onSave(id, prompt); setItems((current) => current.map((item) => item.id === id ? { ...item, prompt } : item)); setEditingId(null); }}
    onRemove={onRemove} /></I18nProvider>;
}

describe('MapDesignMessageQueue', () => {
  it('shows ordered pending content and lets users edit or delete a specific row', () => {
    const onSave = vi.fn(); const onRemove = vi.fn();
    render(<QueueHarness onSave={onSave} onRemove={onRemove} />);
    const region = screen.getByRole('region', { name: messageQueueCopy.en.title });
    expect(within(region).getByRole('status')).toHaveTextContent('2 queued');
    const rows = within(region).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining(first.prompt), expect.stringContaining(second.prompt)]);
    const row = rows.at(1);
    if (!row) throw new Error('Second queued row missing');
    expect(within(row).getByText('Attachments: 1')).toHaveAttribute('title', 'notes.txt');
    fireEvent.click(within(row).getByRole('button', { name: messageQueueCopy.en.remove }));
    expect(onRemove).toHaveBeenCalledWith('second');
    fireEvent.click(within(row).getByRole('button', { name: messageQueueCopy.en.edit }));
    const editor = screen.getByRole('textbox', { name: messageQueueCopy.en.editLabel });
    expect(editor).toHaveFocus();
    fireEvent.change(editor, { target: { value: '检查所有图层的中文名称' } });
    fireEvent.click(screen.getByRole('button', { name: messageQueueCopy.en.save }));
    expect(onSave).toHaveBeenCalledWith('second', '检查所有图层的中文名称');
    expect(within(row).getByRole('button', { name: messageQueueCopy.en.edit })).toHaveFocus();
  });

  it('discards an inline edit on Escape and restores action focus', () => {
    const onSave = vi.fn();
    render(<QueueHarness onSave={onSave} onRemove={vi.fn()} />);
    const edit = screen.getAllByRole('button', { name: messageQueueCopy.en.edit }).at(0);
    if (!edit) throw new Error('Edit action missing');
    fireEvent.click(edit);
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'Discard this change' } });
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText(first.prompt)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: messageQueueCopy.en.edit }).at(0)).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('protects IME composition and saves with Ctrl or Command Enter only', () => {
    const onSave = vi.fn();
    render(<QueueHarness onSave={onSave} onRemove={vi.fn()} />);
    const edit = screen.getAllByRole('button', { name: messageQueueCopy.en.edit }).at(0);
    if (!edit) throw new Error('Edit action missing');
    fireEvent.click(edit);
    const editor = screen.getByRole('textbox');
    fireEvent.keyDown(editor, { key: 'Enter' });
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true, isComposing: true });
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true, keyCode: 229 });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });
    expect(onSave).toHaveBeenCalledWith('first', first.prompt);
  });

  it('rejects empty or oversized edits and accepts the exact length boundary', () => {
    const onSave = vi.fn();
    render(<QueueHarness onSave={onSave} onRemove={vi.fn()} />);
    const edit = screen.getAllByRole('button', { name: messageQueueCopy.en.edit }).at(0);
    if (!edit) throw new Error('Edit action missing');
    fireEvent.click(edit);
    const editor = screen.getByRole('textbox');
    for (const value of ['   ', 'x'.repeat(16_385)]) {
      fireEvent.change(editor, { target: { value } });
      expect(screen.getByRole('button', { name: messageQueueCopy.en.save })).toBeDisabled();
      expect(editor).toHaveAttribute('aria-invalid', 'true');
      fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    }
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: 'x'.repeat(16_384) } });
    expect(screen.getByRole('button', { name: messageQueueCopy.en.save })).toBeEnabled();
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    expect(onSave).toHaveBeenCalledWith('first', 'x'.repeat(16_384));
  });

  it('locks only the submitting row and leaves later rows editable', () => {
    const onSave = vi.fn(); const onRemove = vi.fn();
    render(<QueueHarness onSave={onSave} onRemove={onRemove} submittingId="first" />);
    const rows = screen.getAllByRole('listitem');
    const sendingRow = rows.at(0); const pendingRow = rows.at(1);
    if (!sendingRow || !pendingRow) throw new Error('Queued rows missing');
    expect(sendingRow).toHaveAttribute('aria-busy', 'true');
    expect(within(sendingRow).getByRole('button', { name: messageQueueCopy.en.edit })).toBeDisabled();
    expect(within(sendingRow).getByRole('button', { name: messageQueueCopy.en.remove })).toBeDisabled();
    expect(within(pendingRow).getByRole('button', { name: messageQueueCopy.en.edit })).toBeEnabled();
    fireEvent.click(within(sendingRow).getByRole('button', { name: messageQueueCopy.en.remove }));
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('localizes pause and resume and renders nothing for an empty queue', () => {
    const onResume = vi.fn(); const copy = messageQueueCopy['zh-CN'];
    const props = { items: [first], submittingId: null, editingId: null, paused: true, disabled: false,
      onEdit: vi.fn(), onSave: vi.fn(), onCancelEdit: vi.fn(), onRemove: vi.fn(), onResume };
    const view = render(<I18nProvider initial="zh-CN"><MapDesignMessageQueue {...props} /></I18nProvider>);
    expect(screen.getByRole('region', { name: copy.title })).toBeInTheDocument();
    expect(screen.getByText(copy.paused)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.resume }));
    expect(onResume).toHaveBeenCalledOnce();
    view.rerender(<I18nProvider initial="zh-CN"><MapDesignMessageQueue {...props} items={[]} /></I18nProvider>);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
