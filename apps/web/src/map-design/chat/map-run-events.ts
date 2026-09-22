import { MapDesignRunEventSchema, type MapDesignMessage, type MapDesignRunEvent, type MapDesignRunResponse, type MapDesignRunStatus } from '@mapseekai/contracts';
import { runFailureCopy } from '../../i18n/locales/run-failures';

export interface RunState {
  status: MapDesignRunStatus | 'idle';
  messages: MapDesignMessage[];
  error: string | null;
  runId: string | null;
}

export const initialState: RunState = { status: 'idle', messages: [], error: null, runId: null };

export function eventFromJson(value: unknown): MapDesignRunEvent | null {
  const parsed = MapDesignRunEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function applyRunEventBatch(
  current: RunState,
  events: readonly MapDesignRunEvent[],
  options: {
    conversationId: string;
    fallbackRun: MapDesignRunResponse;
    startedAt: number;
    toolLoopDetectedMessage: string;
    imageErrors: { unsupported: string; tooLarge: string };
  },
): RunState {
  let messages = current.messages;
  let status = current.status;
  let error = current.error;
  for (const event of events) {
    if (event.type === 'event_snapshot') {
      const known = messages.some((message) => message.id === event.messageId);
      messages = known
        ? messages.map((message) => message.id === event.messageId
            ? { ...message, events: [...event.events] }
            : message)
        : [...messages, {
            id: event.messageId,
            conversationId: options.conversationId,
            role: 'assistant' as const,
            content: '',
            events: [...event.events],
            runStatus: current.status === 'idle' ? options.fallbackRun.status : current.status,
            startedAt: options.startedAt,
            endedAt: 0,
          }];
    } else if (event.type === 'message_completed') {
      messages = messages.some((message) => message.id === event.message.id)
        ? messages.map((message) => message.id === event.message.id ? event.message : message)
        : [...messages, event.message];
    } else if (event.type === 'error') {
      status = 'failed';
      error = localizedRunError(event.error, options.toolLoopDetectedMessage, options.imageErrors);
    } else if (event.type === 'run_finished') {
      status = event.run.status;
      error = event.run.error
        ? localizedRunError(event.run.error, options.toolLoopDetectedMessage, options.imageErrors)
        : error;
    }
  }
  return { ...current, messages, status, error };
}

export function localizedRunError(
  error: { code: string; message: string } | null | undefined,
  toolLoopDetectedMessage: string,
  imageErrors: { unsupported: string; tooLarge: string },
): string | null {
  if (!error) return null;
  if (error.code === 'IMAGE_INPUT_UNSUPPORTED') return imageErrors.unsupported;
  if (error.code === 'IMAGE_INPUT_TOO_LARGE') return imageErrors.tooLarge;
  return error.code === 'TOOL_LOOP_DETECTED' ? toolLoopDetectedMessage : error.message;
}

export function presentedRunError(error: string | null, locale: keyof typeof runFailureCopy): string | null {
  const copy = runFailureCopy[locale];
  return error && [
    'The Codex app-server connection ended unexpectedly.', 'The map run connection was lost.',
    'The map run stream could not be opened.',
  ].includes(error) ? copy.connection
    : error && ['The Codex turn failed before completion.', 'The map run failed.'].includes(error)
      ? copy.failed : error;
}

export async function* streamRunEvents(runId: string, signal: AbortSignal): AsyncGenerator<MapDesignRunEvent[]> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/events`, { signal, headers: { accept: 'text/event-stream' } });
  if (!response.ok || !response.body) throw new Error('The map run stream could not be opened.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    const accepted: MapDesignRunEvent[] = [];
    for (const frame of frames) {
      const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
      if (!line) continue;
      try {
        const event = eventFromJson(JSON.parse(line.slice(6)));
        if (event && (event.type === 'run_finished' ? event.run.runId : event.runId) === runId) accepted.push(event);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    yield accepted;
  }
}
export interface MapDesignRuntime {
  revision: number;
  agentId: string;
  label?: string;
  model?: string;
  reasoning?: string;
  serviceTier?: string;
  updatedAt?: string;
}

export interface UseMapDesignRunOptions {
  projectId: string;
  conversationId: string;
  runtime: MapDesignRuntime | null;
  readOnly?: boolean;
  viewedRevision?: number;
  readOnlyReason?: string | null;
  onStartAccepted?(): void | Promise<void>;
}
