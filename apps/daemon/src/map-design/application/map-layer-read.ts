import {
  MAP_LAYER_READ_DEFAULT_BYTES,
  MAP_LAYER_READ_MAX,
  MapInspectOutputSchema,
  MapSearchLayersOutputSchema,
  mapJsonByteLength,
  type MapInspectInput,
  type MapInspectOutput,
  type MapInspectTarget,
  type MapInspectView,
  type MapSearchLayersInput,
  type MapSearchLayersOutput,
  type SemanticDocument,
} from '@mapseekai/map-design-contracts';
import type { StyleDocument } from 'maplibre-style-tools/core';
import { MapDraftError } from './errors.js';
import { inspectMapStyleRoot, summarizeMapLayer, summarizeMapSources } from './map-style-summary.js';

type MapReadSnapshot = { readonly style: StyleDocument; readonly semantics: SemanticDocument };
type DetailedLayer = Extract<MapInspectView, { kind: 'layer' }>['layer'];

export function inspectMapStyle(snapshot: MapReadSnapshot, input: MapInspectInput): MapInspectOutput {
  const target = input.target;
  const maxBytes = input.maxBytes ?? MAP_LAYER_READ_DEFAULT_BYTES;
  switch (target.kind) {
    case 'root':
      return inspectMapStyleRoot(snapshot.style, input);
    case 'layer': {
      const layer = snapshot.style.layers.find((candidate) => candidate.id === target.layerId);
      if (!layer) throw new MapDraftError('NOT_FOUND', 'The map layer was not found.');
      const output = {
        target,
        view: {
          kind: 'layer' as const,
          layer: projectLayer(layer, { ...input, fields: input.fields ?? (input.properties ? [] : ['paint', 'layout', 'filter']) }),
          semanticGroupIds: snapshot.semantics.groups
            .filter((group) => group.layerIds.includes(target.layerId))
            .map((group) => group.id),
        },
        truncated: false,
      };
      if (mapJsonByteLength(output) > maxBytes) {
        const omittedFields: NonNullable<MapInspectOutput['omittedFields']> = (['paint', 'layout', 'filter'] as const)
          .filter((field) => Object.hasOwn(output.view.layer, field));
        const bounded = { ...output, view: { ...output.view, layer: summarizeMapLayer(layer) }, truncated: true, omittedFields };
        while (mapJsonByteLength(bounded) > maxBytes && bounded.view.semanticGroupIds.length > 0) {
          bounded.view.semanticGroupIds.pop();
          if (!omittedFields.includes('semanticGroupIds')) omittedFields.push('semanticGroupIds');
        }
        return MapInspectOutputSchema.parse(bounded);
      }
      return MapInspectOutputSchema.parse(output);
    }
    case 'layers':
      return inspectLayers(snapshot.style, { ...input, target, fields: input.fields ?? (input.properties ? [] : ['paint', 'layout']) });
    case 'source': {
      const source = summarizeMapSources(snapshot.style).find((candidate) => candidate.id === target.sourceId);
      const definition = snapshot.style.sources[target.sourceId];
      if (!source || !definition) throw new MapDraftError('NOT_FOUND', 'The map source was not found.');
      const output = { target, view: { kind: 'source' as const, source: { ...source,
        generateId: definition.generateId === true, promoteId: definition.promoteId ?? null,
      } }, truncated: false };
      if (mapJsonByteLength(output) > maxBytes) {
        return MapInspectOutputSchema.parse({ target, view: { kind: 'source', source }, truncated: true, omittedFields: ['promoteId'] });
      }
      return MapInspectOutputSchema.parse(output);
    }
    case 'source-layer': {
      if (!Object.hasOwn(snapshot.style.sources, target.sourceId)) {
        throw new MapDraftError('NOT_FOUND', 'The map source was not found.');
      }
      const layerIds = snapshot.style.layers
        .filter((layer) => layer.source === target.sourceId && layer['source-layer'] === target.sourceLayer)
        .map((layer) => layer.id);
      if (layerIds.length === 0) throw new MapDraftError('NOT_FOUND', 'The map source layer was not found.');
      const offset = input.offset ?? 0;
      const output = {
        target,
        view: { kind: 'source-layer' as const, sourceId: target.sourceId, sourceLayer: target.sourceLayer, layerIds: layerIds.slice(offset, offset + MAP_LAYER_READ_MAX) },
        truncated: false,
      };
      while (mapJsonByteLength(output) + 64 > maxBytes && output.view.layerIds.length > 0) {
        output.view.layerIds.pop();
      }
      const nextOffset = offset + output.view.layerIds.length;
      return MapInspectOutputSchema.parse({ ...output, truncated: nextOffset < layerIds.length,
        ...(nextOffset < layerIds.length ? { nextOffset } : {}) });
    }
    default:
      return assertNever(target);
  }
}

