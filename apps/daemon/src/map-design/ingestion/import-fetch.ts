import { setTimeout as delay } from 'node:timers/promises';

import { FETCH_LIMITS } from './fetch-limits.js';
import type { PinnedFetchRequest, PinnedFetchResponse, PinnedTransport } from './pinned-transport.js';

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;

/** Carries only safe HTTP metadata, never response bodies, URLs or credentials. */
export class ImportHttpError extends Error {
  constructor(readonly status: number, readonly phase: 'source' | 'source-metadata') {
    super(`The remote map service returned HTTP ${status} during ${phase} download.`);
    this.name = 'ImportHttpError';
  }
}

/** Idempotent GET retries share one deadline and the caller's cancellation. */
export async function fetchImportResource(
  transport: PinnedTransport,
  request: PinnedFetchRequest,
): Promise<PinnedFetchResponse> {
  const budgetMs = FETCH_LIMITS[request.purpose].totalTimeoutMs;
  const deadline = Date.now() + budgetMs;
  const deadlineSignal = AbortSignal.timeout(budgetMs);
  const signal = request.signal ? AbortSignal.any([request.signal, deadlineSignal]) : deadlineSignal;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const response = await transport.fetch({ ...request, signal });
    if (!RETRYABLE_STATUSES.has(response.status) || attempt >= MAX_RETRIES) return response;
    const backoffMs = 1_000 * 2 ** attempt;
    const retryAfterMs = parseRetryAfter(response.headers['retry-after'], Date.now());
    const waitMs = Math.max(backoffMs, retryAfterMs ?? 0);
    // Never ignore a long Retry-After, or extend the original request budget.
    if (waitMs >= deadline - Date.now()) return response;
    await delay(waitMs, undefined, { signal });
  }
}

function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (!value?.trim()) return null;
  const text = value.trim();
  if (/^\d+$/u.test(text)) return Number(text) * 1_000;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

export function importHttpFailure(error: unknown): { code: string; message: string } | null {
  if (!(error instanceof ImportHttpError)) return null;
  return error.status === 429
    ? { code: 'IMPORT_RATE_LIMITED', message: 'The remote map service is rate-limiting requests (HTTP 429). Please retry later.' }
    : { code: 'IMPORT_HTTP_FAILED', message: error.message };
}
