import { Button } from '@mapseekai/components';
import type { LocalAgentInfo, MapScreenshot, MapTextAttachment } from '@mapseekai/contracts';
import type { MapComment } from '@mapseekai/map-design-contracts';
import { PanelLeftOpen, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { useWorkspaceTabDraft } from '../WorkspaceTabs';
import { TitlebarControl } from '../components/MapDesignTitlebar';
import { ConversationSession } from './ConversationSession';
export { latestUnansweredFormOccurrence } from './conversation-forms';

export interface MapCommentSubmission {
  projectId: string;
  conversationId: string;
  disabled: boolean;
  running?: boolean;
  send(comments: MapComment[]): Promise<boolean>;
}

const MAX_RETAINED_CONVERSATION_DRAFTS = 20;

export function MapDesignChatPane({
  projectId,
  conversationId, cartographyLabel, cartographyHref,
  agents = [],
  agentsLoading = false,
  agentsError = null,
  onOpenSettings,
  openSettingsLabel,
  agentBlocked = false,
  agentStatusMessage = null,
  readOnly = false,
  viewedRevision,
  readOnlyReason = null,
  collapsed = false,
  onExpandButtonMount,
  onExpand,
  onCreateConversation,
  onStartAccepted,
  onCommentSubmissionChange,
  screenshots = [],
  onRemoveScreenshot,
  onScreenshotsSent,
}: {
  projectId: string;
  conversationId: string;
  cartographyLabel?: string; cartographyHref?: string;
  agents?: readonly LocalAgentInfo[];
  agentsLoading?: boolean;
  agentsError?: string | null;
  onOpenSettings?(): void;
  openSettingsLabel?: string;
  agentBlocked?: boolean;
  agentStatusMessage?: string | null;
  readOnly?: boolean;
  viewedRevision?: number;
  readOnlyReason?: string | null;
  collapsed?: boolean;
  onExpandButtonMount?(element: HTMLButtonElement | null): void;
  onExpand?(): void;
  onCreateConversation?(): void;
  onStartAccepted?(): void;
  onCommentSubmissionChange?(submission: MapCommentSubmission | null): void;
  screenshots?: MapScreenshot[];
  onRemoveScreenshot?(id: string): void;
  onScreenshotsSent?(ids: string[]): void;
}) {
  const { t } = useI18n();
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const expandReadOnlySafe = useCallback(() => {
    if (!readOnlyRef.current) onExpand?.();
  }, [onExpand]);
  const createReadOnlySafe = useCallback(() => {
    if (!readOnlyRef.current) onCreateConversation?.();
  }, [onCreateConversation]);
  const [sessionIds, setSessionIds] = useState<readonly string[]>([conversationId]);
  const [activeSessionIds, setActiveSessionIds] = useState<ReadonlySet<string>>(new Set());
  const runtimeMutationDisabled = readOnly || activeSessionIds.size > 0;
  // Drafts live above prunable sessions and use access-ordered LRU retention.
  const [attachmentsByConversation, setAttachmentsByConversation] = useWorkspaceTabDraft<ReadonlyMap<string, MapTextAttachment[]>>('project-attachments', () => new Map());
  const setConversationAttachments = useCallback((id: string, files: MapTextAttachment[]) => {
    setAttachmentsByConversation((current) => {
      const next = new Map(current);
      next.delete(id);
      if (files.length) next.set(id, files);
      while (next.size > MAX_RETAINED_CONVERSATION_DRAFTS) next.delete(next.keys().next().value!);
      return next;
    });
  }, []);
  const [draftsByConversation, setDraftsByConversation] = useWorkspaceTabDraft<ReadonlyMap<string, string>>('project-prompts', new Map());
  const renderedSessionIds = sessionIds.includes(conversationId) ? sessionIds : [...sessionIds, conversationId];
  const setConversationDraft = useCallback((sessionId: string, draft: string) => {
    setDraftsByConversation((current) => {
      const next = new Map(current);
      next.delete(sessionId);
      if (draft) next.set(sessionId, draft);
      while (next.size > MAX_RETAINED_CONVERSATION_DRAFTS) {
        const oldest = next.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        next.delete(oldest);
      }
      return next;
    });
  }, []);
  const setSessionActive = useCallback((sessionId: string, active: boolean, selected: boolean, pending: boolean) => {
    setActiveSessionIds((current) => {
      if (current.has(sessionId) === active) return current;
      const next = new Set(current);
      if (active) next.add(sessionId); else next.delete(sessionId);
      return next;
    });
    if (!active && !selected && !pending) {
      setSessionIds((current) => current.filter((id) => id === conversationId || id !== sessionId));
    }
  }, [conversationId]);
  useEffect(() => {
    setSessionIds((current) => current.includes(conversationId) ? current : [...current, conversationId]);
  }, [conversationId]);
  useEffect(() => {
    setDraftsByConversation((current) => {
      const draft = current.get(conversationId);
      if (draft === undefined || [...current.keys()].at(-1) === conversationId) return current;
      const next = new Map(current);
      next.delete(conversationId);
      next.set(conversationId, draft);
      return next;
    });
  }, [conversationId]);
  const sessions = renderedSessionIds.map((sessionId) => <ConversationSession key={sessionId} projectId={projectId} conversationId={sessionId}
    cartographyLabel={cartographyLabel} cartographyHref={cartographyHref}
    runtimeAgents={agents} agentsLoading={agentsLoading} agentsError={agentsError}
    runtimeDisabled={runtimeMutationDisabled} agentBlocked={agentBlocked} agentStatusMessage={agentStatusMessage}
    selected={sessionId === conversationId} renderContent={!collapsed && sessionId === conversationId}
    composerBlocked={readOnly || (activeSessionIds.size > 0 && !activeSessionIds.has(sessionId))}
    readOnly={readOnly} viewedRevision={viewedRevision} readOnlyReason={readOnlyReason}
    onOpenSettings={onOpenSettings} openSettingsLabel={openSettingsLabel}
    draft={draftsByConversation.get(sessionId) ?? ''}
    attachments={attachmentsByConversation.get(sessionId) ?? []} onAttachmentsChange={(files) => setConversationAttachments(sessionId, files)}
    onDraftChange={(draft) => setConversationDraft(sessionId, draft)} onRunActivityChange={setSessionActive} onStartAccepted={onStartAccepted}
    onCommentSubmissionChange={onCommentSubmissionChange}
    screenshots={sessionId === conversationId ? screenshots : []} onRemoveScreenshot={onRemoveScreenshot} onScreenshotsSent={onScreenshotsSent} />);

  return <div className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] text-foreground data-[collapsed=true]:block" data-collapsed={collapsed}>
    {collapsed ? <aside className="flex min-h-full flex-col items-center gap-1 bg-muted p-1" aria-label={t('mapDesign.conversation.railCollapsed')}>
      <TitlebarControl><Button variant="ghost" size="icon" ref={onExpandButtonMount} className="shrink-0" type="button" aria-label={t('mapDesign.conversation.expand')} disabled={readOnly} onClick={expandReadOnlySafe}>
        <PanelLeftOpen data-icon="inline-start" aria-hidden="true" />
      </Button></TitlebarControl>
      <Button variant="ghost" size="icon" className="shrink-0" type="button" aria-label={t('mapDesign.conversation.defaultTitle')} disabled={readOnly} onClick={createReadOnlySafe}>
        <Plus data-icon="inline-start" aria-hidden="true" />
      </Button>
      {activeSessionIds.size > 0 ? <span className="mt-1 size-2 rounded-full bg-primary" role="status"><span className="sr-only">{t('mapDesign.conversation.runActive')}</span></span> : null}
    </aside> : null}
    <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] [&[hidden]]:hidden" hidden={collapsed} aria-hidden={collapsed}>{sessions}</div>
  </div>;
}
