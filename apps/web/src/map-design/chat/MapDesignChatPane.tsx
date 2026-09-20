import { MapDesignChatSurface } from './MapDesignChatSurface';
import { TitlebarControl } from '../components/MapDesignTitlebar';
import type { MapScreenshot, MapTextAttachment } from '@mapseekai/contracts';
import { Alert, Button } from '@mapseekai/components';
import type {
  LocalAgentInfo,
  MapDesignMessage as Message,
} from '@mapseekai/contracts';
import { PanelLeftOpen, Plus } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { splitOnQuestionForms, type QuestionForm } from '../../runtime/question-form';
import { parseSubmittedAnswers } from '../../components/QuestionForm';
import { useI18n } from '../../i18n';
import { MapDesignComposer } from './MapDesignComposer';
import { MapDesignMessage } from './MapDesignMessage';
import { useConversationRuntime } from './useConversationRuntime';
import { useMapDesignConversation } from './useMapDesignConversation';
import { useMapDesignRun } from './useMapDesignRun';
import type { MapComment } from '@mapseekai/map-design-contracts';

export interface MapCommentSubmission {
  projectId: string;
  conversationId: string;
  disabled: boolean;
  running?: boolean;
  send(comments: MapComment[]): Promise<boolean>;
}

type Answers = Record<string, string | string[]>;
type FormOccurrence = { key: string; messageIndex: number; form: QuestionForm };
type MessageFormOccurrence = Omit<FormOccurrence, 'messageIndex'>;
type SubmittedForms = Readonly<Record<string, Answers>>;
const MAX_RETAINED_CONVERSATION_DRAFTS = 20;
const EMPTY_SUBMITTED_FORMS: SubmittedForms = Object.freeze({});
const messageFormOccurrenceCache = new WeakMap<Message, readonly MessageFormOccurrence[]>();

function messageFormOccurrences(message: Message): readonly MessageFormOccurrence[] {
  if (message.role !== 'assistant') return [];
  const cached = messageFormOccurrenceCache.get(message);
  if (cached) return cached;
  const occurrences = splitOnQuestionForms(message.content).flatMap((segment, segmentIndex) =>
    segment.kind === 'form'
      ? [{ key: `${message.id}:${segmentIndex}`, form: segment.form }]
      : [],
  );
  messageFormOccurrenceCache.set(message, occurrences);
  return occurrences;
}

function formOccurrences(messages: readonly Message[]): FormOccurrence[] {
  return messages.flatMap((message, messageIndex) =>
    messageFormOccurrences(message).map((occurrence) => ({ ...occurrence, messageIndex })),
  );
}

function answerValueEquals(left: string | string[], right: string | string[]): boolean {
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function submittedFormsEqual(left: SubmittedForms, right: SubmittedForms): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => {
    const leftAnswers = left[key];
    const rightAnswers = right[key];
    if (!leftAnswers || !rightAnswers) return false;
    const answerKeys = Object.keys(leftAnswers);
    return answerKeys.length === Object.keys(rightAnswers).length && answerKeys.every((answerKey) => {
      const leftValue = leftAnswers[answerKey];
      const rightValue = rightAnswers[answerKey];
      return leftValue !== undefined && rightValue !== undefined && answerValueEquals(leftValue, rightValue);
    });
  });
}

