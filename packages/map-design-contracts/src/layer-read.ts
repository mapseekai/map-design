import { z } from 'zod';
import {
  LayerTypeSchema,
  MapIdentifierSchema,
  MapJsonValueSchema,
  MapLayerSummarySchema,
  MapStyleSourceSummarySchema,
  MapStyleSummarySchema,
  mapJsonByteLength,
} from './project.js';

export const MAP_INSPECT_MAX_BYTES = 256 * 1024;
export const MAP_LAYER_READ_DEFAULT_BYTES = 16 * 1024;
export const MAP_LAYER_READ_MAX = 200;

const uniqueIdentifiers = z.array(MapIdentifierSchema)
  .refine((values) => new Set(values).size === values.length, { message: 'Identifiers must be unique' });
const boundedIdentifiers = uniqueIdentifiers.max(MAP_LAYER_READ_MAX);
const layerFields = z.array(z.enum(['paint', 'layout', 'filter'])).max(3)
  .refine((values) => new Set(values).size === values.length, { message: 'Fields must be unique' });
const propertyKeys = z.array(z.string().min(1).max(128).regex(/^[a-z][a-z0-9-]*$/)).max(64)
  .refine((values) => new Set(values).size === values.length, { message: 'Property keys must be unique' });
const readProjection = {
  fields: layerFields.optional(),
  properties: z.strictObject({ paint: propertyKeys.optional(), layout: propertyKeys.optional() }).optional(),
  maxBytes: z.int().min(8192).max(MAP_INSPECT_MAX_BYTES).optional(),
};

export const MapInspectTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('root') }),
  z.strictObject({ kind: z.literal('layer'), layerId: MapIdentifierSchema }),
  z.strictObject({ kind: z.literal('layers'), layerIds: boundedIdentifiers.min(1) }),
  z.strictObject({ kind: z.literal('source'), sourceId: MapIdentifierSchema }),
  z.strictObject({
    kind: z.literal('source-layer'),
    sourceId: MapIdentifierSchema,
    sourceLayer: MapIdentifierSchema,
  }),
]);
export type MapInspectTarget = z.infer<typeof MapInspectTargetSchema>;

export const MapInspectInputSchema = z.strictObject({
  target: MapInspectTargetSchema,
  ...readProjection,
  offset: z.int().min(0).optional(),
  sourceOffset: z.int().min(0).optional(),
}).refine((input) => input.offset === undefined || input.target.kind === 'root' || input.target.kind === 'source-layer', {
  message: 'Offset requires a root or source-layer target',
}).refine((input) => input.sourceOffset === undefined || input.target.kind === 'root', {
  message: 'Source offset requires a root target',
}).refine((input) => input.target.kind !== 'layers' || mapJsonByteLength({
  target: input.target,
  view: { kind: 'layers', layers: [], returned: 0, missingLayerIds: [], omittedLayerIds: input.target.layerIds },
  truncated: false,
}) <= (input.maxBytes ?? MAP_LAYER_READ_DEFAULT_BYTES), { message: 'Layer identifiers exceed the inspection byte budget; request fewer layers or increase maxBytes' });
export type MapInspectInput = z.infer<typeof MapInspectInputSchema>;

export const MapSearchLayersInputSchema = z.strictObject({
  ...readProjection,
  query: z.union([
    z.string().trim().max(256),
    z.array(z.string().trim().min(1).max(256)).min(1).max(20),
  ]).optional(),
  types: z.array(LayerTypeSchema)
    .max(LayerTypeSchema.options.length)
    .refine((values) => new Set(values).size === values.length, { message: 'Layer types must be unique' })
    .optional(),
  sourceId: MapIdentifierSchema.optional(),
  sourceLayer: MapIdentifierSchema.optional(),
  limit: z.int().min(1).max(MAP_LAYER_READ_MAX).default(25),
  offset: z.int().min(0).optional(),
});
export type MapSearchLayersInput = z.infer<typeof MapSearchLayersInputSchema>;

const detailedLayerSchema = MapLayerSummarySchema.extend({
  filter: MapJsonValueSchema.optional(),
  paint: z.record(z.string(), MapJsonValueSchema).optional(),
  layout: z.record(z.string(), MapJsonValueSchema).optional(),
  omittedFields: layerFields.optional(),
});

