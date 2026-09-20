// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MapDesignConversationHeader } from '../../../src/map-design/chat/MapDesignConversationHeader';
import { I18nProvider } from '../../../src/i18n';

const conversations = [
  { conversationId: 'conversation-3', projectId: 'map-1', title: 'Newest study', titleIsDefault: false, messageCount: 4, createdAt: '2026-08-28T00:00:00.000Z', lastActivityAt: '2026-08-28T03:00:00.000Z', runState: 'running' as const },
  { conversationId: 'conversation-2', projectId: 'map-1', title: 'Contour review', titleIsDefault: false, messageCount: 2, createdAt: '2026-08-28T00:00:00.000Z', lastActivityAt: '2026-08-28T02:00:00.000Z', runState: 'idle' as const },
  { conversationId: 'conversation-1', projectId: 'map-1', title: 'Initial survey', titleIsDefault: false, messageCount: 1, createdAt: '2026-08-28T00:00:00.000Z', lastActivityAt: '2026-08-28T01:00:00.000Z', runState: 'idle' as const },
];

describe('MapDesignConversationHeader', () => {
  afterEach(cleanup);
  it('confirms deleting the selected conversation and preserves the dialog on failure', async () => {
    const onDelete = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(true);
    render(<MapDesignConversationHeader conversations={conversations} selectedId="conversation-2" creating={false} error={null}
      onSelect={vi.fn()} onCreate={vi.fn()} onCollapse={vi.fn()} onDelete={onDelete} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Project conversations' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete conversation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete conversation' });
    expect(dialog).toHaveTextContent('Contour review');
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete conversation' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete conversation' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onDelete).toHaveBeenLastCalledWith('conversation-2');
  });

  it('distinguishes the conversation menu trigger from the create-conversation action', () => {
    const defaultConversation = [{ ...conversations[1]!, title: 'New conversation', titleIsDefault: true }];
    render(<MapDesignConversationHeader conversations={defaultConversation} selectedId="conversation-2" creating={false} error={null}
      onSelect={vi.fn()} onCreate={vi.fn()} onCollapse={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Project conversations' })).toHaveTextContent('New conversation');
    expect(screen.getAllByRole('button', { name: 'New conversation' })).toHaveLength(1);
  });

  it('supports Arrow keys, Home, End, Enter, and Escape in the conversation listbox', async () => {
    const onSelect = vi.fn();
    render(<MapDesignConversationHeader conversations={conversations} selectedId="conversation-2" creating={false} error={null}
      onSelect={onSelect} onCreate={vi.fn()} onCollapse={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: 'Project conversations' });
    fireEvent.click(trigger);
    const listbox = screen.getByRole('listbox', { name: 'Project conversations' });
    expect(within(listbox).getAllByRole('option')).toHaveLength(3);
    expect(within(listbox).queryByRole('button', { name: 'New conversation' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New conversation' })).toHaveLength(2);
    expect(within(listbox).getByRole('option', { name: /Newest study/u }).querySelector('time')).toHaveAttribute('dateTime', '2026-08-28T03:00:00.000Z');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('option', { name: /Contour review/u })));

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('option', { name: /Initial survey/u }));
    fireEvent.keyDown(listbox, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByRole('option', { name: /Newest study/u }));
    fireEvent.keyDown(listbox, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('option', { name: /Initial survey/u }));
    fireEvent.keyDown(listbox, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('conversation-1');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('exposes stable two-row conversation metadata without merging title, time, count, and run state', () => {
    const menuConversations = [
      {
        ...conversations[0]!,
        title: 'Very long map redesign title',
        messageCount: 2,
        lastActivityAt: '2026-08-30T00:00:00.000Z',
      },
      conversations[1]!,
    ];
    render(<MapDesignConversationHeader conversations={menuConversations} selectedId="conversation-3" creating={false} error={null}
      onSelect={vi.fn()} onCreate={vi.fn()} onCollapse={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Project conversations' }));
    const option = screen.getByRole('option', { name: /Very long map redesign title/u });

    expect(option.querySelector('[data-conversation-title]')).toHaveTextContent('Very long map redesign title');
    expect(option.querySelector('[data-conversation-time]')).toHaveAttribute('dateTime', '2026-08-30T00:00:00.000Z');
    expect(option.querySelector('[data-conversation-count]')).toHaveTextContent('2 messages');
    expect(option.querySelector('[data-conversation-run]')).toHaveTextContent('Running');
    expect(option.querySelector('[data-conversation-run-dot]')).toHaveAttribute('aria-hidden', 'true');
    expect(option).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps creation separate, announces creation errors, and surfaces active run state', () => {
    const onCreate = vi.fn();
    render(<MapDesignConversationHeader conversations={conversations} selectedId="conversation-3" creating={false}
      error="The local daemon is unavailable." onSelect={vi.fn()} onCreate={onCreate} onCollapse={vi.fn()} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'New conversation' }).at(-1)!);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('The local daemon is unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Project conversations' }));
    expect(screen.getByRole('option', { name: /Newest study.*Running/u })).toBeInTheDocument();
  });

  it('labels and announces an in-progress conversation creation', () => {
    render(<MapDesignConversationHeader conversations={conversations} selectedId="conversation-3" creating error={null}
      onSelect={vi.fn()} onCreate={vi.fn()} onCollapse={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Creating conversation' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Creating conversation');
  });

  it('disables header, creation, and retry controls while historical mode is read-only', () => {
    render(<MapDesignConversationHeader conversations={conversations} selectedId="conversation-3" creating={false}
      error="Temporary failure" readOnly onSelect={vi.fn()} onCreate={vi.fn()} onCollapse={vi.fn()} onRetry={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Project conversations' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Collapse chat' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });

  it('does not offer an operational retry for the missing-conversation fallback notice', () => {
    render(<MapDesignConversationHeader conversations={conversations} selectedId="conversation-3" creating={false}
      error={null} notice="The requested conversation is unavailable. Showing the newest conversation."
      onSelect={vi.fn()} onCreate={vi.fn()} onCollapse={vi.fn()} onRetry={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('The requested conversation is unavailable.');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('localizes RTL accessible names and substitutes only durable default titles', () => {
    const localized = [
      { ...conversations[0]!, title: 'New conversation', titleIsDefault: true },
      { ...conversations[1]!, title: 'ألوان الطرق', titleIsDefault: false },
    ];
    render(<I18nProvider initial="ar"><MapDesignConversationHeader
      conversations={localized} selectedId="conversation-3" creating={false} error="خطأ مؤقت"
      onSelect={vi.fn()} onCreate={vi.fn()} onCollapse={vi.fn()} onRetry={vi.fn()}
    /></I18nProvider>);

    const trigger = screen.getByRole('button', { name: 'محادثات المشروع' });
    expect(trigger).toHaveTextContent('محادثة جديدة');
    expect(screen.getByRole('button', { name: 'محادثة جديدة' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'طيّ المحادثة' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeInTheDocument();

    fireEvent.click(trigger);
    const listbox = screen.getByRole('listbox', { name: 'محادثات المشروع' });
    expect(within(listbox).getByRole('option', { name: /ألوان الطرق/u })).toHaveTextContent('ألوان الطرق');
    expect(within(listbox).getByRole('option', { name: /الرسائل: 4/u })).toBeInTheDocument();
  });
});
