import { Buffer } from 'node:buffer';

import {
  MapDesignMessageSchema,
  PersistedMapAgentEventsSchema,
  type MapDesignMessage,
  type MapDesignMessageError,
  type PersistedMapAgentEvent,
  type SafeToolSummary,
} from '@mapseekai/contracts';

import { containsSensitivePublicText, toSafeToolSummary } from '../tools/safe-tool-summary.js';

const MAX_EVENT_ENTRIES = 80;
const MAX_EVENT_BYTES = 65_536;
const MAX_EVENT_TEXT_CODE_POINTS = 8_192;
const MAX_THINKING_CODE_POINTS = 2_048;
const MAX_TOOL_NAME_CODE_POINTS = 160;
const MAX_TOOL_SUMMARY_BYTES = 8_192;
const OMITTED_TOOL_ID = 'tools-omitted';

export class RunEventAccumulator {
  private readonly events: PersistedMapAgentEvent[] = [];
  private readonly terminalToolIds = new Set<string>();
  private finished = false;

  apply(event: PersistedMapAgentEvent): boolean {
    if (this.finished) return false;
    const sanitized = sanitizeRunEvent(event);
    if (!sanitized) return false;

    if (sanitized.kind === 'thinking') {
      const current = this.events.at(-1);
      if (current?.kind === 'thinking') {
        current.text = appendBoundedEventText(
          current.text,
          sanitized.text,
          'Summary unavailable.',
          MAX_THINKING_CODE_POINTS,
        );
        return true;
      }
      this.events.push(sanitized);
      return true;
    }
    if (sanitized.kind === 'text') {
      const current = this.events.at(-1);
      if (current?.kind === 'text') {
        current.text = appendBoundedEventText(
          current.text,
          sanitized.text,
          'Content unavailable.',
          MAX_EVENT_TEXT_CODE_POINTS,
        );
        return true;
      }
      this.events.push(sanitized);
      return true;
    }

    if (sanitized.kind === 'tool_use') {
      if (this.events.some((candidate) => candidate.kind === 'tool_use' && candidate.id === sanitized.id)) return false;
    } else if (sanitized.kind === 'tool_result') {
      if (this.terminalToolIds.has(sanitized.toolUseId)) return false;
      if (!this.events.some((candidate) => candidate.kind === 'tool_use' && candidate.id === sanitized.toolUseId)) return false;
      this.terminalToolIds.add(sanitized.toolUseId);
    } else if (sanitized.kind === 'run_finished') {
      this.finished = true;
    }
    this.events.push(sanitized);
    return true;
  }

  finish(
    status: Extract<PersistedMapAgentEvent, { kind: 'run_finished' }>['status'],
    error: MapDesignMessageError | undefined,
    now: number,
  ): boolean {
    void error;
    void now;
    return this.apply({ kind: 'run_finished', status });
  }

  snapshot(): PersistedMapAgentEvent[] {
    const events = this.events
      .map((event) => sanitizeRunEvent(event))
      .filter((event): event is PersistedMapAgentEvent => event !== null);
    boundSnapshot(events);
    return PersistedMapAgentEventsSchema.parse(events);
  }
}

export function fitMapDesignMessageToBudget(message: MapDesignMessage): MapDesignMessage {
  const candidate = structuredClone(message);
  if (messageFits(candidate)) return MapDesignMessageSchema.parse(candidate);

  const latestTerminalToolId = [...candidate.events]
    .reverse()
    .find((event): event is Extract<PersistedMapAgentEvent, { kind: 'tool_result' }> => event.kind === 'tool_result')
    ?.toolUseId;
  while (!messageFits(candidate)) {
    const removableIndex = candidate.events.findIndex((event) => (
      event.kind !== 'run_finished'
      && !(event.kind === 'tool_use' && event.id === latestTerminalToolId)
      && !(event.kind === 'tool_result' && event.toolUseId === latestTerminalToolId)
    ));
    if (removableIndex < 0) break;
    removeEventEvidence(candidate.events, removableIndex);
  }

  if (!messageFits(candidate)) candidate.content = truncateContentToMessageBudget(candidate);
  return MapDesignMessageSchema.parse(candidate);
}

