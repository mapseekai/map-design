import { createHash } from 'node:crypto';

import type { AgentToolName } from './types.js';

export type MapToolLoopVerdict = {
  action: 'warn' | 'halt';
  count: number;
  reason: 'repeated' | 'consecutive';
};

export interface MapToolLoopGuard {
  failure(
    name: AgentToolName,
    signature: string,
    failureClassSignature?: string,
    countConsecutive?: boolean,
  ): MapToolLoopVerdict | null;
  success(name: AgentToolName): void;
}

export type MapToolLoopGuardOptions = {
  repeatWarnAt?: number;
  repeatHaltAt?: number;
  consecutiveWarnAt?: number;
  consecutiveHaltAt?: number;
  maxSignatures?: number;
};

const DEFAULT_REPEAT_WARN_AT = 4;
const DEFAULT_REPEAT_HALT_AT = 8;
const DEFAULT_CONSECUTIVE_WARN_AT = 5;
const DEFAULT_CONSECUTIVE_HALT_AT = 10;
const DEFAULT_MAX_SIGNATURES = 128;
const MAX_SIGNATURE_LENGTH = 128;
const MAX_CANONICAL_DEPTH = 8;
const MAX_CANONICAL_NODES = 512;
const MAX_CANONICAL_COLLECTION_ITEMS = 64;
const MAX_CANONICAL_STRING_LENGTH = 512;
const MAX_OPTION_VALUE = 1_024;

export function createMapToolCallSignature(name: AgentToolName, input: unknown): string {
  const digest = createHash('sha256').update(boundedCanonicalJson(input)).digest('hex');
  return `${name}:${digest}`;
}

export function createMapToolFailureClassSignature(
  name: AgentToolName,
  failure: { code: string; retryable?: boolean; message?: unknown; details?: unknown },
): string | null {
  if (failure.retryable === true) return null;
  const details = failure.details && typeof failure.details === 'object' && !Array.isArray(failure.details)
    ? failure.details as Record<string, unknown>
    : null;
  const stableClass = {
    name,
    code: boundedFailureField(failure.code, 64),
    ...(typeof details?.firstPath === 'string'
      ? { firstPath: boundedFailureField(details.firstPath, 256) }
      : {}),
    ...(typeof details?.firstIssueCode === 'string'
      ? { firstIssueCode: boundedFailureField(details.firstIssueCode, 128) }
      : {}),
  };
  const digest = createHash('sha256').update(boundedCanonicalJson(stableClass)).digest('hex');
  return `${name}:class:${digest}`;
}

export function createMapToolLoopGuard(
  options: MapToolLoopGuardOptions = {},
): MapToolLoopGuard {
  const repeatWarnAt = threshold(options.repeatWarnAt, DEFAULT_REPEAT_WARN_AT);
  const repeatHaltAt = haltThreshold(options.repeatHaltAt, DEFAULT_REPEAT_HALT_AT, repeatWarnAt);
  const consecutiveWarnAt = threshold(
    options.consecutiveWarnAt,
    DEFAULT_CONSECUTIVE_WARN_AT,
  );
  const consecutiveHaltAt = haltThreshold(
    options.consecutiveHaltAt,
    DEFAULT_CONSECUTIVE_HALT_AT,
    consecutiveWarnAt,
  );
  const maxSignatures = threshold(options.maxSignatures, DEFAULT_MAX_SIGNATURES);
  const exactRepeatCounts = new Map<string, number>();
  const failureClassRepeatCounts = new Map<string, number>();
  let consecutiveCount = 0;
  let warningIssued = false;

  return {
    failure(name, signature, failureClassSignature, countConsecutive = true) {
      const exactRepeatCount = trackRepeat(exactRepeatCounts, name, signature);
      const classRepeatCount = failureClassSignature
        ? trackRepeat(failureClassRepeatCounts, name, failureClassSignature)
        : 0;
      const repeatCount = Math.max(exactRepeatCount, classRepeatCount);

      if (countConsecutive) {
        consecutiveCount = incrementBounded(consecutiveCount, consecutiveHaltAt);
      }

      if (repeatCount >= repeatHaltAt) {
        return { action: 'halt', count: repeatCount, reason: 'repeated' };
      }
      if (consecutiveCount >= consecutiveHaltAt) {
        return { action: 'halt', count: consecutiveCount, reason: 'consecutive' };
      }
      if (repeatCount === repeatWarnAt && !warningIssued) {
        warningIssued = true;
        return { action: 'warn', count: repeatCount, reason: 'repeated' };
      }
      if (consecutiveCount === consecutiveWarnAt && !warningIssued) {
        warningIssued = true;
        return { action: 'warn', count: consecutiveCount, reason: 'consecutive' };
      }
      return null;
    },
    success(name) {
      consecutiveCount = 0;
      warningIssued = false;
      clearToolCounts(failureClassRepeatCounts, name);
    },
  };

  function trackRepeat(counts: Map<string, number>, name: AgentToolName, signature: string): number {
    const key = `${name}:${signature.slice(0, MAX_SIGNATURE_LENGTH)}`;
    const count = incrementBounded(counts.get(key), repeatHaltAt);
    if (!counts.has(key) && counts.size >= maxSignatures) {
      const oldest = counts.keys().next().value;
      if (oldest !== undefined) counts.delete(oldest);
    }
    counts.delete(key);
    counts.set(key, count);
    return count;
  }
}

