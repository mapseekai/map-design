import {
  MAP_TOOL_NAMES,
  MapToolJsonInputSchemas,
  type MapToolName,
} from '@mapseekai/map-design-contracts';
import { createOpenAiFunctionTools } from 'maplibre-style-tools/capabilities';

import type { NativeMapToolDefinition } from './tool-context.js';

const SDK_DARK_TRANSACTION_SHAPE = '{"transaction":{"operations":[{"op":"setLayerProperties","layerId":"background","paint":{"background-color":"#111318"}}],"validate":true},"intentSummary":"Apply dark theme background"}';

const SDK_GEOJSON_TRANSACTION_SHAPE = '{"transaction":{"operations":[{"op":"addGeoJsonLayer","sourceId":"qa-points-source","layerId":"qa-points","data":{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[0,0]},"properties":{}}]},"type":"circle","paint":{"circle-radius":6,"circle-color":"#ff0000"}}],"validate":true},"intentSummary":"Add an inline GeoJSON point"}';

const TOOL_DESCRIPTIONS: Record<MapToolName, string> = {
  map_get_context: 'Read the current canonical MapDesign project context.',
  map_inspect: 'Inspect a map root, layer, source, or source-layer. Use only IDs returned by map_get_context or map_search_layers; never guess or brute-force IDs.',
  map_search_layers: 'Discover valid layer IDs. Use limit and narrow query, type, source, or source-layer filters before inspecting.',
  map_apply_transaction: `Apply an idempotent transaction to the current map draft. For every new logical batch, derive the public idempotencyKey from the exact current Run, expected revision, and batch number. Examples are shapes only; never reuse a literal key. Batch 1–100 SDK operations and carry the returned revision into the next batch. Operation shape only: ${SDK_DARK_TRANSACTION_SHAPE} For inline GeoJSON, addGeoJsonLayer adds the source and layer together; choose unused sourceId/layerId values. Inline GeoJSON shape only: ${SDK_GEOJSON_TRANSACTION_SHAPE}`,
  map_update_semantics: 'Replace the semantic document for the current map draft.',
  map_validate: 'Validate the current map draft revision.',
  map_render_preview: 'Render and wait for a preview of the current map draft.',
  map_commit_revision: 'Commit a validated preview as a durable map revision.',
  map_discard_draft: 'Discard draft changes and restore the committed map revision.',
};

const sdkApply = createOpenAiFunctionTools()
  .find((tool) => tool.function.name === 'applyStyleTransaction');

function applyTransactionEnvelope(): Record<string, unknown> {
  const base = structuredClone(MapToolJsonInputSchemas.map_apply_transaction) as {
    properties: Record<string, unknown>;
  };
  const parameters = sdkApply?.function.parameters as {
    properties?: Record<string, unknown>;
  } | undefined;
  const transaction = parameters?.properties?.transaction;
  if (!transaction) throw new TypeError('MapLibre transaction model schema is unavailable.');
  return { ...base, properties: { ...base.properties, transaction: structuredClone(transaction) } };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

const DEFINITIONS = deepFreeze(MAP_TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: name === 'map_apply_transaction'
      ? applyTransactionEnvelope()
      : structuredClone(MapToolJsonInputSchemas[name]) as Record<string, unknown>,
  })));

export function nativeMapToolDefinitions(): readonly NativeMapToolDefinition[] {
  return DEFINITIONS;
}
