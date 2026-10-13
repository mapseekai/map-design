import { Button } from '@mapseekai/components';
import { JsonEditor } from '@mapseekai/components/json-editor';
import { MAP_STYLE_DOCUMENT_MAX_BYTES, type MapStyleDocumentInput } from '@mapseekai/map-design-contracts';
import { validateStyleDocument } from 'maplibre-style-tools/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiClientError } from '../api/request';
import { useI18n } from '../i18n';
import { styleCodeCopy } from '../i18n/locales/style-code';
import { styleEditCopy } from '../i18n/locales/style-edit';
import { saveMapStyleDocument } from './style-edit/document-client';

interface Props {
  projectId: string; style: unknown; draftRevision: number; styleHash: string;
  readOnly: boolean; onSaved(): void | Promise<void>;
}
type Status = 'ready' | 'pending' | 'invalid' | 'saving' | 'error';

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
function textMatches(text: string, value: string): boolean {
  try { return canonical(JSON.parse(text)) === value; } catch { return false; }
}
const ignoreParsedChange = () => {};

export function MapDesignStyleCode({ projectId, style, draftRevision, styleHash, readOnly, onSaved }: Props) {
  const { locale, t } = useI18n();
  const copy = styleCodeCopy[locale];
  const [text, setText] = useState(() => JSON.stringify(style, null, 2));
  const [status, setStatus] = useState<Status>('ready');
  const [conflict, setConflict] = useState(false);
  const [cycle, setCycle] = useState(0);
  const [saving, setSaving] = useState(false);
  const [diagnostic, setDiagnostic] = useState('');
  const canonicalStyle = useMemo(() => canonical(style), [style]);
  const base = useRef({ draftRevision, styleHash, canonical: canonicalStyle });
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const latestText = useRef(text);
  latestText.current = text;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const retry = useRef<{ text: string; input: MapStyleDocumentInput } | null>(null);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // A delayed response from our own reload must not move the save base backwards.
  useEffect(() => {
    if (inFlight.current || draftRevision < base.current.draftRevision) return;
    if (draftRevision === base.current.draftRevision && styleHash === base.current.styleHash) return;
    if (!textMatches(latestText.current, base.current.canonical)) { setConflict(true); return; }
    base.current = { draftRevision, styleHash, canonical: canonicalStyle };
    setText(JSON.stringify(style, null, 2)); setStatus('ready'); retry.current = null;
  }, [draftRevision, styleHash, style, canonicalStyle, saving]);

  useEffect(() => {
    if (readOnly || conflict || inFlight.current) return;
    const timer = window.setTimeout(() => {
      if (textMatches(text, base.current.canonical)) { setStatus('ready'); return; }
      let value: unknown;
      try { value = JSON.parse(text); }
      catch { setStatus('invalid'); setDiagnostic(''); return; }
      const valid = validateStyleDocument(value, { maxStyleBytes: MAP_STYLE_DOCUMENT_MAX_BYTES });
      if (!valid.ok) {
        setStatus('invalid'); setDiagnostic(valid.errors[0]?.message ?? ''); return;
      }
      const input = retry.current?.text === text ? retry.current.input : {
        expectedRevision: base.current.draftRevision, styleHash: base.current.styleHash,
        idempotencyKey: globalThis.crypto.randomUUID(), style: valid.style,
      };
      retry.current = { text, input };
      inFlight.current = true; setSaving(true); setStatus('saving'); setDiagnostic('');
      void saveMapStyleDocument(projectId, input).then(async result => {
        if (!mounted.current) return;
        base.current = { draftRevision: result.draftRevision, styleHash: result.styleHash, canonical: canonical(input.style) };
        retry.current = null;
        setStatus(textMatches(latestText.current, base.current.canonical) ? 'ready' : 'pending');
        // Trigger the next queued edit only after this receipt advances its version base.
        inFlight.current = false; setSaving(false); setCycle(current => current + 1);
        try { await onSavedRef.current(); } catch { /* Events also refresh the authoritative draft. */ }
      }, error => {
        if (!mounted.current) return;
        inFlight.current = false; setSaving(false);
        if (error instanceof ApiClientError && error.status === 409) {
          setConflict(true);
          void Promise.resolve(onSavedRef.current()).catch(() => undefined);
        } else {
          setStatus(error instanceof ApiClientError && error.code === 'STYLE_INVALID' ? 'invalid' : 'error');
          setDiagnostic('');
        }
      });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [text, readOnly, conflict, cycle, projectId]);

  const reload = () => {
    base.current = { draftRevision, styleHash, canonical: canonicalStyle };
    retry.current = null; setText(JSON.stringify(style, null, 2)); setConflict(false); setStatus('ready'); setDiagnostic('');
    void Promise.resolve(onSavedRef.current()).catch(() => undefined);
  };
  const message = conflict ? copy.conflict : readOnly ? copy.readOnly
    : status === 'saving' ? styleEditCopy[locale].saving : status === 'error' ? styleEditCopy[locale].saveError : copy[status];
  return <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background" data-style-code-view>
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
      <span className="font-mono text-muted-foreground">style.json</span>
      <span role="status" className={conflict || status === 'invalid' || status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>{message}</span>
      {conflict ? <Button type="button" size="xs" variant="outline" disabled={saving} onClick={reload}>{copy.reload}</Button>
        : status === 'error' ? <Button type="button" size="xs" variant="outline" disabled={readOnly || saving} onClick={() => setCycle(current => current + 1)}>{t('mapDesign.conversation.retry')}</Button> : null}
      {diagnostic && status === 'invalid' ? <span className="w-full break-words text-destructive" dir="ltr">{diagnostic}</span> : null}
    </div>
    <div className="min-h-0 flex-1" dir="ltr">
      <JsonEditor value={style} text={text} readOnly={readOnly} onChange={ignoreParsedChange}
        onTextChange={next => { if (readOnly) return; setText(next); setStatus('pending'); setDiagnostic(''); }}
        ariaLabel="style.json" withScroll bordered={false} className="h-full" />
    </div>
  </div>;
}
