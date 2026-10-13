import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogFooter, DialogHeader, DialogTitle, Field, FieldLabel, Input } from '@mapseekai/components';
import type { CartographyEditSave, CartographyEditSession } from '@mapseekai/map-design-contracts';
import { ApiClientError } from '../../api/request';
import { useI18n } from '../../i18n';
import { cartographyManagerCopy } from '../../i18n/locales/cartography';
import { cartographyEditorCopy } from '../../i18n/locales/cartography-editor';
import { cartographySaveCopy } from '../../i18n/locales/cartography-save';
import { rememberCartographyEdit, saveCartographyEdit } from '../cartography-edit-client';

export function CartographySaveActions({ session, disabled, onSaved, onBusyChange }: {
  readonly session: CartographyEditSession;
  readonly disabled: boolean;
  readonly onSaved: (session: CartographyEditSession) => void;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const { locale, t } = useI18n();
  const copy = cartographySaveCopy[locale];
  const editor = cartographyEditorCopy[locale];
  const manager = cartographyManagerCopy[locale];
  const isNew = !session.savedId && !session.sourceDocumentId;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<'failed' | 'duplicate' | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function save(request: CartographyEditSave) {
    if (pending.current || disabled) return;
    pending.current = true; setSaving(true); setError(null); onBusyChange(true);
    try {
      const result = await saveCartographyEdit(session.id, request);
      if (alive.current) {
        rememberCartographyEdit(result.document.id, result.session.id);
        onSaved(result.session); setOpen(false);
      }
    } catch (failure) {
      const details = failure instanceof ApiClientError ? failure.details : null;
      const duplicate = details !== null && typeof details === 'object' && 'reason' in details && details.reason === 'CARTOGRAPHY_EXISTS';
      if (alive.current) {
        setError(duplicate ? 'duplicate' : 'failed');
        if (duplicate && isNew && !open) { setName(session.name); setOpen(true); }
      }
    } finally {
      pending.current = false;
      if (alive.current) { setSaving(false); onBusyChange(false); }
    }
  }

  return <>
    {isNew || session.canOverwrite ? <Button type="button" disabled={disabled || saving || session.savedRevision === session.revision} onClick={() => {
      void save(isNew
        ? { expectedRevision: session.revision, mode: 'new', name: session.name }
        : { expectedRevision: session.revision, mode: 'overwrite' });
    }}>{copy.save}</Button> : null}
    {!isNew ? <Button type="button" variant={session.canOverwrite ? 'outline' : 'default'} disabled={disabled || saving} onClick={() => {
      setName(`${session.name.slice(0, 230)} ${copy.copySuffix}`); setError(null); setOpen(true);
    }}>{editor.saveNew}</Button> : null}
    {error && !open ? <p role="alert" className="w-full text-sm text-destructive">{copy[error]}</p> : null}
    {open ? <Dialog ariaLabelledBy="save-cartography-title" onClose={() => { if (!saving) setOpen(false); }} closeOnEscape={!saving} closeOnBackdrop={!saving} initialFocus={input}>
      <form className="flex flex-col gap-4" onSubmit={event => {
        event.preventDefault();
        if (!name.trim()) return;
        void save({ expectedRevision: session.revision, mode: 'new', name: name.trim() });
      }}>
        <DialogHeader><DialogTitle id="save-cartography-title">{isNew ? copy.save : editor.saveNew}</DialogTitle></DialogHeader>
        <Field><FieldLabel htmlFor="save-cartography-name">{manager.name}</FieldLabel><Input ref={input} id="save-cartography-name" value={name} onChange={event => setName(event.target.value)} maxLength={256} required disabled={saving} /></Field>
        {error ? <p role="alert" className="text-sm text-destructive">{copy[error]}</p> : null}
        <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>{manager.cancel}</Button><Button type="submit" disabled={disabled || saving || !name.trim()}>{saving ? t('common.loading') : isNew ? copy.save : editor.saveNew}</Button></DialogFooter>
      </form>
    </Dialog> : null}
  </>;
}
