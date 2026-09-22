import { describe, expect, it } from 'vitest';
import { applyStyleTransaction } from 'maplibre-style-tools/core';
import { createOpenAiFunctionTools } from 'maplibre-style-tools/capabilities';

import { nativeMapToolDefinitions } from '../../../src/map-design/tools/model-tool-definitions.js';

describe('model map tool definitions', () => {
  it('advertises SDK transaction operations instead of an arbitrary JSON value', () => {
    const apply = nativeMapToolDefinitions().find((tool) => tool.name === 'map_apply_transaction')!;
    const schema = apply.inputSchema as {
      properties: { transaction: { properties: { operations: { minItems?: number; items: { oneOf: unknown[] } } } } };
    };
    const operations = schema.properties.transaction.properties.operations;
    expect(operations.minItems).toBe(1);
    expect(JSON.stringify(operations.items)).toContain('setLayerProperties');
    expect(JSON.stringify(operations.items)).not.toContain('setPaintProperty');
  });

  it('does not let callers mutate the advertised SDK operation schema', () => {
    const apply = nativeMapToolDefinitions().find((tool) => tool.name === 'map_apply_transaction')!;
    const operations = (apply.inputSchema as {
      properties: { transaction: { properties: { operations: { minItems: number } } } };
    }).properties.transaction.properties.operations;

    expect(Object.isFrozen(operations)).toBe(true);
    expect(() => { operations.minItems = 99; }).toThrow(TypeError);
    const later = nativeMapToolDefinitions().find((tool) => tool.name === 'map_apply_transaction')!;
    expect((later.inputSchema as {
      properties: { transaction: { properties: { operations: { minItems: number } } } };
    }).properties.transaction.properties.operations.minItems).toBe(1);
  });

  it('pairs the SDK-derived frozen transaction schema with one exact valid dark-theme example', () => {
    const apply = nativeMapToolDefinitions().find((tool) => tool.name === 'map_apply_transaction')!;
    const transaction = (apply.inputSchema as {
      properties: { transaction: Record<string, unknown> };
    }).properties.transaction;
    const sdkTransaction = (createOpenAiFunctionTools()
      .find((tool) => tool.function.name === 'applyStyleTransaction')!
      .function.parameters as { properties: { transaction: Record<string, unknown> } })
      .properties.transaction;
    const operationShape = '{"transaction":{"operations":[{"op":"setLayerProperties","layerId":"background","paint":{"background-color":"#111318"}}],"validate":true},"intentSummary":"Apply dark theme background"}';

    expect(apply.description).toContain(operationShape);
    expect(apply.description).toMatch(/exact current Run.*expected revision.*batch/iu);
    expect(apply.description).toContain('shape only');
    expect(apply.description).not.toContain('dark-theme-001');
    const sdkOperations = sdkTransaction.properties as { operations: { items: { oneOf: unknown[] } } };
    const advertised = transaction.properties as { operations: { items: { oneOf: unknown[] } } };
    expect(advertised.operations.items.oneOf.slice(0, -1)).toEqual(sdkOperations.operations.items.oneOf);
    expect(advertised.operations.items.oneOf.at(-1)).toMatchObject({
      type: 'object', additionalProperties: false,
      properties: { op: { const: 'setLayersProperties' }, layerIds: { minItems: 1, maxItems: 100 } },
    });
    expect(Object.isFrozen(apply)).toBe(true);
    expect(Object.isFrozen(transaction)).toBe(true);
  });

  it('advertises a working inline GeoJSON point example', () => {
    const apply = nativeMapToolDefinitions().find((tool) => tool.name === 'map_apply_transaction')!;
    const example = JSON.parse(apply.description.split('Inline GeoJSON shape only: ')[1]!);
    const result = applyStyleTransaction({ version: 8, sources: {}, layers: [] }, example.transaction);
    expect(result.ok).toBe(true);
    expect(result.changedLayers).toEqual(['qa-points']);
    expect(result.changedSources).toEqual(['qa-points-source']);
    expect(result.style.layers[0]).toMatchObject({ type: 'circle', source: 'qa-points-source' });
    expect(result.style.sources['qa-points-source']).toMatchObject({ type: 'geojson', data: {
      type: 'FeatureCollection', features: [{ geometry: { type: 'Point', coordinates: [0, 0] } }],
    } });
  });

  it('directs discovery through search results and bounded transaction batches', () => {
    const definitions = nativeMapToolDefinitions();
    const search = definitions.find((tool) => tool.name === 'map_search_layers')!;
    const inspect = definitions.find((tool) => tool.name === 'map_inspect')!;
    const apply = definitions.find((tool) => tool.name === 'map_apply_transaction')!;

    expect(search.description).toMatch(/discover valid layer ids.*limit.*narrow quer/iu);
    expect(inspect.description).toMatch(/only ids returned.*never guess or brute-force/iu);
    expect(apply.description).toContain('Batch 1–100 SDK operations');
  });
});
