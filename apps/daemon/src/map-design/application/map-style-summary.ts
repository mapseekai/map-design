import {
  LayerTypeSchema,
  MAP_INSPECT_MAX_BYTES,
  MapInspectOutputSchema,
  MapStyleSourceTypeSchema,
  mapJsonByteLength,
  type MapInspectOutput,
  type MapLayerSummary,
  type MapStyleSourceSummary,
  type MapStyleSummary,
} from '@mapseekai/map-design-contracts';
import type { StyleDocument } from 'maplibre-style-tools/core';

export function summarizeMapLayer(layer: StyleDocument['layers'][number]): MapLayerSummary {
  const metadata = isRecord(layer.metadata) ? layer.metadata : undefined;
  const title = typeof metadata?.title === 'string' && metadata.title.trim()
    ? metadata.title.trim().slice(0, 256)
    : undefined;
  return {
    id: layer.id,
    type: LayerTypeSchema.parse(layer.type),
    ...(title ? { title } : {}),
    ...(typeof layer.source === 'string' ? { sourceId: layer.source } : {}),
    ...(typeof layer['source-layer'] === 'string' ? { sourceLayer: layer['source-layer'] } : {}),
    ...(typeof layer.minzoom === 'number' ? { minzoom: layer.minzoom } : {}),
    ...(typeof layer.maxzoom === 'number' ? { maxzoom: layer.maxzoom } : {}),
  };
}

export function summarizeMapStyle(style: StyleDocument): MapStyleSummary {
  return {
    layerCount: style.layers.length,
    sourceCount: Object.keys(style.sources).length,
    layerTypes: [...new Set(style.layers.map((layer) => LayerTypeSchema.parse(layer.type)))],
  };
}

export function summarizeMapSources(style: StyleDocument): MapStyleSourceSummary[] {
  return Object.entries(style.sources).map(([id, source]) => {
    const layers = style.layers.filter((layer) => layer.source === id);
    return {
      id,
      kind: MapStyleSourceTypeSchema.parse(source.type),
      sourceLayerCount: new Set(layers.flatMap((layer) => (
        typeof layer['source-layer'] === 'string' ? [layer['source-layer']] : []
      ))).size,
      layerCount: layers.length,
    };
  });
}

export function inspectMapStyleRoot(style: StyleDocument): MapInspectOutput {
  const allLayers = style.layers.map(summarizeMapLayer);
  const allSources = summarizeMapSources(style);
  const output: MapInspectOutput = {
    target: { kind: 'root' },
    view: {
      kind: 'root',
      style: summarizeMapStyle(style),
      layers: allLayers.slice(0, 100),
      sources: allSources.slice(0, 100),
    },
    truncated: allLayers.length > 100 || allSources.length > 100,
  };
  while (mapJsonByteLength(output) > MAP_INSPECT_MAX_BYTES && output.view.kind === 'root') {
    if (output.view.layers.length > 0) output.view.layers.pop();
    else if (output.view.sources.length > 0) output.view.sources.pop();
    else break;
    output.truncated = true;
  }
  return MapInspectOutputSchema.parse(output);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
