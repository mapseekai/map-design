import { TitlebarControl } from '../components/MapDesignTitlebar';
import { Button, Popover, PopoverTrigger, PopoverContent, DialogRoot, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@mapseekai/components';
import type { MapDesignConversationSummary } from '@mapseekai/contracts';
import { Bot, ChevronDown, PanelLeftClose, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { useI18n } from '../../i18n';
import { conversationActionsCopy } from '../../i18n/locales/conversation-actions';
import { ApiClientError } from '../../api/client';

export interface MapDesignConversationHeaderProps {
  conversations: readonly MapDesignConversationSummary[];
  selectedId: string;
  creating: boolean;
  readOnly?: boolean;
  error: string | null;
  notice?: string | null;
  onSelect(conversationId: string): void;
  onDelete?(conversationId: string): Promise<boolean>;
  onCreate?(): void;
  onCollapse?(): void;
  onRetry?(): void;
}

function formatActivityTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function MapDesignConversationHeader({
  conversations, selectedId, creating, readOnly = false, error, notice, onSelect, onCreate, onCollapse, onRetry, onDelete,
}: MapDesignConversationHeaderProps) {
  const { locale, t } = useI18n();
  const copy = conversationActionsCopy[locale];
  const [deleteTarget, setDeleteTarget] = useState<MapDesignConversationSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef(new Map<string, HTMLElement>());
  const selected = conversations.find((conversation) => conversation.conversationId === selectedId) ?? conversations[0];

  useEffect(() => {
    if (!open) return;
    optionRefs.current.get(conversations[activeIndex]?.conversationId ?? selectedId)?.focus();
  }, [activeIndex, conversations, open, selectedId]);

  if (!selected) return null;
  const titleFor = (conversation: MapDesignConversationSummary) => conversation.titleIsDefault
    ? t('mapDesign.conversation.defaultTitle') : conversation.title;
  const countFor = (count: number) => t(count === 1
    ? 'mapDesign.conversation.messageCountOne'
    : 'mapDesign.conversation.messageCountMany', { count: new Intl.NumberFormat(locale).format(count) });

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const select = (conversationId: string) => {
    if (readOnly) return;
    onSelect(conversationId);
    close();
  };
  const openList = () => {
    if (readOnly) return;
    const index = conversations.findIndex((conversation) => conversation.conversationId === selectedId);
    setActiveIndex(Math.max(0, index));
    setOpen(true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const active = conversations[activeIndex];
      if (active) select(active.conversationId);
      return;
    }
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = (activeIndex + 1) % conversations.length;
    else if (event.key === 'ArrowUp') nextIndex = (activeIndex - 1 + conversations.length) % conversations.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = conversations.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setActiveIndex(nextIndex);
  };

  return <><Popover open={open} onOpenChange={(next) => next ? openList() : close()}><header style={{ minHeight: 'var(--chat-header-height, var(--studio-header-height))' }} className="relative grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 border-b bg-background px-3 py-2 text-foreground">
    <span className="grid size-8 place-items-center rounded-lg bg-muted text-primary" aria-hidden="true"><Bot size={16} strokeWidth={1.8} /></span>
    <div className="grid min-w-0 gap-0.5">
      <PopoverTrigger render={<Button variant="ghost" size="sm" className="min-w-0 justify-between" />} ref={triggerRef} type="button" aria-haspopup="listbox"
        aria-label={t('mapDesign.conversation.listLabel')}
        aria-expanded={open} aria-controls="map-design-conversation-list" disabled={readOnly}>
        <span className="truncate">{titleFor(selected)}</span>
        {selected.runState === 'running' ? <span className="size-2 shrink-0 rounded-full bg-primary" aria-label={t('mapDesign.conversation.running')} /> : null}
        <ChevronDown data-icon="inline-end" aria-hidden="true" />
      </PopoverTrigger>

    </div>
    {onCreate ? <Button variant="ghost" type="button" size="icon" className="shrink-0" aria-label={creating ? t('mapDesign.conversation.creating') : t('mapDesign.conversation.defaultTitle')} disabled={creating || readOnly} onClick={onCreate}>
      <Plus data-icon="inline-start" aria-hidden="true" />
    </Button> : null}
    {onCollapse ? <TitlebarControl><Button variant="ghost" type="button" size="icon" className="shrink-0" aria-label={t('mapDesign.conversation.collapse')} disabled={readOnly} onClick={onCollapse}>
      <PanelLeftClose data-icon="inline-start" aria-hidden="true" />
    </Button></TitlebarControl> : null}
    {creating ? <p className="sr-only" role="status">{t('mapDesign.conversation.creatingStatus')}</p> : null}
    {error ? <div className="col-span-full flex items-center gap-2 text-xs text-destructive" role="status"><span>{error}</span>
      {onRetry ? <Button variant="ghost" type="button" disabled={readOnly} onClick={onRetry}>{t('mapDesign.conversation.retry')}</Button> : null}
    </div> : null}
    {notice ? <p className="col-span-full flex items-center gap-2 text-xs text-destructive" role="status">{notice}</p> : null}
    <PopoverContent align="start" size="sm" className="w-[min(360px,calc(100vw-24px))]" initialFocus={() => optionRefs.current.get(conversations[activeIndex]?.conversationId ?? selectedId) ?? false}>
      <div id="map-design-conversation-list" role="listbox" aria-label={t('mapDesign.conversation.listLabel')}
        className="grid max-h-[min(360px,55dvh)] overflow-auto" onKeyDown={onKeyDown}>
        {conversations.map((conversation, index) => <Button variant={conversation.conversationId === selectedId ? "secondary" : "ghost"} type="button" role="option" key={conversation.conversationId}
          ref={(node) => { if (node) optionRefs.current.set(conversation.conversationId, node); else optionRefs.current.delete(conversation.conversationId); }}
          aria-selected={conversation.conversationId === selectedId} tabIndex={index === activeIndex ? 0 : -1}
          size="content" className="min-h-14 w-full" disabled={readOnly} onFocus={() => setActiveIndex(index)} onClick={() => select(conversation.conversationId)}>
          <span className="grid min-w-0 w-full grid-cols-[minmax(0,1fr)_max-content] items-center gap-x-2.5 gap-y-1 text-left">
          <span className="col-start-1 row-start-1 min-w-0 truncate" data-conversation-title>{titleFor(conversation)}</span>
          <time className="col-start-1 row-start-2 min-w-0 truncate text-xs text-muted-foreground" data-conversation-time dateTime={conversation.lastActivityAt}>{formatActivityTime(conversation.lastActivityAt, locale)}</time>
          <span className="col-start-2 row-start-1 whitespace-nowrap text-xs text-muted-foreground" data-conversation-count>{countFor(conversation.messageCount)}</span>
          {conversation.runState === 'running' ? <span className="col-start-2 row-start-2 inline-flex items-center gap-1 whitespace-nowrap text-xs text-primary" data-conversation-run>
            <span className="size-1.5 shrink-0 rounded-full bg-primary" data-conversation-run-dot aria-hidden="true" />
            {t('mapDesign.conversation.running')}
          </span> : null}
          </span>
        </Button>)}
      </div>
      <div className="mt-1 flex items-center gap-1">
      {onCreate ? <Button variant="ghost" type="button" className="flex-1 justify-start" disabled={creating || readOnly} onClick={() => { if (readOnly) return; onCreate(); close(); }}>
        <Plus data-icon="inline-start" aria-hidden="true" /> {t('mapDesign.conversation.defaultTitle')}
      </Button> : null}
      {onDelete ? <Button variant="ghost" type="button" className="flex-1 justify-start" disabled={readOnly || creating || deleting || selected.runState === 'running'}
        title={selected.runState === 'running' ? copy.running : undefined}
        onClick={() => { setDeleteTarget(selected); setDeleteError(null); close(); }}>
        <Trash2 data-icon="inline-start" aria-hidden="true" />{copy.delete}
      </Button> : null}
      </div>
    </PopoverContent>
  </header></Popover>
    <DialogRoot open={deleteTarget !== null} onOpenChange={(next) => { if (!next && !deleting) setDeleteTarget(null); }}>
      <DialogContent showCloseButton={false} initialFocus={cancelRef} finalFocus={triggerRef}>
        <DialogHeader><DialogTitle>{copy.delete}</DialogTitle><DialogDescription>{copy.description}</DialogDescription></DialogHeader>
        <p className="break-words text-sm">{deleteTarget ? titleFor(deleteTarget) : ''}</p>
        {deleteError ? <p role="alert" className="text-sm text-destructive">{deleteError}</p> : null}
        <DialogFooter>
          <Button ref={cancelRef} type="button" variant="outline" disabled={deleting} onClick={() => setDeleteTarget(null)}>{copy.cancel}</Button>
          <Button type="button" variant="destructive" disabled={deleting || readOnly} onClick={async () => {
            if (!deleteTarget || !onDelete || deleting) return;
            setDeleting(true); setDeleteError(null);
            try { if (await onDelete(deleteTarget.conversationId)) setDeleteTarget(null); }
            catch (error) { setDeleteError(error instanceof ApiClientError && error.code === 'RUNTIME_CONFLICT' ? copy.running : copy.error); }
            finally { setDeleting(false); }
          }}>{deleting ? t('common.loading') : copy.delete}</Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  </>;
}
