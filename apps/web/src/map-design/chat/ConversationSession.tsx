import { Alert, Button } from '@mapseekai/components';
import type { LocalAgentInfo, MapDesignMessage as Message, MapScreenshot, MapTextAttachment } from '@mapseekai/contracts';
import type { MapComment } from '@mapseekai/map-design-contracts';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { apiProfilesCopy } from '../../i18n/locales/api-profiles';
import { useI18n } from '../../i18n';
import type { QuestionForm } from '../../runtime/question-form';
import { parseSubmittedAnswers } from '../../components/QuestionForm';
import { MapDesignChatSurface } from './MapDesignChatSurface';
import { MapDesignComposer } from './MapDesignComposer';
import { MapDesignMessage } from './MapDesignMessage';
import { useConversationRuntime } from './useConversationRuntime';
import { useMapDesignConversation } from './useMapDesignConversation';
import { useMapDesignRun } from './useMapDesignRun';
import { useQueuedMapMessages, type PendingMapMessage } from './useQueuedMapMessages';
import { MapDesignMessageQueue } from './MapDesignMessageQueue';
import type { MapCommentSubmission } from './MapDesignChatPane';
import { EMPTY_SUBMITTED_FORMS, formOccurrences, submittedFormsEqual, type Answers, type SubmittedForms } from './conversation-forms';

export function ConversationSession({ projectId, conversationId, cartographyLabel, cartographyHref, runtimeAgents, agentsLoading, agentsError, runtimeDisabled, agentBlocked, selected, renderContent, composerBlocked, readOnly, viewedRevision, readOnlyReason, agentStatusMessage, onOpenSettings, openSettingsLabel, draft, onDraftChange, onRunActivityChange, onStartAccepted, onCommentSubmissionChange, screenshots, onRemoveScreenshot, onScreenshotsSent, attachments, onAttachmentsChange }: {
  cartographyLabel?: string; cartographyHref?: string;
  projectId: string; conversationId: string; runtimeAgents: readonly LocalAgentInfo[];
  agentsLoading: boolean; agentsError: string | null; runtimeDisabled: boolean; agentBlocked: boolean;
  selected: boolean; renderContent: boolean;
  composerBlocked: boolean; readOnly: boolean; viewedRevision?: number; readOnlyReason: string | null;
  agentStatusMessage: string | null; onOpenSettings?(): void; openSettingsLabel?: string;
  draft: string; onDraftChange(draft: string): void;
  onRunActivityChange(conversationId: string, active: boolean, selected: boolean, pending: boolean): void;
  onStartAccepted?(): void;
  onCommentSubmissionChange?(submission: MapCommentSubmission | null): void;
  attachments: MapTextAttachment[];
  onAttachmentsChange(files: MapTextAttachment[]): void;
  screenshots: MapScreenshot[];
  onRemoveScreenshot?(id: string): void;
  onScreenshotsSent?(ids: string[]): void;
}) {
  const { t, locale } = useI18n();
  const conversationRuntime = useConversationRuntime({ projectId, conversationId, disabled: runtimeDisabled });
  const runtime = conversationRuntime.runtime;
  const conversation = useMapDesignConversation(projectId, conversationId);
  const run = useMapDesignRun({ projectId, conversationId, runtime, conversation: conversation.conversation, readOnly, viewedRevision, readOnlyReason, onStartAccepted });
  const selectedAgent = runtime ? runtimeAgents.find((agent) => agent.id === runtime.agentId) : undefined;
  const catalogChecksEnabled = runtimeAgents.length > 0 || agentsLoading || Boolean(agentsError);
  const apiProfileUnavailable = selectedAgent?.id === 'api' && selectedAgent.modelCatalogSource === 'configured'
    && !selectedAgent.models?.some((model) => model.id === runtime?.model && model.enabled);
  const catalogBlocked = catalogChecksEnabled && (
    agentsLoading
    || Boolean(agentsError)
    || !selectedAgent?.available
    || selectedAgent.mapDesign.nativeMapTools !== true
  );
  const effectiveAgentBlocked = agentBlocked
    || apiProfileUnavailable
    || catalogBlocked
    || runtime === null
    || conversationRuntime.loading
    || Boolean(conversationRuntime.error);
  const effectiveAgentStatusMessage = (apiProfileUnavailable ? apiProfilesCopy[locale].unavailable : null) ?? agentStatusMessage
    ?? (agentsLoading ? null
      : agentsError || (catalogChecksEnabled && !selectedAgent?.available)
        ? t('mapDesign.workspace.agentUnavailable')
        : selectedAgent && selectedAgent.mapDesign.nativeMapTools !== true
          ? t('mapDesign.agent.mapEditingUnavailable')
          : conversationRuntime.error);
  const queueBlocked = composerBlocked || effectiveAgentBlocked || conversationRuntime.saving;
  const dispatch = useCallback((message: PendingMapMessage) => run.send(message.prompt, undefined, message.screenshots, message.attachments, message.requestId), [run.send]);
  const queue = useQueuedMapMessages({ projectId, conversationId, sending: run.sending, ready: run.ready, status: run.status, blocked: queueBlocked, readOnly, send: dispatch });
  useLayoutEffect(() => { onRunActivityChange(conversationId, run.sending, selected, queue.items.length > 0); }, [conversationId, onRunActivityChange, run.sending, selected, queue.items.length]);
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
  const submitBlocked = !run.ready || run.sending || composerBlocked || effectiveAgentBlocked || conversationRuntime.saving;
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
  if (!renderContent && !queue.editingId) return <div className="hidden" hidden aria-hidden="true" />;
  return <MapDesignChatSurface selected={selected && renderContent} busy={conversation.loading || run.sending}
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
    composer={<div className="flex min-h-0 shrink-0 flex-col gap-2">
      <MapDesignMessageQueue items={queue.items} submittingId={queue.submittingId} editingId={queue.editingId} paused={queue.paused} disabled={readOnly} resumeDisabled={queueBlocked}
        onEdit={queue.edit} onSave={queue.save} onRemoveAttachment={queue.removeAttachment} onCancelEdit={queue.cancelEdit} onRemove={queue.remove} onResume={queue.resume} />
      <MapDesignComposer queueEnabled cartographyLabel={cartographyLabel} cartographyHref={cartographyHref} projectId={projectId} runtime={runtime} runtimeAgents={runtimeAgents} runtimeSaving={conversationRuntime.saving}
      runtimeNotice={conversationRuntime.notice} runtimeDisabled={runtimeDisabled || run.sending}
      runtimeDisabledReason={runtimeDisabledReason} onRuntimeChange={conversationRuntime.update}
      sending={run.sending} disabled={composerBlocked || effectiveAgentBlocked || (!run.ready && !run.sending)}
      disabledReason={readOnly ? readOnlyReason : conversationRuntime.error} draft={draft} onCancel={() => { queue.pause(); return run.cancel(); }}
      onDraftChange={onDraftChange} screenshots={screenshots} onRemoveScreenshot={onRemoveScreenshot} onScreenshotsSent={onScreenshotsSent}
      attachments={attachments} onAttachmentsChange={onAttachmentsChange}
      showScrollToBottom={showScrollToBottom} onScrollToBottom={() => scrollToBottom(true)}
      onSend={queue.enqueue} /></div>}
  />;
}
