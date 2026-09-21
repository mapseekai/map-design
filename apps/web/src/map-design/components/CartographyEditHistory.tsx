import { useEffect, useState } from 'react';
import { Button } from '@mapseekai/components';
import { useI18n } from '../../i18n';
import { navigate } from '../../router';
import { cartographyEditorCopy } from '../../i18n/locales/cartography-editor';
import { listCartographyEditHistory, rememberCartographyEdit } from '../cartography-edit-client';

export function CartographyEditHistory({ documentId, sessionId }: { documentId: string; sessionId?: string }) {
  const { t, locale } = useI18n();
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof listCartographyEditHistory>>['sessions']>([]);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setSessions([]); setFailed(false);
    void listCartographyEditHistory(documentId, controller.signal).then((result) => {
      if (!controller.signal.aborted) setSessions(result.sessions);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [documentId, open]);
  return <details className="relative" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer rounded-md px-3 py-2 text-sm">{t('mapDesign.conversation.listLabel')}</summary>
    <div className="absolute end-0 top-full z-20 flex max-h-64 w-72 flex-col gap-1 overflow-auto rounded-lg border bg-popover p-2 shadow-md">
      {failed ? <p role="alert" className="p-2 text-sm">{cartographyEditorCopy[locale].failed}</p> : null}
      {sessions.map((session) => <Button key={session.id} type="button" variant={session.id === sessionId ? 'secondary' : 'ghost'} className="h-auto justify-start whitespace-normal text-start" onClick={() => {
        rememberCartographyEdit(documentId, session.id);
        setOpen(false);
        navigate({ kind: 'cartography-editor', sessionId: session.id });
      }}>{session.name} · {new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(session.createdAt))} · r{session.revision}</Button>)}
    </div>
  </details>;
}
