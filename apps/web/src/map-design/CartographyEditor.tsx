import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Alert, AlertDescription, Button, MapLoading, type PanelImperativeHandle } from '@mapseekai/components';
import type { CartographyEditSession } from '@mapseekai/map-design-contracts';
import { useI18n } from '../i18n';
import { cartographyEditorCopy } from '../i18n/locales/cartography-editor';
import { cartographySaveCopy } from '../i18n/locales/cartography-save';
import { cartographyLibraryCopy } from '../i18n/locales/cartography-library';
import { cartographyPreviewCopy } from '../i18n/locales/cartography-preview';
import { cartographyManagerCopy } from '../i18n/locales/cartography';
import { navigationCopy } from '../i18n/locales/navigation';
import { MapDesignMessage } from './chat/MapDesignMessage';
import { MapDesignComposer } from './chat/MapDesignComposer';
import { MapDesignChatSurface } from './chat/MapDesignChatSurface';
import { MapDesignConversationHeader } from './chat/MapDesignConversationHeader';
import { useMapDesignConversations } from './chat/useMapDesignConversations';
import { useMapDesignConversation } from './chat/useMapDesignConversation';
import { useConversationRuntime } from './chat/useConversationRuntime';
import { useLocalAgents } from './hooks/useLocalAgents';
import { MapDesignWorkspacePanels } from './components/MapDesignWorkspacePanels';
import { MapDesignViewSwitcher, type MapDesignMobileView } from './components/MapDesignViewSwitcher';
import { TitlebarProject } from './components/MapDesignTitlebar';
import { useWorkspaceTabDraft } from './WorkspaceTabs';
import { useMapDesignLayoutPreferences } from './hooks/useMapDesignLayoutPreferences';
import { navigate } from '../router';
import { cancelCartographyEdit, getCartographyEdit, sendCartographyEdit } from './cartography-edit-client';
import { CartographySaveActions } from './components/CartographySaveActions';
import { CartographyDocumentPreview } from './components/CartographyDocumentPreview';
import { CartographyEditHistory } from './components/CartographyEditHistory';
import { rememberCartographyEdit } from './cartography-edit-client';

const SpecificationMap = lazy(() => import('./components/CartographySpecificationMap'));

