import { describe, it } from 'vitest';

export interface MapAgentAdapterConformanceCases {
  registration(): Promise<void> | void;
  correlatedResult(): Promise<void> | void;
  normalizedEvents(): Promise<void> | void;
  cancellation(): Promise<void> | void;
  malformedAndOversizedFrames(): Promise<void> | void;
  duplicateCalls(): Promise<void> | void;
  loopGuard(): Promise<void> | void;
  sessionResumeOrReseed(): Promise<void> | void;
  lateEventRejection(): Promise<void> | void;
}

/**
 * Shared behavioral baseline for every concrete Map Agent adapter.
 *
 * Each case drives the real transport adapter through a deterministic fake of
 * its external process or SDK boundary. The mandatory shape prevents a newly
 * registered adapter from silently omitting a lifecycle or protocol invariant.
 */
export function defineMapAgentAdapterConformance(
  adapterName: string,
  cases: MapAgentAdapterConformanceCases,
): void {
  describe(`${adapterName} adapter conformance`, () => {
    it('registers the complete native tool definition set', cases.registration);
    it('returns one result correlated to its native tool call', cases.correlatedResult);
    it('normalizes public thinking, text, tool, and terminal events', cases.normalizedEvents);
    it('cancels through the native transport exactly once', cases.cancellation);
    it('fails closed on malformed and oversized transport frames', cases.malformedAndOversizedFrames);
    it('does not execute a duplicate tool-call identifier twice', cases.duplicateCalls);
    it('halts a bounded repeated-failure tool loop', cases.loopGuard);
    it('resumes its own session or reseeds an isolated session', cases.sessionResumeOrReseed);
    it('rejects transport events after terminal state', cases.lateEventRejection);
  });
}
