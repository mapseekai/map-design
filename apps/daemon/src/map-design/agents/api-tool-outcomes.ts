import { canonicalJson } from '../storage/canonical-json.js';

type Failure = { name: string; fingerprint: string | null; retryOf?: string };

/** A later success of the same tool is NOT evidence that an earlier operation was repaired. */
export class ApiToolOutcomes {
  private readonly failures = new Map<string, Failure>();
  private readonly repeated = new Map<string, number>();
  get unresolvedCallIds(): string[] { return [...this.failures.keys()]; }
  get unresolved(): number { return this.failures.size; }
  get looping(): boolean { return [...this.repeated.values()].some((count) => count >= 3); }

  validateRetry(name: string, args: Record<string, unknown>, retryOf: unknown): string | undefined {
    if (retryOf === undefined) return undefined;
    if (typeof retryOf !== 'string') throw new TypeError('Invalid retry reference');
    const failed = this.failures.get(retryOf);
    if (!failed || failed.name !== name || (failed.fingerprint !== null && failed.fingerprint !== fingerprint(name, args))) {
      throw new TypeError('Retry must reference an unresolved call with the same operation');
    }
    return retryOf;
  }

  failed(id: string, name: string, args: Record<string, unknown> | null, retryOf?: string): void {
    const signature = args === null ? null : fingerprint(name, args);
    this.failures.set(id, { name, fingerprint: signature, ...(retryOf ? { retryOf } : {}) });
    const key = canonicalJson([name, signature]);
    this.repeated.set(key, (this.repeated.get(key) ?? 0) + 1);
  }

  succeeded(name: string, args: Record<string, unknown>, retryOf?: string): void {
    this.repeated.delete(canonicalJson([name, fingerprint(name, args)]));
    const visited = new Set<string>();
    for (let id = retryOf; id && !visited.has(id);) {
      visited.add(id);
      const failure = this.failures.get(id);
      if (!failure) break;
      this.failures.delete(id);
      id = failure.retryOf;
    }
  }
}

function fingerprint(name: string, args: Record<string, unknown>): string {
  if (name === 'map_commit_revision') {
    // A commit may refresh preview evidence, but must still save the same draft.
    const { previewId: _preview, idempotencyKey: _key, intentSummary: _summary, ...commit } = args;
    return canonicalJson(commit);
  }
  // Revision/idempotency metadata must change on a safe retry; semantic arguments must not.
  const { expectedRevision: _revision, idempotencyKey: _key, intentSummary: _summary, ...operation } = args;
  return canonicalJson(operation);
}
