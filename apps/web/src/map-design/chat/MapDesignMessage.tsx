import type { MapDesignMessage as Message } from '@mapseekai/contracts';
import { Button } from '@mapseekai/components';
import { FileText } from 'lucide-react';
import { mapTextAttachmentUrl, mapScreenshotUrl } from '@mapseekai/contracts';
import { useI18n } from '../../i18n';
import { screenshotCopy } from '../../i18n/locales/screenshots';
import { memo, useMemo } from 'react';

import { splitOnQuestionForms, stripTrailingOpenQuestionForm, type QuestionForm } from '../../runtime/question-form';
import { QuestionFormView } from '../../components/QuestionForm';
import { renderMarkdown } from '../../runtime/markdown';
import { buildMapDesignEventBlocks, splitTaskActivity, TaskActivityCard } from './TaskActivityCard';

type Answers = Record<string, string | string[]>;

function hideTrailingFormPrefix(text: string): string {
  const lastOpen = text.lastIndexOf('<');
  if (lastOpen < 0) return text;
  const suffix = text.slice(lastOpen);
  if (suffix.length < 2 || suffix.includes('>')) return text;
  const lower = suffix.toLowerCase();

  for (const tag of ['<question-form', '<ask-question']) {
    if (tag.startsWith(lower) || (lower.startsWith(tag) && /^\s/.test(suffix.slice(tag.length)))) {
      return text.slice(0, lastOpen);
    }
  }
  return text;
}

function blockRemoteMarkdownImages(text: string): string {
  return text.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^)]*["'])?\)/giu, '[$1]($2)');
}

function runtimeAgentLabel(agentId: string): string {
  return ({
    opencode: 'OpenCode',
    claude: 'Claude Code',
    codex: 'Codex',
    pi: 'Pi',
    omp: 'Oh My Pi',
    deepseek: 'DeepSeek',
  } as Record<string, string>)[agentId] ?? agentId;
}

function runtimeProvenance(message: Extract<Message, { role: 'assistant' }>): string | null {
  if (!message.runtime) return null;
  return [
    runtimeAgentLabel(message.runtime.agentId),
    message.runtime.agentVersion,
    message.runtime.model,
    message.runtime.reasoning,
    message.runtime.serviceTier,
    message.runtime.adapter,
  ].filter((value): value is string => Boolean(value)).join(' · ');
}
function MapDesignMessageView({
  message,
  activeFormOccurrence,
  submittedForms = {},
  submitDisabled = false,
  onSubmitQuestion,
}: {
  message: Message;
  activeFormOccurrence?: string;
  submittedForms?: Readonly<Record<string, Answers>>;
  submitDisabled?: boolean;
  onSubmitQuestion?(
    occurrence: string,
    form: QuestionForm,
    text: string,
    answers: Answers,
  ): Promise<boolean> | boolean;
}) {
  const { locale } = useI18n();
  const events = message.events;
  const prepared = useMemo(
    () => splitTaskActivity(buildMapDesignEventBlocks(events)),
    [events],
  );
  const contentHasQuestionForm = /<(?:question-form|ask-question)\b/iu.test(message.content);
  const hasAuthoritativeTerminalContent = message.role === 'assistant'
    && Boolean(message.content)
    && !['queued', 'running', 'awaiting_input'].includes(message.runStatus);
  const sourceBlocks = contentHasQuestionForm || hasAuthoritativeTerminalContent || prepared.contentBlocks.length === 0
    ? (message.content ? [{ kind: 'text' as const, text: message.content }] : [])
    : prepared.contentBlocks;
  const segments = sourceBlocks.flatMap((block) => {
    const visibleText = message.role === 'assistant'
      ? hideTrailingFormPrefix(stripTrailingOpenQuestionForm(block.text).text)
      : block.text;
    return message.role === 'assistant'
      ? splitOnQuestionForms(visibleText)
      : [{ kind: 'text' as const, text: visibleText }];
  });
  const provenance = message.role === 'assistant' ? runtimeProvenance(message) : null;
  if (message.role !== 'assistant' && segments.every((segment) => segment.kind !== 'text' || !segment.text.trim())) return null;
  return <article className="max-w-3xl rounded-lg border bg-background px-3 py-2.5 text-foreground [content-visibility:auto] [contain-intrinsic-size:auto_120px] data-[role=user]:ml-auto data-[role=user]:bg-muted data-[status=failed]:border-destructive/35 data-[status=failed]:bg-destructive/5" data-role={message.role} data-status={message.runStatus} aria-label={message.role === 'user' ? 'Your message' : 'Assistant message'}>
    {message.role === 'assistant'
      ? <TaskActivityCard activity={prepared.taskActivity} runStatus={message.runStatus} />
      : null}
    {provenance ? <p className="mb-2 break-words text-xs text-muted-foreground">{provenance}</p> : null}
    {message.role === 'user' && message.attachments?.length ? <div className="mb-2 flex flex-wrap gap-2">
      {message.attachments.map((file) => <Button key={file.id} nativeButton={false} role="link" variant="outline" size="sm" className="max-w-full"
        render={<a href={mapTextAttachmentUrl(file)} target="_blank" rel="noreferrer" />}>
        <FileText data-icon="inline-start" /><span className="truncate">{file.fileName}</span>
      </Button>)}
    </div> : null}
    {message.role === 'user' && message.screenshots?.length ? <div className="mb-2 flex flex-wrap gap-2">
      {message.screenshots.map((screenshot) => <a key={screenshot.id} href={mapScreenshotUrl(screenshot)} target="_blank" rel="noreferrer">
        <img src={mapScreenshotUrl(screenshot)} alt={screenshotCopy[locale].image} loading="lazy" width={screenshot.width} height={screenshot.height}
          className="max-h-48 max-w-full rounded-md border object-contain" />
      </a>)}
    </div> : null}
    {segments.map((segment, index) => {
      if (segment.kind === 'text') {
        return segment.text.trim() ? <div key={index} className="[&>:first-child]:mt-0 [&>:last-child]:mb-0">{renderMarkdown(blockRemoteMarkdownImages(segment.text))}</div> : null;
      }
      const occurrence = `${message.id}:${index}`;
      const active = activeFormOccurrence === occurrence;
      return <QuestionFormView
        key={occurrence}
        form={segment.form}
        submittedAnswers={submittedForms[occurrence]}
        interactive={active}
        onSubmit={(text, answers) => { void onSubmitQuestion?.(occurrence, segment.form, text, answers); }}
        submitDisabled={!active || submitDisabled}
      />;
    })}
  </article>;
}

export const MapDesignMessage = memo(MapDesignMessageView);
MapDesignMessage.displayName = 'MapDesignMessage';