export function sanitizeEventText(value: unknown, fallback: string, maximumCodePoints: number): string {
  const raw = typeof value === 'string' ? value : '';
  const normalized = raw.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '');
  const trimmed = normalized.trim();
  if (isProviderConnectionFailure(trimmed)) {
    return truncateCodePoints('The local agent could not connect to its model provider.', maximumCodePoints);
  }
  if (!trimmed || containsSensitiveText(normalized)) return truncateCodePoints(fallback, maximumCodePoints);
  return truncateCodePoints(normalized, maximumCodePoints);
}

export function containsSensitiveText(value: string): boolean {
  return containsSensitivePublicText(value);
}

function sanitizeRunEvent(event: PersistedMapAgentEvent): PersistedMapAgentEvent | null {
  switch (event.kind) {
    case 'status':
    case 'run_finished':
      return { ...event };
    case 'thinking':
      return { kind: 'thinking', text: sanitizeEventText(event.text, 'Summary unavailable.', MAX_THINKING_CODE_POINTS) };
    case 'text':
      return { kind: 'text', text: sanitizeTextDelta(event.text) };
    case 'tool_use': {
      if (!isSafeToolId(event.id)) return null;
      return {
        kind: 'tool_use',
        id: event.id,
        name: sanitizeEventText(event.name, 'map_tool', MAX_TOOL_NAME_CODE_POINTS).trim(),
        summary: sanitizeSummary(event.summary),
      };
    }
    case 'tool_result':
      if (!isSafeToolId(event.toolUseId)) return null;
      return {
        kind: 'tool_result',
        toolUseId: event.toolUseId,
        status: event.status,
        summary: sanitizeSummary(event.summary),
      };
  }
}

function sanitizeTextDelta(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  const normalized = raw
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
  if (/^[\t\n ]+$/u.test(normalized)) {
    return truncateCodePoints(normalized, MAX_EVENT_TEXT_CODE_POINTS);
  }
  const trimmed = normalized.trim();
  if (isProviderConnectionFailure(trimmed)) {
    return truncateCodePoints(
      'The local agent could not connect to its model provider.',
      MAX_EVENT_TEXT_CODE_POINTS,
    );
  }
  if (!trimmed || containsSensitiveText(normalized)) {
    return truncateCodePoints('Content unavailable.', MAX_EVENT_TEXT_CODE_POINTS);
  }
  return truncateCodePoints(normalized, MAX_EVENT_TEXT_CODE_POINTS);
}

function sanitizeSummary(value: SafeToolSummary): SafeToolSummary {
  const filtered = toSafeToolSummary(value);
  const bounded: SafeToolSummary = {};
  for (const [key, item] of Object.entries(filtered)) {
    const candidate = { ...bounded, [key]: item };
    if (serializedBytes(candidate) > MAX_TOOL_SUMMARY_BYTES) break;
    bounded[key] = item;
  }
  return bounded;
}

function boundSnapshot(events: PersistedMapAgentEvent[]): void {
  const latestTerminalToolId = [...events]
    .reverse()
    .find((event): event is Extract<PersistedMapAgentEvent, { kind: 'tool_result' }> => event.kind === 'tool_result')
    ?.toolUseId;
  let omitted = 0;
  let omittedFailures = 0;
  let aggregateIndex = events.length;

  while (snapshotExceedsBounds(events, omitted)) {
    const pair = firstCollapsibleToolPair(events, latestTerminalToolId);
    if (!pair) break;
    aggregateIndex = Math.min(aggregateIndex, pair.useIndex);
    if (pair.result.status === 'failed') omittedFailures += 1;
    events.splice(pair.resultIndex, 1);
    events.splice(pair.useIndex, 1);
    omitted += 1;
  }

  if (omitted > 0) {
    events.splice(Math.min(aggregateIndex, events.length), 0,
      { kind: 'tool_use', id: OMITTED_TOOL_ID, name: 'map_tools', summary: { omitted } },
      { kind: 'tool_result', toolUseId: OMITTED_TOOL_ID, status: omittedFailures > 0 ? 'failed' : 'succeeded', summary: { omitted, failures: omittedFailures } });
  }

  while (events.length > MAX_EVENT_ENTRIES || serializedBytes(events) > MAX_EVENT_BYTES) {
    const removable = events.findIndex((event) => (
      event.kind !== 'run_finished'
      && !(event.kind === 'tool_use' && (event.id === latestTerminalToolId || event.id === OMITTED_TOOL_ID))
      && !(event.kind === 'tool_result' && (event.toolUseId === latestTerminalToolId || event.toolUseId === OMITTED_TOOL_ID))
    ));
    if (removable < 0) break;
    events.splice(removable, 1);
  }
}

