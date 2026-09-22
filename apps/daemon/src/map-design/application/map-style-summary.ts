import {
  LayerTypeSchema,
  MAP_LAYER_READ_DEFAULT_BYTES,
  MAP_LAYER_READ_MAX,
  MapInspectOutputSchema,
  MapStyleSourceTypeSchema,
  mapJsonByteLength,
  type MapInspectOutput,
  type MapInspectInput,
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
  const counts = new Map<string, { layerCount: number; sourceLayers: Set<string> }>();
  for (const layer of style.layers) {
    if (typeof layer.source !== 'string') continue;
    const count = counts.get(layer.source) ?? { layerCount: 0, sourceLayers: new Set<string>() };
    count.layerCount += 1;
    if (typeof layer['source-layer'] === 'string') count.sourceLayers.add(layer['source-layer']);
    counts.set(layer.source, count);
  }
  return Object.entries(style.sources).map(([id, source]) => {
    const count = counts.get(id);
    return {
      id,
      kind: MapStyleSourceTypeSchema.parse(source.type),
      sourceLayerCount: count?.sourceLayers.size ?? 0,
      layerCount: count?.layerCount ?? 0,
    };
  });
}

export function inspectMapStyleRoot(style: StyleDocument, input: Pick<MapInspectInput, 'maxBytes' | 'offset' | 'sourceOffset'> = {}): MapInspectOutput {
  const allSources = summarizeMapSources(style);
  const offset = input.offset ?? 0;
  const sourceOffset = input.sourceOffset ?? 0;
  const maxBytes = input.maxBytes ?? MAP_LAYER_READ_DEFAULT_BYTES;
  const layers: MapLayerSummary[] = [];
  const sources: MapStyleSourceSummary[] = [];
  const output = {
    target: { kind: 'root' },
    view: {
      kind: 'root',
      style: summarizeMapStyle(style),
      layers,
      sources,
    },
    truncated: false,
  };
  let bytes = mapJsonByteLength(output) + 128;
  const firstLayer = style.layers[offset];
  const sourceBudget = maxBytes - (firstLayer ? mapJsonByteLength(summarizeMapLayer(firstLayer)) + 1 : 0);
  for (const source of allSources.slice(sourceOffset, sourceOffset + 100)) {
    const size = mapJsonByteLength(source) + 1;
    if (bytes + size > sourceBudget) break;
    sources.push(source);
    bytes += size;
  }
  for (const layer of style.layers.slice(offset, offset + MAP_LAYER_READ_MAX)) {
    const summary = summarizeMapLayer(layer);
    const size = mapJsonByteLength(summary) + 1;
    if (bytes + size > maxBytes) break;
    layers.push(summary);
    bytes += size;
  }
  const nextOffset = offset + layers.length;
  const nextSourceOffset = sourceOffset + sources.length;
  return MapInspectOutputSchema.parse({ ...output,
    truncated: nextOffset < style.layers.length || nextSourceOffset < allSources.length,
    ...(nextOffset < style.layers.length ? { nextOffset } : {}),
    ...(nextSourceOffset < allSources.length ? { nextSourceOffset } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