export const MapInspectViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('root'),
    style: MapStyleSummarySchema,
    layers: z.array(MapLayerSummarySchema).max(MAP_LAYER_READ_MAX),
    sources: z.array(MapStyleSourceSummarySchema).max(100),
  }),
  z.strictObject({
    kind: z.literal('layer'),
    layer: detailedLayerSchema,
    semanticGroupIds: uniqueIdentifiers,
  }),
  z.strictObject({
    kind: z.literal('layers'),
    layers: z.array(detailedLayerSchema).max(MAP_LAYER_READ_MAX),
    returned: z.int().min(0).max(MAP_LAYER_READ_MAX),
    missingLayerIds: boundedIdentifiers,
    omittedLayerIds: boundedIdentifiers,
  }),
  z.strictObject({
    kind: z.literal('source'),
    source: MapStyleSourceSummarySchema.extend({
      generateId: z.boolean().optional(),
      promoteId: z.union([z.string(), z.record(z.string(), z.string())]).nullable().optional(),
    }),
  }),
  z.strictObject({
    kind: z.literal('source-layer'),
    sourceId: MapIdentifierSchema,
    sourceLayer: MapIdentifierSchema,
    layerIds: boundedIdentifiers,
  }),
]);
export type MapInspectView = z.infer<typeof MapInspectViewSchema>;

export const MapInspectOutputSchema = z.strictObject({
  target: MapInspectTargetSchema,
  view: MapInspectViewSchema,
  truncated: z.boolean(),
  nextOffset: z.int().min(0).optional(),
  nextSourceOffset: z.int().min(0).optional(),
  omittedFields: z.array(z.enum(['paint', 'layout', 'filter', 'semanticGroupIds', 'promoteId'])).max(5).optional(),
}).refine(
  (value) => {
    if (value.nextOffset !== undefined && (!value.truncated || !['root', 'source-layer'].includes(value.target.kind))) return false;
    if (value.nextSourceOffset !== undefined && (!value.truncated || value.target.kind !== 'root')) return false;
    if ((value.omittedFields?.length ?? 0) > 0 && !value.truncated) return false;
    switch (value.target.kind) {
      case 'root':
        return value.view.kind === 'root';
      case 'layer':
        return value.view.kind === 'layer' && value.view.layer.id === value.target.layerId;
      case 'layers': {
        if (value.view.kind !== 'layers') return false;
        const ids = [
          ...value.view.layers.map((layer) => layer.id),
          ...value.view.missingLayerIds,
          ...value.view.omittedLayerIds,
        ];
        return value.view.returned === value.view.layers.length
          && value.truncated === (value.view.omittedLayerIds.length > 0)
          && new Set(ids).size === ids.length
          && ids.length === value.target.layerIds.length
          && value.target.layerIds.every((id) => ids.includes(id));
      }
      case 'source':
        return value.view.kind === 'source' && value.view.source.id === value.target.sourceId;
      case 'source-layer':
        return value.view.kind === 'source-layer'
          && value.view.sourceId === value.target.sourceId
          && value.view.sourceLayer === value.target.sourceLayer;
      default:
        return assertNever(value.target);
    }
  },
  { message: 'Inspect view must match its target' },
).refine(
  (value) => mapJsonByteLength(value) <= MAP_INSPECT_MAX_BYTES,
  { message: `Inspect payload must not exceed ${MAP_INSPECT_MAX_BYTES} bytes` },
);
export type MapInspectOutput = z.infer<typeof MapInspectOutputSchema>;

export const MapSearchLayersOutputSchema = z.strictObject({
  layers: z.array(detailedLayerSchema).max(MAP_LAYER_READ_MAX),
  returned: z.int().min(0).max(MAP_LAYER_READ_MAX),
  truncated: z.boolean(),
  total: z.int().min(0).optional(),
  nextOffset: z.int().min(0).optional(),
}).refine((output) => output.returned === output.layers.length, {
  message: 'Returned count must match layers',
}).refine((output) => output.nextOffset === undefined || output.truncated, {
  message: 'A next offset requires more results',
}).refine((output) => output.truncated || output.layers.every(layer => (layer.omittedFields?.length ?? 0) === 0), {
  message: 'Omitted fields require truncation',
}).refine((output) => mapJsonByteLength(output) <= MAP_INSPECT_MAX_BYTES, {
  message: 'Search payload exceeds the maximum byte budget',
});
export type MapSearchLayersOutput = z.infer<typeof MapSearchLayersOutputSchema>;

function assertNever(value: never): never {
  throw new TypeError(`Unexpected inspection target: ${String(value)}`);
}