function projectLayer(layer: StyleDocument['layers'][number], input: Pick<MapInspectInput, 'fields' | 'properties'>): DetailedLayer {
  const fields = input.fields ?? [];
  const paintKeys = input.properties?.paint;
  const layoutKeys = input.properties?.layout;
  return {
    ...summarizeMapLayer(layer),
    ...(paintKeys ? { paint: Object.fromEntries(Object.entries(layer.paint ?? {}).filter(([key]) => paintKeys.includes(key))) }
      : fields.includes('paint') ? { paint: layer.paint ?? {} } : {}),
    ...(layoutKeys ? { layout: Object.fromEntries(Object.entries(layer.layout ?? {}).filter(([key]) => layoutKeys.includes(key))) }
      : fields.includes('layout') ? { layout: layer.layout ?? {} } : {}),
    ...(fields.includes('filter') ? { filter: layer.filter ?? null } : {}),
  };
}

function inspectLayers(style: StyleDocument, input: MapInspectInput & {
  readonly target: Extract<MapInspectTarget, { kind: 'layers' }>;
  readonly fields: NonNullable<MapInspectInput['fields']>;
}): MapInspectOutput {
  const byId = new Map(style.layers.map((layer) => [layer.id, layer]));
  const missingLayerIds = input.target.layerIds.filter((id) => !byId.has(id));
  const omittedLayerIds = input.target.layerIds.filter((id) => byId.has(id));
  const initialLayers: DetailedLayer[] = [];
  let output = {
    target: input.target,
    view: { kind: 'layers' as const, layers: initialLayers, returned: 0, missingLayerIds, omittedLayerIds },
    truncated: omittedLayerIds.length > 0,
  };
  let bytes = mapJsonByteLength(output);
  for (const id of input.target.layerIds) {
    const layer = byId.get(id);
    if (!layer) continue;
    const projected = projectLayer(layer, input);
    const layers = [...output.view.layers, projected];
    const remaining = output.view.omittedLayerIds.filter((omitted) => omitted !== id);
    const candidate = {
      ...output,
      view: { ...output.view, layers, returned: layers.length, omittedLayerIds: remaining },
      truncated: remaining.length > 0,
    };
    const candidateBytes = bytes + mapJsonByteLength(projected) + (output.view.layers.length > 0 ? 1 : 0)
      - mapJsonByteLength(id) - (output.view.omittedLayerIds.length > 1 ? 1 : 0)
      + String(layers.length).length - String(output.view.returned).length
      + (remaining.length === 0 ? 1 : 0);
    if (candidateBytes <= (input.maxBytes ?? MAP_LAYER_READ_DEFAULT_BYTES)) {
      output = candidate;
      bytes = candidateBytes;
    }
  }
  return MapInspectOutputSchema.parse(output);
}

export function searchMapLayers(style: StyleDocument, input: MapSearchLayersInput): MapSearchLayersOutput {
  const queries = (Array.isArray(input.query) ? input.query : [input.query ?? ''])
    .map((query) => query.toLocaleLowerCase('en-US'));
  const matched = style.layers.filter((layer) => {
    const summary = summarizeMapLayer(layer);
    if (!queries.some((query) => !query || [summary.id, summary.title, summary.sourceId, summary.sourceLayer]
      .some((value) => value?.toLocaleLowerCase('en-US').includes(query)))) return false;
    if (input.types && !input.types.includes(summary.type)) return false;
    if (input.sourceId !== undefined && summary.sourceId !== input.sourceId) return false;
    if (input.sourceLayer !== undefined && summary.sourceLayer !== input.sourceLayer) return false;
    return true;
  });
  const offset = input.offset ?? 0;
  const maxBytes = input.maxBytes ?? MAP_LAYER_READ_DEFAULT_BYTES;
  const layers: DetailedLayer[] = [];
  let bytes = 256;
  for (const layer of matched.slice(offset, offset + input.limit)) {
    const projected = projectLayer(layer, input);
    const size = mapJsonByteLength(projected) + 1;
    if (bytes + size <= maxBytes) {
      layers.push(projected);
      bytes += size;
      continue;
    }
    if (size + 256 <= maxBytes) break;
    const summary = { ...summarizeMapLayer(layer),
      omittedFields: (['paint', 'layout', 'filter'] as const).filter(field => Object.hasOwn(projected, field)) };
    const summarySize = mapJsonByteLength(summary) + 1;
    if (bytes + summarySize > maxBytes) break;
    layers.push(summary);
    bytes += summarySize;
  }
  const nextOffset = offset + layers.length;
  const hasMore = nextOffset < matched.length;
  const truncated = hasMore || layers.some(layer => (layer.omittedFields?.length ?? 0) > 0);
  return MapSearchLayersOutputSchema.parse({
    layers, returned: layers.length, total: matched.length, truncated,
    ...(hasMore ? { nextOffset } : {}),
  });
}

function assertNever(value: never): never {
  throw new MapDraftError('INVALID_INPUT', `Unexpected inspection target: ${String(value)}`);
}
