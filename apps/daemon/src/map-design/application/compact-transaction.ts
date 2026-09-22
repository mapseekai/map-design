import { MAP_TRANSACTION_MAX_OPERATIONS, MapSetLayersPropertiesOperationSchema } from '@mapseekai/map-design-contracts';
import { MapDraftError } from './errors.js';

export function expandMapTransaction(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.operations)) return input;
  const operations: unknown[] = [];
  for (const [index, operation] of input.operations.entries()) {
    if (isRecord(operation) && operation.op === 'setLayersProperties') {
      const parsed = MapSetLayersPropertiesOperationSchema.safeParse(operation);
      if (!parsed.success) throw invalidCompactTransaction(index);
      const { op: _op, layerIds, ...properties } = parsed.data;
      for (const layerId of layerIds) operations.push({ op: 'setLayerProperties', layerId, ...structuredClone(properties) });
    } else {
      operations.push(operation);
    }
    if (operations.length > MAP_TRANSACTION_MAX_OPERATIONS) throw invalidCompactTransaction(index);
  }
  return { ...input, operations };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidCompactTransaction(index: number): MapDraftError {
  return new MapDraftError('INVALID_INPUT', 'The compact transaction must use unique layer IDs, supported properties, and at most 100 expanded operations.', {
    details: { category: 'INVALID_INPUT', operationIndex: index, firstPath: `transaction.operations.${index}` },
  });
}