export function CartographyEditor({ sessionId }: { sessionId: string }) {
  const { locale, t } = useI18n();
  const [session, setSession] = useState<CartographyEditSession | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void getCartographyEdit(sessionId, controller.signal).then((value) => { if (!controller.signal.aborted) setSession(value); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [sessionId]);
  if (!session || session.id !== sessionId) return <div className="p-6">{error ? <Alert variant="destructive"><AlertDescription>{cartographyEditorCopy[locale].failed}</AlertDescription></Alert> : <MapLoading label={t('common.loading')} />}</div>;
  return <CartographyEditorWorkspace key={sessionId} initial={session} />;
}

function CartographyEditorWorkspace({ initial }: { initial: CartographyEditSession }) {
  const { locale, t } = useI18n();
  const copy = cartographyEditorCopy[locale];
  const sessionId = initial.id;
  useEffect(() => {
    if (initial.sourceDocumentId) rememberCartographyEdit(initial.sourceDocumentId, initial.id);
  }, [initial.sourceDocumentId, initial.id]);
  const [session, setSession] = useState(initial);
  const [drafts, setDrafts] = useWorkspaceTabDraft<Record<string, string>>('specification-prompts', () =>
    !initial.initialAnalysisStarted && !initial.messages.length && initial.status === 'idle'
      ? { [initial.id]: initial.initialPrompt }
      : {});
  const [view, setView] = useState<'document' | 'map'>('document');
  const [notice, setNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  const [requestedConversation, setRequestedConversation] = useState(() => new URLSearchParams(window.location.search).get('conversation'));
  const conversations = useMapDesignConversations(sessionId, requestedConversation);
  const selectedId = conversations.selected?.conversationId ?? '';
  const documentRunning = session.status === 'running';
  const ownerId = session.activeConversationId ?? session.id;
  const running = documentRunning && ownerId === selectedId;
  const runtime = useConversationRuntime({ projectId: sessionId, conversationId: selectedId, enabled: Boolean(selectedId), disabled: busy || documentRunning });
  const conversation = useMapDesignConversation(sessionId, selectedId, session, Boolean(selectedId));
  const agents = useLocalAgents();
  const layout = useMapDesignLayoutPreferences();
  const chatPanel = useRef<PanelImperativeHandle | null>(null);
  const [mobileView, setMobileView] = useState<MapDesignMobileView>(() => initial.initialAnalysisStarted && !initial.sourceDocumentId ? 'chat' : 'map');
  const sending = useRef(false);
  const alive = useRef(true);
  const log = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const pop = () => setRequestedConversation(new URLSearchParams(window.location.search).get('conversation'));
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 767px)');
    if (!media) return;
    const update = () => setMobile(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!documentRunning) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const current = await getCartographyEdit(sessionId, controller.signal);
        if (controller.signal.aborted) return;
        setSession(current); setNotice(false);
        if (current.status !== 'running') { void conversations.refresh(); return; }
      } catch { if (controller.signal.aborted) return; setNotice(true); }
      timer = setTimeout(() => { void poll(); }, 1000);
    };
    timer = setTimeout(() => { void poll(); }, 1000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [documentRunning, sessionId]);
  const messages = conversation.conversation?.id === selectedId ? conversation.conversation.messages : [];
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [messages.length]);
  useEffect(() => setNotice(false), [selectedId]);

  async function submit(prompt: string, requestId = crypto.randomUUID()) {
    if (documentRunning || sending.current || !prompt.trim() || !runtime.runtime || !selectedId) return false;
    const target = selectedId;
    sending.current = true; setBusy(true); setNotice(false); setSaved(false);
    try {
      const next = await sendCartographyEdit(sessionId, { requestId, expectedRevision: session.revision, prompt, conversationId: target, runtimeRevision: runtime.runtime.revision });
      if (alive.current) { setSession(next); void conversations.refresh(); }
      return true;
    } catch {
      if (alive.current) {
        if (selectedRef.current === target) setNotice(true);
        try { setSession(await getCartographyEdit(sessionId)); } catch { /* Keep the current document visible. */ }
      }
      return false;
    } finally { sending.current = false; if (alive.current) setBusy(false); }
  }
  async function cancel() {
    setBusy(true);
    try { const next = await cancelCartographyEdit(sessionId); if (alive.current) { setSession(next); void conversations.refresh(); } }
    catch { if (alive.current) setNotice(true); }
    finally { if (alive.current) setBusy(false); }
  }
  const retryPrompt = [...messages].reverse().find((message) => message.role === 'user')?.content ?? session.initialPrompt;
  return <section className="group/workspace flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
    <TitlebarProject title={session.name} />
    {session.sourceDocumentId ? <div className="flex justify-end border-b px-3"><CartographyEditHistory documentId={session.sourceDocumentId} sessionId={session.id} /></div> : null}
    <MapDesignViewSwitcher view={mobileView} chatPanelId="map-design-chat-surface" mapPanelId="map-design-map-surface" mapLabel="CARTOGRAPHY.md" onViewChange={setMobileView} />
    <MapDesignWorkspacePanels
      groupProps={{ className: 'min-h-0 flex-1', disabled: mobile,
        onLayoutChanged: (_, meta) => { if (meta.isUserInteraction && !mobile) { const width = chatPanel.current?.getSize().inPixels; if (width !== undefined) layout.setChatWidth(width); } },
      }}
      chatPanelProps={{ panelRef: chatPanel, defaultSize: mobile ? mobileView === 'chat' ? '100%' : 0 : layout.chatWidth,
        minSize: mobile ? mobileView === 'chat' ? '100%' : 0 : 320, maxSize: mobile ? mobileView === 'chat' ? '100%' : 0 : 520,
      }} showHandle={!mobile}
      chat={<div id="map-design-chat-surface" hidden={mobile && mobileView !== 'chat'} role={mobile ? 'tabpanel' : undefined} aria-labelledby={mobile ? 'map-design-mobile-chat-tab' : undefined} className="[&[hidden]]:hidden flex h-full min-h-0 flex-col overflow-hidden border-e bg-background">
        {selectedId ? <MapDesignConversationHeader selectedId={selectedId} conversations={conversations.conversations} creating={conversations.creating} error={conversations.error} notice={conversations.notice}
          onSelect={conversations.select} onCreate={() => { void conversations.create(); }} onDelete={conversations.remove} onRetry={() => { void conversations.retry(); }} /> : null}
        {!selectedId ? <div className="grid flex-1 place-items-center p-4">{conversations.loading ? <MapLoading label={t('common.loading')} /> : <Button onClick={() => { void conversations.create(); }} disabled={conversations.creating}>{t('mapDesign.conversation.defaultTitle')}</Button>}{conversations.error ? <Alert variant="destructive">{conversations.error}</Alert> : null}</div> :
        <MapDesignChatSurface messagesRef={log} busy={busy || running || conversation.loading}
          messages={messages.map((message) => <MapDesignMessage key={message.id} message={message} submitDisabled />)}
          status={<>
            {(running || busy) ? <p role="status" className="text-sm text-muted-foreground">{running ? copy.analyzing : t('common.loading')}</p> : null}
            {session.status === 'canceled' && ownerId === selectedId ? <p role="status" className="text-sm text-muted-foreground">{copy.canceled}</p> : null}
            {(notice || (session.error && ownerId === selectedId)) ? <Alert variant="destructive"><AlertDescription>{copy.failed}</AlertDescription>{!documentRunning && !busy ? <Button type="button" variant="outline" onClick={() => { void submit(retryPrompt); }}>{copy.retry}</Button> : null}</Alert> : null}
            {conversation.error || agents.error ? <Alert variant="destructive">{conversation.error ?? agents.error}</Alert> : null}
          </>}
          composer={<MapDesignComposer projectId={sessionId} runtime={runtime.runtime} runtimeAgents={agents.agents} onRuntimeChange={runtime.update}
            runtimeSaving={runtime.saving} runtimeNotice={runtime.notice} runtimeDisabled={busy || documentRunning} disabledReason={runtime.error}
            maxPromptLength={8000} placeholder={copy.prompt} sending={running} disabled={busy || documentRunning || !runtime.runtime || agents.loading}
            draft={drafts[selectedId] ?? ''} onDraftChange={(value) => setDrafts((current) => ({ ...current, [selectedId]: value }))} onSend={(prompt) => submit(prompt)} onCancel={cancel} />}
        />}
      </div>}
      studio={<div id="map-design-map-surface" hidden={mobile && mobileView !== 'map'} role={mobile ? 'tabpanel' : undefined} aria-labelledby={mobile ? 'map-design-mobile-map-tab' : undefined} className="[&[hidden]]:hidden flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3" style={{ minHeight: 'var(--studio-header-height)' }}>
          <div className="flex min-w-0 items-center gap-2"><Button type="button" variant="ghost" size="icon" aria-label={cartographyLibraryCopy[locale].back} onClick={() => navigate({ kind: 'cartographies' })}><ArrowLeft aria-hidden="true" /></Button><h1 className="truncate text-base font-medium">{session.name}</h1><span className="text-xs text-muted-foreground">r{session.revision}</span></div>
          <div className="flex min-w-0 flex-wrap items-center gap-2"><Button type="button" variant="ghost" onClick={() => navigate({ kind: 'settings' })}>{navigationCopy[locale].settings}</Button><CartographySaveActions session={session} disabled={documentRunning || busy} onBusyChange={value => { setBusy(value); if (value) setSaved(false); }} onSaved={next => { setSession(next); setSaved(true); }} /></div>
        </div>
        <div className="flex flex-wrap gap-2 border-b border-border p-3"><Button type="button" variant={view === 'document' ? 'secondary' : 'ghost'} aria-pressed={view === 'document'} onClick={() => setView('document')}>CARTOGRAPHY.md</Button><Button type="button" variant={view === 'map' ? 'secondary' : 'ghost'} aria-pressed={view === 'map'} onClick={() => setView('map')}>{cartographyPreviewCopy[locale].mapTitle}</Button>
          {view === 'map' ? <Button type="button" variant="outline" disabled={busy || documentRunning || !selectedId || !runtime.runtime} onClick={() => { void submit(copy.updateMap); }}>{copy.updateMap}</Button> : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
          <p role={saved ? 'status' : undefined} className="text-xs text-muted-foreground">{saved ? cartographyManagerCopy[locale].saved : cartographySaveCopy[locale].hint}</p>
          {view === 'document' ? <CartographyDocumentPreview key={session.revision} source={session.source} />
            : <Suspense fallback={<MapLoading label={t('common.loading')} />}><SpecificationMap key={session.revision} elements={session.preview?.elements ?? []} sampleBindings={session.sampleBindings} /></Suspense>}
        </div>
      </div>}
    />
  </section>;
}
