import { describe, expect, it } from 'vitest';
import { summarizeNativeMapTool } from '../../../src/map-design/tools/safe-tool-summary.js';

const output = {
  draftRevision: 4, styleHash: 'a'.repeat(64), changedLayers: ['roads', 'paths'], changedSources: [],
  diff: [], warnings: [], validationSummary: { status: 'valid', errors: 0, warnings: 0, infos: 0,
    totalFindings: 0, returnedFindings: 0, omittedFindings: 0 },
};

describe('transaction summary operation counts', () => {
  it.each([
    { operation: { op: 'setLayerProperties', layerId: 'roads', layout: { visibility: 'none' } }, expanded: 1 },
    { operation: { op: 'setLayersProperties', layerIds: ['roads', 'paths'], layout: { visibility: 'none' } }, expanded: 2 },
  ])('reports requested and expanded operations for $operation.op', ({ operation, expanded }) => {
    const input = { expectedRevision: 3, idempotencyKey: 'summary-batch-1', intentSummary: 'Hide layers',
      transaction: { operations: [operation] } };
    const summary = summarizeNativeMapTool('map_apply_transaction', input, output);
    expect(summary).toMatchObject({ operationCount: 1, expandedOperationCount: expanded });
  });
});
