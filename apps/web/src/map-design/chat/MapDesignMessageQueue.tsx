import { Button, Textarea } from '@mapseekai/components';
import { ListOrdered, Paperclip, Pencil, X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import { useI18n } from '../../i18n';
import { messageQueueCopy } from '../../i18n/locales/message-queue';
import type { PendingMapMessage } from './useQueuedMapMessages';

type QueueCopy = (typeof messageQueueCopy)['en'];

interface MessageQueueProps {
  readonly items: readonly PendingMapMessage[];
  readonly submittingId: string | null;
  readonly editingId: string | null;
  readonly paused: boolean;
  readonly disabled: boolean;
  readonly resumeDisabled?: boolean;
  onEdit(id: string): void;
  onSave(id: string, prompt: string): void;
  onCancelEdit(): void;
  onRemove(id: string): void;
  onResume(): void;
}

export function MapDesignMessageQueue(props: MessageQueueProps) {
  const { locale } = useI18n();
  const copy = messageQueueCopy[locale];
  const format = new Intl.NumberFormat(locale);
  if (!props.items.length) return null;
  return <section aria-label={copy.title} className="min-w-0 shrink-0 overflow-hidden rounded-lg border bg-muted/30">
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
      <ListOrdered aria-hidden="true" className="size-4 shrink-0" />
      <span role="status" aria-live="polite" aria-atomic="true">{copy.count.replace('{count}', format.format(props.items.length))}</span>
      <span className="ms-auto">{props.paused || props.editingId ? copy.paused : copy.hint}</span>
      {props.paused ? <Button type="button" size="xs" variant="outline" disabled={props.disabled || props.resumeDisabled || Boolean(props.editingId)} onClick={props.onResume}>{copy.resume}</Button> : null}
    </div>
    <ol className="max-h-60 overflow-y-auto overscroll-contain border-t">
      {props.items.map((item, index) => <QueueRow key={item.id} item={item} position={format.format(index + 1)} copy={copy}
        editing={props.editingId === item.id} submitting={props.submittingId === item.id} disabled={props.disabled}
        onEdit={props.onEdit} onSave={props.onSave} onCancelEdit={props.onCancelEdit} onRemove={props.onRemove} />)}
    </ol>
  </section>;
}

interface QueueRowProps extends Pick<MessageQueueProps, 'disabled' | 'onEdit' | 'onSave' | 'onCancelEdit' | 'onRemove'> {
  readonly item: PendingMapMessage;
  readonly position: string;
  readonly copy: QueueCopy;
  readonly editing: boolean;
  readonly submitting: boolean;
}

function QueueRow({ item, position, copy, editing, submitting, disabled, onEdit, onSave, onCancelEdit, onRemove }: QueueRowProps) {
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(editing);
  useLayoutEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const attachmentCount = item.screenshots.length + item.attachments.length;
  const locked = disabled || submitting;
  return <li className="flex min-w-0 items-start gap-2 border-b px-3 py-2 last:border-b-0" aria-busy={submitting}>
    <span aria-hidden="true" className="pt-2 text-xs tabular-nums text-muted-foreground">{position}</span>
    <div className="min-w-0 flex-1">
      {editing ? <QueueEditor prompt={item.prompt} copy={copy} disabled={locked} onSave={(prompt) => onSave(item.id, prompt)} onCancel={onCancelEdit} />
        : <div className="flex min-w-0 items-start gap-2">
          <p title={item.prompt} className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap break-words py-1 text-sm [overflow-wrap:anywhere] [text-wrap:balance]">{item.prompt}</p>
          <div className="flex shrink-0 items-center gap-1">
            <Button ref={editButton} type="button" size="icon-sm" variant="ghost" aria-label={copy.edit} title={copy.edit} disabled={locked} onClick={() => onEdit(item.id)}><Pencil aria-hidden="true" /></Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label={copy.remove} title={copy.remove} disabled={locked} onClick={() => onRemove(item.id)}><X aria-hidden="true" /></Button>
          </div>
        </div>}
      {attachmentCount ? <p className="flex items-center gap-1 text-xs text-muted-foreground" title={item.attachments.map(({ fileName }) => fileName).join(', ')}>
        <Paperclip aria-hidden="true" className="size-3 shrink-0" />{copy.attachments.replace('{count}', String(attachmentCount))}
      </p> : null}
      {submitting ? <p role="status" className="text-xs text-muted-foreground">{copy.submitting}</p> : null}
    </div>
  </li>;
}

function QueueEditor({ prompt, copy, disabled, onSave, onCancel }: {
  readonly prompt: string;
  readonly copy: QueueCopy;
  readonly disabled: boolean;
  onSave(prompt: string): void;
  onCancel(): void;
}) {
  const { locale } = useI18n();
  const [draft, setDraft] = useState(prompt);
  const input = useRef<HTMLTextAreaElement>(null);
  const errorId = useId();
  const valid = Boolean(draft.trim()) && draft.length <= 16_384;
  useLayoutEffect(() => { input.current?.focus(); }, []);
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (valid && !disabled) onSave(draft);
    }
  };
  return <div className="flex min-w-0 flex-col gap-2 py-1">
    <Textarea ref={input} aria-label={copy.editLabel} aria-invalid={!valid} aria-describedby={valid ? undefined : errorId}
      className="max-h-40 resize-y" value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} />
    {!valid ? <p id={errorId} role="alert" className="text-xs text-destructive">{copy.limit.replace('{limit}', new Intl.NumberFormat(locale).format(16_384))}</p> : null}
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" size="xs" variant="ghost" onClick={onCancel}>{copy.cancel}</Button>
      <Button type="button" size="xs" variant="secondary" disabled={!valid || disabled} onClick={() => onSave(draft)}>{copy.save}</Button>
    </div>
  </div>;
}
