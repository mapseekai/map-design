import { describe, expect, it } from 'vitest';

import {
  createMapToolCallSignature,
  createMapToolFailureClassSignature,
  createMapToolLoopGuard,
} from '../../../src/map-design/agents/map-tool-loop-guard.js';

describe('Map tool loop guard', () => {
  it('warns and halts a repeated invalid mutation at bounded thresholds', () => {
    const guard = createMapToolLoopGuard();
    const signature = 'map_apply_transaction:abc123';

    for (let count = 1; count <= 8; count += 1) {
      const verdict = guard.failure('map_apply_transaction', signature);
      if (count === 4) {
        expect(verdict).toEqual({ action: 'warn', count: 4, reason: 'repeated' });
      } else if (count === 8) {
        expect(verdict).toEqual({ action: 'halt', count: 8, reason: 'repeated' });
      } else {
        expect(verdict).toBeNull();
      }
    }
  });

  it('warns and halts consecutive distinct failures at bounded thresholds', () => {
    const guard = createMapToolLoopGuard();

    for (let count = 1; count <= 10; count += 1) {
      const verdict = guard.failure('map_apply_transaction', `different-${count}`);
      if (count === 5) {
        expect(verdict).toEqual({ action: 'warn', count: 5, reason: 'consecutive' });
      } else if (count === 10) {
        expect(verdict).toEqual({ action: 'halt', count: 10, reason: 'consecutive' });
      } else {
        expect(verdict).toBeNull();
      }
    }
  });

  it('resets consecutive failures after a successful mutation', () => {
    const guard = createMapToolLoopGuard();
    for (let count = 0; count < 4; count += 1) {
      guard.failure('map_apply_transaction', `different-${count}`);
    }

    guard.success('map_apply_transaction');

    expect(guard.failure('map_apply_transaction', 'next')).toBeNull();
  });

  it('creates a bounded canonical digest without retaining raw arguments', () => {
    const first = createMapToolCallSignature('map_apply_transaction', {
      expectedRevision: 3,
      secret: 'raw-secret-value',
      transaction: { operations: [{ layerId: 'roads', op: 'setLayerProperties' }] },
    });
    const reordered = createMapToolCallSignature('map_apply_transaction', {
      transaction: { operations: [{ op: 'setLayerProperties', layerId: 'roads' }] },
      secret: 'raw-secret-value',
      expectedRevision: 3,
    });

    expect(first).toBe(reordered);
    expect(first).toMatch(/^map_apply_transaction:[a-f0-9]{64}$/);
    expect(first).not.toContain('raw-secret-value');
  });

  it('warns and halts one safe failure class across distinct exact inputs', () => {
    const guard = createMapToolLoopGuard();
    const failureClass = createMapToolFailureClassSignature('map_inspect', {
      code: 'NOT_FOUND',
      message: 'guessed-layer-secret',
      details: undefined,
    });
    if (!failureClass) throw new TypeError('expected non-retryable failure class');

    for (let count = 1; count <= 8; count += 1) {
      const verdict = guard.failure('map_inspect', `exact-${count}`, failureClass);
      if (count === 4) {
        expect(verdict).toEqual({ action: 'warn', count: 4, reason: 'repeated' });
      } else if (count === 8) {
        expect(verdict).toEqual({ action: 'halt', count: 8, reason: 'repeated' });
      } else {
        expect(verdict).toBeNull();
      }
    }
  });

  it('hashes only the stable safe failure class fields', () => {
    const first = createMapToolFailureClassSignature('map_apply_transaction', {
      code: 'INVALID_INPUT',
      message: 'raw provider secret A',
      details: {
        firstPath: 'transaction.operations.0.op',
        firstIssueCode: 'invalid_union',
        unsafe: 'raw argument A',
      },
    });
    const sameSafeClass = createMapToolFailureClassSignature('map_apply_transaction', {
      code: 'INVALID_INPUT',
      message: 'raw provider secret B',
      details: {
        firstPath: 'transaction.operations.0.op',
        firstIssueCode: 'invalid_union',
        unsafe: 'raw argument B',
      },
    });

    expect(first).toBe(sameSafeClass);
    expect(first).toMatch(/^map_apply_transaction:class:[a-f0-9]{64}$/u);
    expect(first).not.toMatch(/provider secret|raw argument|transaction\.operations/iu);
  });

  it('does not pool heterogeneous failure classes across healthy successes', () => {
    const guard = createMapToolLoopGuard();

    for (let epoch = 0; epoch < 2; epoch += 1) {
      for (let count = 1; count <= 4; count += 1) {
        const failureClass = createMapToolFailureClassSignature('map_inspect', {
          code: count % 2 === 0 ? 'INVALID_INPUT' : 'NOT_FOUND',
          details: { firstPath: `target.${epoch}.${count}`, firstIssueCode: `issue_${count}` },
        });
        if (!failureClass) throw new TypeError('expected non-retryable failure class');
        expect(guard.failure('map_inspect', `exact-${epoch}-${count}`, failureClass)).toBeNull();
      }
      guard.success('map_inspect');
    }
  });

  it('resets the same coarse failure class after a healthy success', () => {
    const guard = createMapToolLoopGuard();
    const failureClass = createMapToolFailureClassSignature('map_inspect', {
      code: 'NOT_FOUND',
    });
    if (!failureClass) throw new TypeError('expected non-retryable failure class');

    for (let count = 1; count <= 3; count += 1) {
      expect(guard.failure('map_inspect', `before-success-${count}`, failureClass)).toBeNull();
    }
    guard.success('map_inspect');
    for (let count = 1; count <= 3; count += 1) {
      expect(guard.failure('map_inspect', `after-success-${count}`, failureClass)).toBeNull();
    }
    expect(guard.failure('map_inspect', 'after-success-4', failureClass)).toEqual({
      action: 'warn',
      count: 4,
      reason: 'repeated',
    });
  });

  it('keeps distinct retryable failures on the exact-digest counter only', () => {
    const guard = createMapToolLoopGuard();

    for (let count = 1; count <= 8; count += 1) {
      expect(guard.failure('map_inspect', `retryable-exact-${count}`, undefined, false)).toBeNull();
    }
  });

  it('warns and halts one Run-wide consecutive streak across alternating tools', () => {
    const guard = createMapToolLoopGuard();

    for (let count = 1; count <= 10; count += 1) {
      const name = count % 2 === 0 ? 'map_search_layers' : 'map_inspect';
      const failureClass = createMapToolFailureClassSignature(name, {
        code: 'INVALID_INPUT',
        details: { firstPath: `target.${count}`, firstIssueCode: `issue_${count}` },
      });
      if (!failureClass) throw new TypeError('expected non-retryable failure class');
      const verdict = guard.failure(name, `mixed-${count}`, failureClass);
      if (count === 5) {
        expect(verdict).toEqual({ action: 'warn', count: 5, reason: 'consecutive' });
      } else if (count === 10) {
        expect(verdict).toEqual({ action: 'halt', count: 10, reason: 'consecutive' });
      } else {
        expect(verdict).toBeNull();
      }
    }
  });

  it('resets the Run-wide consecutive streak after a cross-tool success', () => {
    const guard = createMapToolLoopGuard();
    const fail = (count: number) => {
      const name = count % 2 === 0 ? 'map_search_layers' as const : 'map_inspect' as const;
      const failureClass = createMapToolFailureClassSignature(name, {
        code: 'INVALID_INPUT',
        details: { firstPath: `mixed.${count}`, firstIssueCode: `issue_${count}` },
      });
      if (!failureClass) throw new TypeError('expected non-retryable failure class');
      return guard.failure(name, `cross-tool-${count}`, failureClass);
    };

    for (let count = 1; count <= 4; count += 1) expect(fail(count)).toBeNull();
    guard.success('map_get_context');
    for (let count = 5; count <= 8; count += 1) expect(fail(count)).toBeNull();
    expect(fail(9)).toEqual({ action: 'warn', count: 5, reason: 'consecutive' });
  });
});
