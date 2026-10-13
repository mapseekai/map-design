import { isSelectableAgent } from './agent-availability';
import { MapLoading, Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@mapseekai/components';
import { Plus, BookOpen, ExternalLink, Trash2, LoaderCircle, Pencil } from 'lucide-react';
import { projectRenameCopy } from '../i18n/locales/project-rename';
import { updateCartography } from './client';
import { ApiClientError } from '../api/request';
import { CartographyDocumentPreview } from './components/CartographyDocumentPreview';
import { CartographyVisualPreview } from './components/CartographyVisualPreview';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { cartographyLibraryCopy } from '../i18n/locales/cartography-library';
import { cartographyEditorCopy } from '../i18n/locales/cartography-editor';
import { createCartographyEdit, listActiveCartographyEdits, listCartographyEditHistory, lastCartographyEdit, rememberCartographyEdit } from './cartography-edit-client';
import { CartographyEditHistory } from './components/CartographyEditHistory';
import { AgentModelFields } from './components/AgentModelFields';
import { useLocalAgents } from './hooks/useLocalAgents';
import { apiModelCopy } from '../i18n/locales/api-model';
import { Alert, AlertDescription, Button, Input, Textarea, Field, FieldLabel, FieldSet, Empty, EmptyHeader, EmptyDescription, Tabs, TabsList, TabsTrigger, TabsContent } from '@mapseekai/components';
import { CARTOGRAPHY_MAX_BYTES, CARTOGRAPHY_STYLE_MAX_BYTES, type CartographyDraft, type CartographySummary, type CartographyStyleFile } from '@mapseekai/map-design-contracts';
import { navigate } from '../router';
import { useI18n } from '../i18n';
import { cartographyCopy, cartographyManagerCopy } from '../i18n/locales/cartography';
import { deleteCartography, getCartography, importCartography, importCartographyUrl, initializeCartography, initializeCartographyUrl, listCartographies } from './client';

type Mode = 'upload' | 'online' | 'style' | 'ai';

export function CartographyManager() {
  const { locale, t } = useI18n();
  const copy = cartographyCopy[locale];
  const apiCopy = apiModelCopy[locale];
  const { agents, loading: agentsLoading, error: agentsError } = useLocalAgents();
  const [generationAgent, setGenerationAgent] = useState('');
  const [generationModel, setGenerationModel] = useState('');
  const generationRuntime = generationAgent === 'codex' ? 'codex' : 'api';
  const selectedAgent = agents.find(agent => agent.id === generationAgent && isSelectableAgent(agent));
  const apiModels = selectedAgent?.models?.filter(model => model.enabled) ?? [];
  const selectedModel = generationModel ? apiModels.find(model => model.id === generationModel) : apiModels.find(model => model.default) ?? apiModels[0];
  const hasSelectableModel = selectedAgent?.models?.length ? Boolean(selectedModel) : generationAgent !== 'api';
  const canGenerate = !!selectedAgent && selectedAgent.mapDesign.nativeMapTools && hasSelectableModel;

  const text = cartographyManagerCopy[locale];
  const library = cartographyLibraryCopy[locale];
  const editor = cartographyEditorCopy[locale];
  const [createOpen, setCreateOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<'user' | 'preset'>('user');
  const [documentLoading, setDocumentLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [documents, setDocuments] = useState<CartographySummary[]>([]);
  const [activeEdits, setActiveEdits] = useState<Record<string, string>>({});
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const { sessions } = await listActiveCartographyEdits(controller.signal);
        if (!controller.signal.aborted) setActiveEdits(Object.fromEntries(sessions
          .filter((session) => session.sourceDocumentId)
          .map((session) => [session.sourceDocumentId!, session.id])));
      } catch { /* Retain the last known state until the next refresh. */ }
      if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, 2000);
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('cartography') ?? '');
  const [source, setSource] = useState('');
  const [sourceFile, setSourceFile] = useState<CartographyStyleFile>();
  const [mode, setMode] = useState<Mode>('upload');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [brief, setBrief] = useState('');
  const [styleInput, setStyleInput] = useState<'file' | 'url'>('file');
  const [styleUrl, setStyleUrl] = useState('');
  const [styleFileName, setStyleFileName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<CartographyDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<boolean | 'tooLarge'>(false);
  const [saved, setSaved] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CartographySummary | null>(null);
  const [deleteError, setDeleteError] = useState<'inUse' | 'failed' | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [renameTarget, setRenameTarget] = useState<CartographySummary | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameFailed, setRenameFailed] = useState(false);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameCopy = projectRenameCopy[locale];
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void listCartographies(controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        setDocuments((current) => [...result.documents.filter((item) => !current.some((doc) => doc.id === item.id)), ...current]);
        setSelected((current) => current || result.documents.find((document) => document.origin !== 'preset')?.id || '');
        const requested = result.documents.find((document) => document.id === new URLSearchParams(window.location.search).get('cartography'));
        if (requested) setCategory(requested.origin ?? 'user');
      }
    }).catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => { controller.abort(); request.current?.abort(); };
  }, []);
  useEffect(() => {
    setSource('');
    setSourceFile(undefined);
    setDocumentLoading(Boolean(selected));
    if (!selected) return;
    const controller = new AbortController();
    void getCartography(selected, controller.signal).then((document) => {
      if (!controller.signal.aborted) {
        setSource(document.source);
        setSourceFile(document.sourceFile);
        const { source: _source, sourceFile: _sourceFile, ...summary } = document;
        setDocuments((current) => current.map((item) => item.id === document.id ? summary : item));
      }
    }).catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setDocumentLoading(false); });
    return () => controller.abort();
  }, [selected]);

  function remember(document: CartographySummary) {
    setDeleted(false);
    setDocuments((current) => [...current.filter((item) => item.id !== document.id), document]);
    setSelected(document.id);
    setCategory(document.origin ?? 'user');
    setCreateOpen(false);
    setSaved(true);
  }
  async function perform(operation: (signal: AbortSignal) => Promise<void>) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(false); setSaved(false);
    try { await operation(controller.signal); }
    catch (failure) {
      if (!controller.signal.aborted) {
        const details = failure instanceof ApiClientError ? failure.details : null;
        setError(details && typeof details === 'object' && 'reason' in details && details.reason === 'CARTOGRAPHY_TOO_LARGE' ? 'tooLarge' : true);
      }
    }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === 'ai' && !canGenerate) return;
    void perform(async (signal) => {
      if (mode === 'online') {
        const result = await importCartographyUrl(url.trim(), signal, description.trim() || undefined);
        if (!signal.aborted) remember(result);
      } else if (mode === 'style' && styleInput === 'url') {
        const result = await initializeCartographyUrl({ name: name.trim(), url: styleUrl.trim(), ...(styleFileName.trim() ? { fileName: styleFileName.trim() } : {}) }, signal);
        if (!signal.aborted) setDraft(result);
      } else if (mode === 'ai') {
        const session = await createCartographyEdit({ name: name.trim(), requirements: brief.trim(), description: description.trim(), runtime: { agentId: generationAgent, ...(selectedModel ? { model: selectedModel.id } : {}) } }, signal);
        if (!signal.aborted) navigate({ kind: 'cartography-editor', sessionId: session.id });
      } else {
        if (!file || file.size > (mode === 'style' ? CARTOGRAPHY_STYLE_MAX_BYTES : CARTOGRAPHY_MAX_BYTES)) throw new Error('Invalid file size');
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (signal.aborted) return;
        if (mode === 'upload') {
          const result = await importCartography(new TextDecoder('utf-8', { fatal: true }).decode(bytes), signal, description.trim() || undefined);
          if (!signal.aborted) remember(result);
        } else {
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
          const result = await initializeCartography({ name: name.trim(), fileName: file.name, content: btoa(binary) }, signal);
          if (!signal.aborted) setDraft(result);
        }
      }
    });
  }
  const modes: Array<[Mode, string]> = [['upload', copy.import], ['online', text.online], ['style', text.fromStyle], ['ai', text.ai]];
  const selectedDocument = documents.find((document) => document.id === selected);
  const ordered = [...documents].sort((a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0) || a.name.localeCompare(b.name));
  const visibleDocuments = ordered.filter((document) => (document.origin ?? 'user') === category);
  function switchCategory(next: 'user' | 'preset') {
    setCategory(next); setSelected(ordered.find((document) => (document.origin ?? 'user') === next)?.id ?? '');
    setSaved(false); setDeleted(false); setError(false);
  }
  const updatedTime = (document: CartographySummary) => document.updatedAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(document.updatedAt))
    : library.unknownTime;
  function openDocument(id: string) { setCreateOpen(false); setSelected(id); setError(false); setSaved(false); setDeleted(false); }
  function useDocument(id: string) { navigate({ kind: 'home', cartographyId: id }); }
  function editWithAgent(documentSource: string, documentDescription: string, reportMarkdown = '', sourceDocumentId?: string, documentSourceFile?: CartographyStyleFile) {
    void perform(async (signal) => {
      if (sourceDocumentId) {
        const { sessions } = await listCartographyEditHistory(sourceDocumentId, signal);
        if (signal.aborted) return;
        const previous = lastCartographyEdit(sourceDocumentId);
        const existing = sessions.find((session) => session.id === previous) ?? sessions[0];
        if (existing) {
          rememberCartographyEdit(sourceDocumentId, existing.id);
          navigate({ kind: 'cartography-editor', sessionId: existing.id });
          return;
        }
      }
      const session = await createCartographyEdit({ source: documentSource, description: documentDescription, reportMarkdown, runtime: generationRuntime, initialPrompt: editor.initialPrompt, ...(sourceDocumentId ? { sourceDocumentId } : {}), ...(documentSourceFile ? { sourceFile: documentSourceFile } : {}) }, signal);
      if (!signal.aborted) {
        if (sourceDocumentId) rememberCartographyEdit(sourceDocumentId, session.id);
        navigate({ kind: 'cartography-editor', sessionId: session.id });
      }
    });
  }
  function confirmDelete(document: CartographySummary) { setDeleteTarget(document); setDeleteError(null); setDeleted(false); }
  function removeDocument() {
    if (!deleteTarget || busy) return;
    const id = deleteTarget.id;
    setDeleteError(null);
    void perform(async (signal) => {
      try {
        await deleteCartography(id, signal);
        if (signal.aborted) return;
        setDocuments((current) => current.filter((document) => document.id !== id));
        if (selected === id) { setSelected(documents.find((document) => document.id !== id && (document.origin ?? 'user') === category)?.id ?? ''); setSource(''); }
        const url = new URL(window.location.href);
        if (url.searchParams.get('cartography') === id) {
          url.searchParams.delete('cartography');
          window.history.replaceState(null, '', url);
        }
        setDeleteTarget(null); setDeleted(true);
      } catch (error) {
        if (signal.aborted) return;
        const details = error instanceof ApiClientError ? error.details : null;
        setDeleteError(details && typeof details === 'object' && 'reason' in details && details.reason === 'CARTOGRAPHY_IN_USE' ? 'inUse' : 'failed');
      }
    });
  }
  return <section className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-10 md:px-10">
    <header className="flex flex-wrap items-center justify-between gap-4 [&_h1]:font-serif [&_h1]:text-4xl">
      <h1>{copy.manage}</h1>
      <Button type="button" variant="default" disabled={busy} onClick={() => { setCreateOpen(!createOpen); setError(false); setSaved(false); }}><Plus data-icon="inline-start" aria-hidden="true" />{createOpen ? text.cancel : library.add}</Button>
    </header>
    <div className="flex flex-col gap-2">
      <p className="text-sm leading-relaxed text-muted-foreground">{library.intro}</p>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <a className="inline-flex items-center gap-1.5 text-primary underline-offset-4 hover:underline" href="https://github.com/mapseekai/cartography.md/blob/main/docs/spec.md" target="_blank" rel="noreferrer"><BookOpen aria-hidden="true" className="size-4" />{library.readSpec}</a>
        <a className="inline-flex items-center gap-1.5 text-primary underline-offset-4 hover:underline" href="https://github.com/mapseekai/cartography.md" target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" className="size-4" />GitHub</a>
      </div>
    </div>
    {error ? <Alert variant="destructive"><AlertDescription>{error === 'tooLarge' ? library.tooLarge : copy.error}</AlertDescription></Alert> : null}
    {saved ? <p role="status" className="text-sm text-muted-foreground">{text.saved}</p> : null}
    {deleted ? <p role="status" className="text-sm text-muted-foreground">{library.deleted}</p> : null}
    {deleteTarget ? <Dialog role="alertdialog" ariaLabelledBy="cartography-delete-title" ariaDescribedBy="cartography-delete-description" closeOnEscape={!busy} closeOnBackdrop={!busy} onClose={() => { if (!busy) setDeleteTarget(null); }}>
      <DialogHeader>
        <DialogTitle id="cartography-delete-title">{t('common.delete')}: {deleteTarget.name}</DialogTitle>
        <DialogDescription id="cartography-delete-description">{library.deleteWarning}</DialogDescription>
      </DialogHeader>
      {deleteError ? <Alert variant="destructive"><AlertDescription>{deleteError === 'inUse' ? library.inUse : copy.error}</AlertDescription></Alert> : null}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>{text.cancel}</Button>
        <Button type="button" variant="destructive" disabled={busy} onClick={removeDocument}>{busy ? t('common.loading') : t('common.delete')}</Button>
      </DialogFooter>
    </Dialog> : null}
    {renameTarget ? <Dialog ariaLabelledBy="rename-cartography-title" onClose={() => { if (!busy) setRenameTarget(null); }} closeOnEscape={!busy} closeOnBackdrop={!busy} initialFocus={renameInput}>
      <form className="flex flex-col gap-4" onSubmit={event => {
        event.preventDefault();
        if (busy || !renameName.trim() || renameName.trim() === renameTarget.name) return;
        const target = renameTarget;
        setRenameFailed(false);
        void perform(async signal => {
          try {
            const updated = await updateCartography(target.id, { name: renameName.trim() }, signal);
            if (!signal.aborted) { setDocuments(current => current.map(item => item.id === target.id ? updated : item)); setRenameTarget(null); }
          } catch { if (!signal.aborted) setRenameFailed(true); }
        });
      }}>
        <DialogHeader><DialogTitle id="rename-cartography-title">{renameCopy.rename}</DialogTitle></DialogHeader>
        <Field><FieldLabel htmlFor="rename-cartography-name">{text.name}</FieldLabel><Input id="rename-cartography-name" ref={renameInput} value={renameName} onChange={event => setRenameName(event.target.value)} maxLength={256} required disabled={busy} /></Field>
        {renameFailed ? <p role="alert" className="text-sm text-destructive">{renameCopy.error}</p> : null}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setRenameTarget(null)}>{text.cancel}</Button><Button type="submit" disabled={busy || !renameName.trim() || renameName.trim() === renameTarget.name}>{busy ? t('common.loading') : renameCopy.rename}</Button></DialogFooter>
      </form>
    </Dialog> : null}
    {!createOpen ? <div className="flex min-w-0 flex-wrap items-start gap-8">
      <nav aria-label={text.library} className="flex min-w-0 flex-col gap-4" style={{ flex: '1 1 190px', maxWidth: 240 }}>
        <div className="flex flex-wrap gap-1" role="group" aria-label={text.library}>
          {(['user', 'preset'] as const).map((value) => <Button key={value} type="button" variant={category === value ? 'secondary' : 'ghost'} disabled={busy} aria-pressed={category === value} onClick={() => switchCategory(value)}>{value === 'user' ? library.yourSystems : library.systemPresets} {documents.filter((document) => (document.origin ?? 'user') === value).length}</Button>)}
        </div>
        {listLoading ? <MapLoading label={t('common.loading')} /> : visibleDocuments.length ? <ul className="flex list-none flex-col gap-2 p-0">{visibleDocuments.map((document) => <li key={document.id}>
          <button type="button" disabled={busy} aria-label={`${copy.preview}: ${document.name}`} aria-current={selected === document.id ? 'true' : undefined} onClick={() => openDocument(document.id)} className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors ${selected === document.id ? 'border-border bg-card' : 'border-transparent hover:bg-muted'}`}>
            <span className="shrink-0"><CartographyVisualPreview compact preview={document.preview} name={document.name} /></span>
            <span className="min-w-0"><span className="block truncate text-sm font-medium">{document.name}</span><span className="mt-1 line-clamp-2 text-xs text-muted-foreground">{document.description || library.noDescription}</span></span>
          </button>
        </li>)}</ul> : <Empty><EmptyHeader><EmptyDescription>{text.empty}</EmptyDescription></EmptyHeader></Empty>}
      </nav>
    {selectedDocument ? <section className="flex min-w-0 flex-col gap-6" style={{ flex: '3 1 300px' }} aria-label={selectedDocument.name}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div><div className="mb-2 flex items-center gap-2"><h2 className="text-xl font-medium">{selectedDocument.name}</h2><Button type="button" variant="ghost" size="icon-sm" aria-label={`${renameCopy.rename}: ${selectedDocument.name}`} disabled={busy} onClick={() => { setRenameTarget(selectedDocument); setRenameName(selectedDocument.name); setRenameFailed(false); }}><Pencil aria-hidden="true" /></Button></div><p className="text-sm text-muted-foreground">CARTOGRAPHY.md · {selectedDocument.version} · {library.updated}: {selectedDocument.updatedAt ? <time dateTime={selectedDocument.updatedAt}>{updatedTime(selectedDocument)}</time> : library.unknownTime}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={busy || documentLoading || !source.trim()} onClick={() => editWithAgent(source, selectedDocument.description, '', selectedDocument.id, sourceFile)}>
            {activeEdits[selectedDocument.id] ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
            <span aria-live="polite">{activeEdits[selectedDocument.id] ? editor.analyzing : editor.edit}</span>
          </Button>
          <CartographyEditHistory documentId={selectedDocument.id} />
          <a href={`/?cartography=${encodeURIComponent(selected)}`} onClick={(event) => { event.preventDefault(); useDocument(selected); }}>{text.use} →</a>
          <Button type="button" variant="outline" disabled={!source || documentLoading} onClick={() => download('CARTOGRAPHY.md', source)}>{text.download}</Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => confirmDelete(selectedDocument)} aria-label={`${t('common.delete')}: ${selectedDocument.name}`}><Trash2 aria-hidden="true" />{t('common.delete')}</Button>
        </div>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground" aria-label={library.description}>{selectedDocument.description || library.noDescription}</p>
      <CartographyVisualPreview preview={selectedDocument.preview} name={selectedDocument.name} />

      <CartographyDocumentPreview key={selected} source={source} palette={selectedDocument.preview?.palette} initiallyOpen={false} />
    </section> : null}
    </div> : null}
    {createOpen ? <section className="flex flex-col gap-6 rounded-xl border border-border bg-card p-6">
        <Tabs value={mode} onValueChange={(value) => { if (typeof value !== "string") return; setMode(value as Mode); setFile(null); setDraft(null); setError(false); setSaved(false); }}><TabsList className="max-w-full flex-wrap group-data-horizontal/tabs:h-auto" aria-label={copy.manage}>{modes.map(([value, label]) => <TabsTrigger key={value} value={value} className="h-8" disabled={busy}>{label}</TabsTrigger>)}</TabsList><TabsContent value={mode}>
        <form onSubmit={submit} className="flex flex-col gap-5" aria-busy={busy}>
          <FieldSet disabled={busy}>
            {mode === 'style' || mode === 'ai' ? <Field><FieldLabel htmlFor="cartographymanager-3">{text.name}</FieldLabel><Input id="cartographymanager-3" value={name} onChange={(event) => setName(event.target.value)} maxLength={256} required /></Field> : null}
            {mode === 'online' ? <Field><FieldLabel htmlFor="cartographymanager-4">{text.url}</FieldLabel><Input id="cartographymanager-4" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…/CARTOGRAPHY.md" required /></Field> : null}
            {mode === 'style' ? <div className="flex flex-wrap gap-2">
              <Button type="button" variant={styleInput === 'file' ? 'secondary' : 'ghost'} aria-pressed={styleInput === 'file'} onClick={() => { setStyleInput('file'); setDraft(null); }}>{library.uploadFile}</Button>
              <Button type="button" variant={styleInput === 'url' ? 'secondary' : 'ghost'} aria-pressed={styleInput === 'url'} onClick={() => { setStyleInput('url'); setDraft(null); }}>{library.styleUrl}</Button>
            </div> : null}
            {mode === 'style' && styleInput === 'url' ? <>
              <Field><FieldLabel htmlFor="cartography-style-url">{library.styleUrl}</FieldLabel><Input id="cartography-style-url" type="url" required value={styleUrl} placeholder="https://…/style.json" onChange={(event) => { setStyleUrl(event.target.value); setDraft(null); }} /><small className="text-muted-foreground">{library.styleUrlHint}</small></Field>
              <Field><FieldLabel htmlFor="cartography-style-filename">{library.fileName}</FieldLabel><Input id="cartography-style-filename" value={styleFileName} placeholder="style.json" maxLength={256} onChange={(event) => { setStyleFileName(event.target.value); setDraft(null); }} /></Field>
              <small>ArcGIS (.lyrx, .stylx) · QGIS (.qgs, .qgz) · style.json · SLD (.sld) · 4 MiB</small>
            </> : null}
            {mode === 'upload' || (mode === 'style' && styleInput === 'file') ? <Field><FieldLabel htmlFor="cartographymanager-5">{mode === 'upload' ? copy.import : text.fromStyle}
              </FieldLabel><Input id="cartographymanager-5" aria-label={mode === 'upload' ? copy.import : text.fromStyle} key={mode} type="file" accept={mode === 'upload' ? '.md,text/markdown,text/plain' : '.json,.qgs,.qgz,.lyrx,.stylx,.sld,.xml'} required onChange={(event) => { setFile(event.target.files?.[0] ?? null); setDraft(null); }} />
              <small>{mode === 'upload' ? `CARTOGRAPHY.md · ${CARTOGRAPHY_MAX_BYTES / 1024} KiB` : 'ArcGIS (.lyrx, .stylx) · QGIS (.qgs, .qgz) · style.json · SLD (.sld) · 4 MiB'}</small>
            </Field> : null}
            {mode === 'ai' ? <><AgentModelFields id="cartographymanager-6" agents={agents} agentId={generationAgent} model={generationModel} disabled={busy || agentsLoading} onAgentChange={setGenerationAgent} onModelChange={setGenerationModel} />{agentsError ? <Alert variant="destructive"><AlertDescription>{agentsError}</AlertDescription></Alert> : null}<Field><FieldLabel htmlFor="cartographymanager-7">{text.brief}</FieldLabel><Textarea id="cartographymanager-7" rows={5} maxLength={8000} required value={brief} onChange={(event) => setBrief(event.target.value)} /></Field><p className="text-sm text-muted-foreground">{generationRuntime === 'api' ? apiCopy.generationHint : text.aiHint}</p></> : null}
            <Field><FieldLabel htmlFor="cartographymanager-2">{library.description}</FieldLabel><Textarea id="cartographymanager-2" rows={2} value={description} maxLength={2048} placeholder={library.descriptionHint} onChange={(event) => setDescription(event.target.value)} /></Field>
            <Button type="submit" variant="default" disabled={mode === 'ai' && !canGenerate}>{busy ? t('common.loading') : mode === 'ai' || mode === 'style' ? text.generate : copy.import}</Button>
          </FieldSet>
        </form></TabsContent></Tabs>
        {busy ? <Button type="button" variant="ghost" onClick={() => { request.current?.abort(); setBusy(false); }}>{text.cancel}</Button> : null}
        {draft ? <section className="flex flex-col gap-4">
          <p className="text-pretty">{text.draft}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled={busy || !draft.source.trim()} onClick={() => editWithAgent(draft.source, description.trim(), draft.reportMarkdown, undefined, draft.sourceFile)}>{editor.edit}</Button>
            <Button type="button" variant="default" disabled={busy || !draft.source.trim()} onClick={() => { void perform(async (signal) => { const result = await importCartography(draft.source, signal, description.trim() || undefined, draft.sourceFile); if (!signal.aborted) remember(result); }); }}>{text.save}</Button>
            <Button type="button" variant="ghost" onClick={() => download('CARTOGRAPHY.md', draft.source)}>{text.download} CARTOGRAPHY.md</Button>
            {draft.reportMarkdown ? [{ name: 'INIT_REPORT.md', content: draft.reportMarkdown }, { name: 'INIT_REPORT.json', content: draft.reportJson }].map((report) => <Button key={report.name} type="button" variant="ghost" onClick={() => download(report.name, report.content)}>{text.download} {report.name}</Button>) : null}
          </div>
          <Field><FieldLabel htmlFor="cartographymanager-8">CARTOGRAPHY.md</FieldLabel><Textarea id="cartographymanager-8" aria-label="CARTOGRAPHY.md" rows={16} value={draft.source} disabled={busy} onChange={(event) => setDraft({ ...draft, source: event.target.value })} /></Field>
          {draft.reportMarkdown ? <details className="min-w-0"><summary>INIT_REPORT.md</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{draft.reportMarkdown}</pre></details> : null}
        </section> : null}
    </section> : null}

  </section>;
}

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