export function latestUnansweredFormOccurrence(
  messages: readonly Message[],
  answered: Readonly<Record<string, Answers>>,
): FormOccurrence | undefined {
  return formOccurrences(messages).reverse().find((occurrence) => !answered[occurrence.key]);
}
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
  const [attachmentsByConversation, setAttachmentsByConversation] = useState<ReadonlyMap<string, MapTextAttachment[]>>(new Map());
  useEffect(() => setAttachmentsByConversation(new Map()), [projectId]);
  const setConversationAttachments = useCallback((id: string, files: MapTextAttachment[]) => {
    setAttachmentsByConversation((current) => {
      const next = new Map(current);
      next.delete(id);
      if (files.length) next.set(id, files);
      while (next.size > MAX_RETAINED_CONVERSATION_DRAFTS) next.delete(next.keys().next().value!);
      return next;
    });
  }, []);
  const [draftsByConversation, setDraftsByConversation] = useState<ReadonlyMap<string, string>>(new Map());
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
  const setSessionActive = useCallback((sessionId: string, active: boolean, selected: boolean) => {
    setActiveSessionIds((current) => {
      if (current.has(sessionId) === active) return current;
      const next = new Set(current);
      if (active) next.add(sessionId); else next.delete(sessionId);
      return next;
    });
    if (!active && !selected) {
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

  return <div className="grid h-full min-h-0 text-foreground data-[collapsed=true]:block" data-collapsed={collapsed}>
    {collapsed ? <aside className="flex min-h-full flex-col items-center gap-1 bg-muted p-1" aria-label={t('mapDesign.conversation.railCollapsed')}>
      <TitlebarControl><Button variant="ghost" size="icon" ref={onExpandButtonMount} className="shrink-0" type="button" aria-label={t('mapDesign.conversation.expand')} disabled={readOnly} onClick={expandReadOnlySafe}>
        <PanelLeftOpen data-icon="inline-start" aria-hidden="true" />
      </Button></TitlebarControl>
      <Button variant="ghost" size="icon" className="shrink-0" type="button" aria-label={t('mapDesign.conversation.defaultTitle')} disabled={readOnly} onClick={createReadOnlySafe}>
        <Plus data-icon="inline-start" aria-hidden="true" />
      </Button>
      {activeSessionIds.size > 0 ? <span className="mt-1 size-2 rounded-full bg-primary" role="status"><span className="sr-only">{t('mapDesign.conversation.runActive')}</span></span> : null}
    </aside> : null}
    <div className="grid min-h-0 [&[hidden]]:hidden" hidden={collapsed} aria-hidden={collapsed}>{sessions}</div>
  </div>;
}

function ConversationSession({ projectId, conversationId, cartographyLabel, cartographyHref, runtimeAgents, agentsLoading, agentsError, runtimeDisabled, agentBlocked, selected, renderContent, composerBlocked, readOnly, viewedRevision, readOnlyReason, agentStatusMessage, onOpenSettings, openSettingsLabel, draft, onDraftChange, onRunActivityChange, onStartAccepted, onCommentSubmissionChange, screenshots, onRemoveScreenshot, onScreenshotsSent, attachments, onAttachmentsChange }: {
  cartographyLabel?: string; cartographyHref?: string;
  projectId: string; conversationId: string; runtimeAgents: readonly LocalAgentInfo[];
  agentsLoading: boolean; agentsError: string | null; runtimeDisabled: boolean; agentBlocked: boolean;
  selected: boolean; renderContent: boolean;
  composerBlocked: boolean; readOnly: boolean; viewedRevision?: number; readOnlyReason: string | null;
  agentStatusMessage: string | null; onOpenSettings?(): void; openSettingsLabel?: string;
  draft: string; onDraftChange(draft: string): void;
  onRunActivityChange(conversationId: string, active: boolean, selected: boolean): void;
  onStartAccepted?(): void;
  onCommentSubmissionChange?(submission: MapCommentSubmission | null): void;
  attachments: MapTextAttachment[];
  onAttachmentsChange(files: MapTextAttachment[]): void;
  screenshots: MapScreenshot[];
  onRemoveScreenshot?(id: string): void;
  onScreenshotsSent?(ids: string[]): void;
}) {
  const { t } = useI18n();
  const conversationRuntime = useConversationRuntime({ projectId, conversationId, disabled: runtimeDisabled });
  const runtime = conversationRuntime.runtime;
  const conversation = useMapDesignConversation(projectId, conversationId);
  const run = useMapDesignRun({ projectId, conversationId, runtime, readOnly, viewedRevision, readOnlyReason, onStartAccepted });
  useLayoutEffect(() => { onRunActivityChange(conversationId, run.sending, selected); }, [conversationId, onRunActivityChange, run.sending, selected]);
  const selectedAgent = runtime ? runtimeAgents.find((agent) => agent.id === runtime.agentId) : undefined;
  const catalogChecksEnabled = runtimeAgents.length > 0 || agentsLoading || Boolean(agentsError);
  const catalogBlocked = catalogChecksEnabled && (
    agentsLoading
    || Boolean(agentsError)
    || !selectedAgent?.available
    || selectedAgent.mapDesign.nativeMapTools !== true
  );
  const effectiveAgentBlocked = agentBlocked
    || catalogBlocked
    || runtime === null
    || conversationRuntime.loading
    || Boolean(conversationRuntime.error);
  const effectiveAgentStatusMessage = agentStatusMessage
    ?? (agentsLoading ? null
      : agentsError || (catalogChecksEnabled && !selectedAgent?.available)
        ? t('mapDesign.workspace.agentUnavailable')
        : selectedAgent && selectedAgent.mapDesign.nativeMapTools !== true
          ? t('mapDesign.agent.mapEditingUnavailable')
          : conversationRuntime.error);
  const runtimeDisabledReason = readOnly
    ? readOnlyReason
    : run.sending || runtimeDisabled
      ? t('mapDesign.runtime.runActiveDisabled')
      : effectiveAgentStatusMessage;
  const [submitted, setSubmitted] = useState<Record<string, Answers>>({});
  const persistedMessages = conversation.conversation?.messages;
  // Preserve individual message identity and the collection reference across
  // unrelated pane renders so memoized message/event preparation can bail out.
  const messages = useMemo<Message[]>(() => {
    const byId = new Map((persistedMessages ?? []).map((message) => [message.id, message]));
    for (const message of run.messages) byId.set(message.id, message);
    return [...byId.values()];
  }, [persistedMessages, run.messages]);
  const occurrences = useMemo(() => formOccurrences(messages), [messages]);
  const answered = useMemo(() => {
    const values = { ...submitted };
    for (let messageIndex = 0; messageIndex < messages.length - 1; messageIndex++) {
      const message = messages[messageIndex];
      const following = messages[messageIndex + 1];
      if (message?.role !== 'assistant' || following?.role !== 'user') continue;
      const latestInMessage = occurrences.filter((occurrence) => occurrence.messageIndex === messageIndex).at(-1);
      if (!latestInMessage) continue;
      const parsed = parseSubmittedAnswers(latestInMessage.form, following.content);
      if (parsed) values[latestInMessage.key] = parsed;
    }
    return values;
  }, [messages, occurrences, submitted]);
  const activeOccurrence = useMemo(
    () => [...occurrences].reverse().find((occurrence) => !answered[occurrence.key]),
    [answered, occurrences],
  );
  const submitBlocked = run.sending || composerBlocked || effectiveAgentBlocked || conversationRuntime.saving;
  const commentContext = useRef({ selected, blocked: submitBlocked, send: run.send });
  commentContext.current = { selected, blocked: submitBlocked, send: run.send };
  const sendComments = useCallback(async (comments: MapComment[]) => {
    const current = commentContext.current;
    if (!current.selected || current.blocked || !comments.length || comments.some((comment) => comment.projectId !== projectId)) return false;
    return current.send(
      comments.map((comment, index) => `${index + 1}. ${comment.text} (${comment.target.layerId})`).join('\n\n'),
      comments.map(({ id, version }) => ({ id, version })),
    );
  }, [projectId]);
  useLayoutEffect(() => {
    if (!selected || !onCommentSubmissionChange) return;
    onCommentSubmissionChange({ projectId, conversationId, disabled: submitBlocked, running: run.sending || runtimeDisabled, send: sendComments });
    return () => onCommentSubmissionChange(null);
  }, [conversationId, onCommentSubmissionChange, projectId, selected, sendComments, submitBlocked, run.sending, runtimeDisabled]);
  const submittedFormsCacheRef = useRef<ReadonlyMap<string, SubmittedForms>>(new Map());
  const submittedFormsByMessage = useMemo(() => {
    const candidates = new Map<string, Record<string, Answers>>();
    for (const occurrence of occurrences) {
      const occurrenceAnswers = answered[occurrence.key];
      const message = messages[occurrence.messageIndex];
      if (!occurrenceAnswers || !message) continue;
      const candidate = candidates.get(message.id) ?? {};
      candidate[occurrence.key] = occurrenceAnswers;
      candidates.set(message.id, candidate);
    }
    const next = new Map<string, SubmittedForms>();
    for (const message of messages) {
      const candidate = candidates.get(message.id) ?? EMPTY_SUBMITTED_FORMS;
      const previous = submittedFormsCacheRef.current.get(message.id);
      next.set(message.id, previous && submittedFormsEqual(previous, candidate) ? previous : candidate);
    }
    submittedFormsCacheRef.current = next;
    return next;
  }, [answered, messages, occurrences]);
  const submitContextRef = useRef({
    activeOccurrenceKey: activeOccurrence?.key,
    answered,
    blocked: submitBlocked,
    send: run.send,
  });
  submitContextRef.current = {
    activeOccurrenceKey: activeOccurrence?.key,
    answered,
    blocked: submitBlocked,
    send: run.send,
  };
  const submitForm = useCallback(async (occurrence: string, form: QuestionForm, text: string, answers: Answers) => {
    const current = submitContextRef.current;
    if (current.blocked || current.activeOccurrenceKey !== occurrence || current.answered[occurrence]) return false;
    const accepted = await current.send(text);
    if (!accepted) return false;
    setSubmitted((current) => ({ ...current, [occurrence]: answers }));
    return true;
  }, []);
  const messagesElement = useRef<HTMLDivElement>(null);
  const messagesContent = useRef<HTMLDivElement>(null);
  const followingLatest = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const observeScroll = useCallback(() => {
    const element = messagesElement.current;
    if (!element) return;
    followingLatest.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
    setShowScrollToBottom(!followingLatest.current);
  }, []);
  const scrollToBottom = useCallback((smooth = false) => {
    const element = messagesElement.current;
    if (!element) return;
    followingLatest.current = true;
    if (smooth && element.scrollTo && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    else element.scrollTop = element.scrollHeight;
    setShowScrollToBottom(false);
  }, []);
  useLayoutEffect(() => {
    if (!renderContent) return;
    const update = () => { if (followingLatest.current) scrollToBottom(); else observeScroll(); };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    if (messagesElement.current) observer.observe(messagesElement.current);
    if (messagesContent.current) observer.observe(messagesContent.current);
    return () => observer.disconnect();
  }, [messages, observeScroll, renderContent, scrollToBottom]);
  if (!renderContent) return <div className="hidden" hidden aria-hidden="true" />;
  return <MapDesignChatSurface selected={selected} busy={conversation.loading || run.sending}
    messagesRef={messagesElement} contentRef={messagesContent} onScroll={observeScroll}
    messages={messages.map((message, messageIndex) => {
        const activeFormOccurrence = activeOccurrence?.messageIndex === messageIndex
          ? activeOccurrence.key
          : undefined;
        return <MapDesignMessage
          key={message.id}
          message={message}
          activeFormOccurrence={activeFormOccurrence}
          submittedForms={submittedFormsByMessage.get(message.id) ?? EMPTY_SUBMITTED_FORMS}
          submitDisabled={activeFormOccurrence ? submitBlocked : false}
          onSubmitQuestion={submitForm}
        />;
      })}
    status={<>
    {effectiveAgentStatusMessage ? <Alert variant="destructive" className="shrink-0" role="status"><div className="flex items-center justify-between gap-2"><span>{effectiveAgentStatusMessage}</span>
      {onOpenSettings && openSettingsLabel ? <Button variant="ghost" type="button" onClick={onOpenSettings}>{openSettingsLabel}</Button> : null}
    </div></Alert> : null}
    {conversation.error || run.error ? <Alert variant="destructive" className="shrink-0">{run.error ?? conversation.error}</Alert> : null}
</>}
    composer={<MapDesignComposer cartographyLabel={cartographyLabel} cartographyHref={cartographyHref} projectId={projectId} runtime={runtime} runtimeAgents={runtimeAgents} runtimeSaving={conversationRuntime.saving}
      runtimeNotice={conversationRuntime.notice} runtimeDisabled={runtimeDisabled || run.sending}
      runtimeDisabledReason={runtimeDisabledReason} onRuntimeChange={conversationRuntime.update}
      sending={run.sending} disabled={composerBlocked || effectiveAgentBlocked}
      disabledReason={readOnly ? readOnlyReason : conversationRuntime.error} draft={draft} onCancel={run.cancel}
      onDraftChange={onDraftChange} screenshots={screenshots} onRemoveScreenshot={onRemoveScreenshot} onScreenshotsSent={onScreenshotsSent}
      attachments={attachments} onAttachmentsChange={onAttachmentsChange}
      showScrollToBottom={showScrollToBottom} onScrollToBottom={() => scrollToBottom(true)}
      onSend={(prompt, images, files) => files?.length ? run.send(prompt, undefined, images, files) : images?.length ? run.send(prompt, undefined, images) : run.send(prompt)} />}
  />;
}