function snapshotExceedsBounds(events: PersistedMapAgentEvent[], omitted: number): boolean {
  const aggregate = omitted === 0 ? [] : [
    { kind: 'tool_use', id: OMITTED_TOOL_ID, name: 'map_tools', summary: { omitted } },
    { kind: 'tool_result', toolUseId: OMITTED_TOOL_ID, status: 'succeeded', summary: { omitted, failures: 0 } },
  ];
  return events.length + aggregate.length > MAX_EVENT_ENTRIES
    || serializedBytes([...events, ...aggregate]) > MAX_EVENT_BYTES;
}

function firstCollapsibleToolPair(
  events: PersistedMapAgentEvent[],
  protectedToolId: string | undefined,
): {
  useIndex: number;
  resultIndex: number;
  result: Extract<PersistedMapAgentEvent, { kind: 'tool_result' }>;
} | null {
  for (let resultIndex = 0; resultIndex < events.length; resultIndex += 1) {
    const result = events[resultIndex];
    if (result?.kind !== 'tool_result' || result.toolUseId === protectedToolId || result.toolUseId === OMITTED_TOOL_ID) continue;
    const useIndex = events.findIndex((candidate, index) => index < resultIndex
      && candidate.kind === 'tool_use'
      && candidate.id === result.toolUseId);
    if (useIndex >= 0) return { useIndex, resultIndex, result };
  }
  return null;
}

function removeEventEvidence(events: PersistedMapAgentEvent[], index: number): void {
  const event = events[index];
  if (event?.kind === 'tool_use') {
    const resultIndex = events.findIndex((candidate) => candidate.kind === 'tool_result' && candidate.toolUseId === event.id);
    if (resultIndex > index) events.splice(resultIndex, 1);
  } else if (event?.kind === 'tool_result') {
    const useIndex = events.findIndex((candidate, candidateIndex) => candidateIndex < index
      && candidate.kind === 'tool_use'
      && candidate.id === event.toolUseId);
    if (useIndex >= 0) {
      events.splice(index, 1);
      events.splice(useIndex, 1);
      return;
    }
  }
  events.splice(index, 1);
}

function truncateContentToMessageBudget(message: MapDesignMessage): string {
  const codePoints = Array.from(message.content);
  let low = 0;
  let high = codePoints.length;
  let best = '…';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const content = `${codePoints.slice(0, middle).join('')}…`;
    if (messageFits({ ...message, content })) {
      best = content;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function messageFits(message: MapDesignMessage): boolean {
  return MapDesignMessageSchema.safeParse(message).success;
}

function isSafeToolId(value: unknown): value is string {
  return typeof value === 'string'
    && value !== OMITTED_TOOL_ID
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value)
    && !containsSensitiveText(value);
}

function isProviderConnectionFailure(value: string): boolean {
  return /(?:unable to connect|connection\s+(?:closed|reset|refused|timed out)|error sending request|fetch failed|network error|proxy error)/iu.test(value);
}

function appendBoundedEventText(
  current: string,
  delta: string,
  fallback: string,
  maximumCodePoints: number,
): string {
  const combined = `${current}${delta}`;
  const trimmed = combined.trim();
  if (isProviderConnectionFailure(trimmed)) {
    return truncateCodePoints(
      'The local agent could not connect to its model provider.',
      maximumCodePoints,
    );
  }
  if (!trimmed || containsSensitiveText(combined)) {
    return truncateCodePoints(fallback, maximumCodePoints);
  }
  return retainLatestCodePoints(combined, maximumCodePoints);
}

function retainLatestCodePoints(value: string, maximumCodePoints: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= maximumCodePoints) return value;
  if (maximumCodePoints <= 1) return maximumCodePoints === 1 ? '…' : '';
  return `…${codePoints.slice(-(maximumCodePoints - 1)).join('')}`;
}

function truncateCodePoints(value: string, maximumCodePoints: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= maximumCodePoints) return value;
  if (maximumCodePoints <= 1) return maximumCodePoints === 1 ? '…' : '';
  return `${codePoints.slice(0, maximumCodePoints - 1).join('')}…`;
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
