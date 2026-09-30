import { apiProfileFailureText } from '../../i18n/locales/api-profile-errors';
import { useEffect, useRef, useState } from 'react';
import { Plus, Check, Pencil, Trash2, PlugZap } from 'lucide-react';
import { Alert, AlertDescription, Badge, Button, Card, CardHeader, CardTitle, CardContent, DialogRoot, DialogContent,
  DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@mapseekai/components';
import type { MapApiProfile, MapApiProfileInput, MapApiProfilesResponse, MapApiConnectionTest, MapDesignAppConfig } from '@mapseekai/contracts';
import { useI18n } from '../../i18n';
import { apiProfilesCopy } from '../../i18n/locales/api-profiles';
import { API_PROFILES_CHANGED, ApiProfileClientError, apiProfilesRequest, profilesFromConfig } from '../api-profiles-client';
import { ApiProfileForm } from './ApiProfileForm';

type Editor = { id: string; input: MapApiProfileInput; baseline: string; hasApiKey: boolean; isNew: boolean };
function editProfile(profile?: MapApiProfile): Editor {
  const input: MapApiProfileInput = profile ? { name: profile.name, protocol: profile.protocol, apiFormat: profile.apiFormat,
    baseUrl: profile.baseUrl, model: profile.model, requiresApiKey: profile.requiresApiKey, apiKey: '' }
    : { name: '', protocol: 'openai', apiFormat: 'chat-completions', baseUrl: '', model: '', requiresApiKey: true, apiKey: '' };
  return { id: profile?.id ?? crypto.randomUUID(), input, baseline: JSON.stringify(input), hasApiKey: profile?.hasApiKey ?? false, isNew: !profile };
}
export function ApiProfileManager({ initialConfig, initialData, onChange, onDirtyChange, disabled = false }: { initialConfig: MapDesignAppConfig; initialData?: MapApiProfilesResponse; onChange?(data: MapApiProfilesResponse): void; onDirtyChange?(dirty: boolean): void; disabled?: boolean }) {
  const { locale, t } = useI18n(); const copy = apiProfilesCopy[locale];
  const [data, setData] = useState(() => initialData ?? profilesFromConfig(initialConfig));
  const [editor, setEditor] = useState<Editor | null>(() => (initialData ?? profilesFromConfig(initialConfig)).profiles.length ? null : editProfile());
  const [pendingDelete, setPendingDelete] = useState<MapApiProfile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ name: string; action: 'saved' | 'defaultLabel' | 'removed' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const refreshController = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); refreshController.current?.abort(); }, []);
  useEffect(() => { if (initialData) setData(initialData); }, [initialData]);
  const dirty = !!editor && JSON.stringify(editor.input) !== editor.baseline;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const locked = disabled || busy !== null;
  const refreshState = useRef({ dirty, disabled, onChange });
  refreshState.current = { dirty, disabled, onChange };
  useEffect(() => {
    const refresh = () => {
      if (refreshState.current.dirty || refreshState.current.disabled || controller.current) return;
      refreshController.current?.abort();
      const request = new AbortController(); refreshController.current = request;
      void apiProfilesRequest<MapApiProfilesResponse>('', 'GET', request.signal).then((result) => {
        if (request.signal.aborted || refreshState.current.dirty || controller.current) return;
        setData(result); refreshState.current.onChange?.(result);
        setEditor((current) => current && !current.isNew
          ? result.profiles.some((profile) => profile.id === current.id)
            ? editProfile(result.profiles.find((profile) => profile.id === current.id)) : null
          : current);
      }).catch(() => { /* Keep the last confirmed list when a passive refresh fails. */ });
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  async function perform(key: string, operation: (signal: AbortSignal) => Promise<void>) {
    if (disabled || controller.current) return;
    refreshController.current?.abort();
    const request = new AbortController(); controller.current = request; setBusy(key); setError(null); setNotice(null);
    try { await operation(request.signal); }
    catch (reason) { if (!request.signal.aborted) setError(reason instanceof ApiProfileClientError ? reason.code : 'API_REQUEST_FAILED'); }
    finally { if (controller.current === request) { controller.current = null; if (!request.signal.aborted) setBusy(null); } }
  }
  function updateData(result: MapApiProfilesResponse) { setData(result); onChange?.(result); window.dispatchEvent(new Event(API_PROFILES_CHANGED)); }
  async function save() {
    if (!editor || !dirty) return;
    const current = editor;
    if (!current.input.name.trim() || !current.input.model.trim() || (current.input.requiresApiKey && !current.hasApiKey && !current.input.apiKey?.trim())) {
      setError('INVALID_INPUT'); return;
    }
    await perform(`save:${current.id}`, async (signal) => {
      const { apiKey, ...fields } = current.input;
      const result = await apiProfilesRequest<MapApiProfilesResponse>(`/${current.id}`, 'PUT', signal,
        { ...fields, ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}) });
      if (signal.aborted) return;
      const saved = result.profiles.find((profile) => profile.id === current.id);
      if (!saved) throw new Error('Missing saved profile');
      updateData(result); setEditor(editProfile(saved)); setNotice({ name: saved.name, action: 'saved' });
    });
  }
  function activate(profile: MapApiProfile) {
    void perform(`activate:${profile.id}`, async (signal) => {
      const result = await apiProfilesRequest<MapApiProfilesResponse>(`/${profile.id}/activate`, 'POST', signal);
      if (signal.aborted) return;
      updateData(result); setNotice({ name: profile.name, action: 'defaultLabel' });
    });
  }
  function test(profile: MapApiProfile) {
    void perform(`test:${profile.id}`, async (signal) => {
      const connectionTest = await apiProfilesRequest<MapApiConnectionTest>(`/${profile.id}/test`, 'POST', signal);
      if (signal.aborted) return;
      updateData({ ...data, profiles: data.profiles.map((item) => item.id === profile.id ? { ...item, connectionTest } : item) });
    });
  }
  function remove(profile: MapApiProfile) {
    void perform(`delete:${profile.id}`, async (signal) => {
      const result = await apiProfilesRequest<MapApiProfilesResponse>(`/${profile.id}`, 'DELETE', signal);
      if (signal.aborted) return;
      updateData(result); if (editor?.id === profile.id) setEditor(null);
      setPendingDelete(null); setNotice({ name: profile.name, action: 'removed' });
    });
  }
  return <section className="grid gap-4" aria-label={copy.title} aria-busy={busy !== null}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="grid gap-1">
      <h2 className="text-lg font-semibold">{copy.title}</h2><p className="max-w-xl text-sm text-muted-foreground">{copy.hint}</p></div>
      <Button type="button" variant="outline" disabled={locked || dirty || data.profiles.length >= 32} title={dirty ? copy.saveFirst : undefined}
        onClick={() => { setEditor(editProfile()); setError(null); setNotice(null); }}><Plus data-icon="inline-start" />{copy.add}</Button>
    </div>
    {notice ? <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm"><Check className="size-4" />{notice.name}：{copy[notice.action]}</p> : null}
    {error ? <Alert variant="destructive"><AlertDescription>{apiProfileFailureText(locale, error)} <span className="text-xs">({error})</span></AlertDescription></Alert> : null}
    {!data.profiles.length ? <p className="text-sm text-muted-foreground">{copy.empty}</p> : null}
    <div className="grid gap-3">
      {data.profiles.map((profile) => <Card key={profile.id} data-profile-id={profile.id}>
        <CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle>{profile.name}</CardTitle>
          {data.activeProfileId === profile.id ? <Badge variant="secondary">{copy.defaultLabel}</Badge> : null}</div></CardHeader>
        <CardContent><div className="grid gap-3">
          <div className="grid gap-1 text-sm"><p className="break-all font-mono">{profile.model || '—'}</p>
            <p className="break-all text-xs text-muted-foreground">{profile.protocol} · {profile.apiFormat} · {profile.baseUrl || (profile.protocol === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1')}</p>
            <p className="text-xs text-muted-foreground">{profile.hasApiKey ? copy.keySaved : profile.requiresApiKey ? copy.requiresKey : copy.noKey}</p></div>
          <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant={profile.connectionTest?.status === 'failed' ? 'destructive' : 'outline'}>{busy === `test:${profile.id}` ? copy.testing : !profile.connectionTest ? copy.untested : profile.connectionTest.status === 'passed' ? copy.passed : copy.failed}</Badge>
            {profile.connectionTest ? <span>{new Date(profile.connectionTest.testedAt).toLocaleString(locale)} · {profile.connectionTest.latencyMs} ms {profile.connectionTest.code ? `· ${profile.connectionTest.code}` : ''}</span> : null}
          </div>
          {profile.connectionTest?.status === 'failed' && profile.connectionTest.code ? <p className="text-sm" role="alert">{apiProfileFailureText(locale, profile.connectionTest.code)}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={locked || dirty || data.activeProfileId === profile.id} onClick={() => activate(profile)}>{copy.activate}</Button>
            <Button type="button" size="sm" variant="outline" disabled={locked || dirty} title={dirty ? copy.saveFirst : copy.cost} onClick={() => test(profile)}><PlugZap data-icon="inline-start" />{copy.test}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={locked || dirty} onClick={() => { setEditor(editProfile(profile)); setError(null); setNotice(null); }}><Pencil data-icon="inline-start" />{copy.edit}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={locked || dirty} onClick={() => setPendingDelete(profile)}><Trash2 data-icon="inline-start" />{t('common.delete')}</Button>
          </div>
        </div></CardContent>
      </Card>)}
    </div>
    {editor ? <Card><CardHeader><CardTitle>{editor.isNew ? copy.add : `${copy.edit} · ${editor.input.name}`}</CardTitle></CardHeader><CardContent>
      <ApiProfileForm value={editor.input} hasApiKey={editor.hasApiKey} disabled={locked} dirty={dirty} isNew={editor.isNew}
        onChange={(input) => { setEditor({ ...editor, input }); setNotice(null); setError(null); }} onSave={() => { void save(); }}
        onCancel={() => { setEditor(null); setNotice(null); setError(null); }} />
    </CardContent></Card> : null}
    <p className="text-xs text-muted-foreground">{dirty ? `${copy.saveFirst} ` : ''}{copy.cost}</p>
    <DialogRoot open={pendingDelete !== null} onOpenChange={(open) => { if (!open && !locked) setPendingDelete(null); }}>
      <DialogContent closeLabel={t('common.close')}><DialogHeader><DialogTitle>{t('common.delete')} · {pendingDelete?.name}</DialogTitle>
        <DialogDescription>{copy.removeHint}</DialogDescription></DialogHeader>
        <DialogFooter><Button type="button" variant="outline" disabled={locked} onClick={() => setPendingDelete(null)}>{copy.cancel}</Button>
          <Button type="button" variant="destructive" disabled={locked} onClick={() => { if (pendingDelete) remove(pendingDelete); }}>{t('common.delete')}</Button></DialogFooter>
      </DialogContent>
    </DialogRoot>
  </section>;
}