function clearToolCounts(counts: Map<string, number>, name: AgentToolName): void {
  const prefix = `${name}:`;
  for (const key of counts.keys()) {
    if (key.startsWith(prefix)) counts.delete(key);
  }
}

function boundedFailureField(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').slice(0, maximum);
}

function threshold(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? Math.min(value!, MAX_OPTION_VALUE)
    : fallback;
}

function haltThreshold(value: number | undefined, fallback: number, warnAt: number): number {
  const candidate = threshold(value, fallback);
  return candidate > warnAt ? candidate : Math.max(fallback, warnAt + 1);
}

function incrementBounded(value: number | undefined, limit: number): number {
  return Math.min((value ?? 0) + 1, limit);
}

function boundedCanonicalJson(value: unknown): string {
  let remainingNodes = MAX_CANONICAL_NODES;
  const ancestors = new WeakSet<object>();

  const encode = (current: unknown, depth: number): string => {
    if (remainingNodes <= 0) return '"[node-limit]"';
    remainingNodes -= 1;
    if (current === null) return 'null';
    if (typeof current === 'string') {
      return JSON.stringify(`${current.slice(0, MAX_CANONICAL_STRING_LENGTH)}:${current.length}`);
    }
    if (typeof current === 'number') {
      return Number.isFinite(current) ? JSON.stringify(current) : JSON.stringify(String(current));
    }
    if (typeof current === 'boolean') return String(current);
    if (typeof current === 'bigint') return JSON.stringify(`bigint:${String(current).slice(0, 64)}`);
    if (typeof current === 'undefined') return '"[undefined]"';
    if (typeof current === 'symbol') return '"[symbol]"';
    if (typeof current === 'function') return '"[function]"';
    if (depth >= MAX_CANONICAL_DEPTH) return '"[depth-limit]"';
    if (ancestors.has(current)) return '"[circular]"';
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const values = current
          .slice(0, MAX_CANONICAL_COLLECTION_ITEMS)
          .map((entry) => encode(entry, depth + 1));
        values.push(JSON.stringify(`[length:${current.length}]`));
        return `[${values.join(',')}]`;
      }
      const object = current as Record<string, unknown>;
      const keys = Object.keys(object).sort().slice(0, MAX_CANONICAL_COLLECTION_ITEMS);
      const entries = keys.map((key) => `${JSON.stringify(key)}:${encode(object[key], depth + 1)}`);
      entries.push(`${JSON.stringify('[key-count]')}:${Object.keys(object).length}`);
      return `{${entries.join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  };

  return encode(value, 0);
}
