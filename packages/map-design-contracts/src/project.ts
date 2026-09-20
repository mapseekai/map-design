import { z } from 'zod';

export const MAP_IDENTIFIER_MAX_LENGTH = 256;
export const MAP_SEMANTIC_GROUPS_MAX = 256;
export const MAP_REVISION_HISTORY_MAX = 100;

export type MapJsonValue = null | boolean | number | string | MapJsonValue[] | {
  [key: string]: MapJsonValue;
};

export const MapJsonValueSchema: z.ZodType<MapJsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(MapJsonValueSchema),
  z.record(z.string(), MapJsonValueSchema),
]));

export function mapJsonByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  let bytes = 0;
  for (let index = 0; index < json.length; index += 1) {
    const code = json.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < json.length) {
      const next = json.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function mapStringByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

const trimmedString = (maximum: number) => z.string().trim().min(1).max(maximum);
const uniqueStrings = <T extends z.ZodType<string>>(item: T, maximum: number) => z.array(item)
  .max(maximum)
  .refine((values) => new Set(values).size === values.length, { message: 'Values must be unique' });

export const MapIdentifierSchema = trimmedString(MAP_IDENTIFIER_MAX_LENGTH);
export type MapIdentifier = z.infer<typeof MapIdentifierSchema>;

export const MapShortIdentifierSchema = trimmedString(128);
export type MapShortIdentifier = z.infer<typeof MapShortIdentifierSchema>;

export const MapSafeRevisionSchema = z.int().nonnegative();
export type MapSafeRevision = z.infer<typeof MapSafeRevisionSchema>;

export const MapDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type MapDigest = z.infer<typeof MapDigestSchema>;

export const StyleHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type StyleHash = z.infer<typeof StyleHashSchema>;

export const MapTimestampSchema = z.string().datetime({ offset: true });
export type MapTimestamp = z.infer<typeof MapTimestampSchema>;

export const MapSourceKindSchema = z.enum(['style', 'tilejson', 'pmtiles', 'geojson']);
export type MapSourceKind = z.infer<typeof MapSourceKindSchema>;

export const MapProjectLifecycleSchema = z.enum(['importing', 'ready', 'failed']);
export type MapProjectLifecycle = z.infer<typeof MapProjectLifecycleSchema>;

export const LayerTypeSchema = z.enum([
  'background',
  'fill',
  'line',
  'symbol',
  'raster',
  'circle',
  'fill-extrusion',
  'heatmap',
  'hillshade',
  'color-relief',
]);
export type LayerType = z.infer<typeof LayerTypeSchema>;

export const MapStyleSourceTypeSchema = z.enum([
  'vector',
  'raster',
  'raster-dem',
  'geojson',
  'image',
  'video',
]);
export type MapStyleSourceType = z.infer<typeof MapStyleSourceTypeSchema>;

export const MapSourceManifestSchema = z.strictObject({
  kind: MapSourceKindSchema,
  digest: MapDigestSchema,
  mediaType: trimmedString(128),
  byteLength: MapSafeRevisionSchema,
  resourceCount: MapSafeRevisionSchema,
  capturedAt: MapTimestampSchema,
});
export type MapSourceManifest = z.infer<typeof MapSourceManifestSchema>;

export const MapProjectSourceSummarySchema = z.strictObject({
  kind: MapSourceKindSchema,
  digest: MapDigestSchema,
  status: z.enum(['pending', 'available', 'unavailable']),
  resourceCount: MapSafeRevisionSchema,
});
export type MapProjectSourceSummary = z.infer<typeof MapProjectSourceSummarySchema>;

export const MapDesignSystemSummarySchema = z.strictObject({
  id: MapIdentifierSchema,
  name: trimmedString(256),
  digest: MapDigestSchema,
});
export type MapDesignSystemSummary = z.infer<typeof MapDesignSystemSummarySchema>;

export const MapLayerSummarySchema = z.strictObject({
  id: MapIdentifierSchema,
  type: LayerTypeSchema,
  title: trimmedString(256).optional(),
  sourceId: MapIdentifierSchema.optional(),
  sourceLayer: MapIdentifierSchema.optional(),
  minzoom: z.number().min(0).max(24).optional(),
  maxzoom: z.number().min(0).max(24).optional(),
});
export type MapLayerSummary = z.infer<typeof MapLayerSummarySchema>;

export const MapStyleSourceSummarySchema = z.strictObject({
  id: MapIdentifierSchema,
  kind: MapStyleSourceTypeSchema,
  sourceLayerCount: MapSafeRevisionSchema,
  layerCount: MapSafeRevisionSchema,
});
export type MapStyleSourceSummary = z.infer<typeof MapStyleSourceSummarySchema>;

export const MapStyleSummarySchema = z.strictObject({
  layerCount: MapSafeRevisionSchema,
  sourceCount: MapSafeRevisionSchema,
  layerTypes: uniqueStrings(LayerTypeSchema, LayerTypeSchema.options.length),
});
export type MapStyleSummary = z.infer<typeof MapStyleSummarySchema>;

export const SemanticGroupSchema = z.strictObject({
  id: MapShortIdentifierSchema,
  label: trimmedString(128),
  role: trimmedString(128),
  layerIds: uniqueStrings(MapIdentifierSchema, 128).min(1),
  sourceIds: uniqueStrings(MapIdentifierSchema, 128),
});
export type SemanticGroup = z.infer<typeof SemanticGroupSchema>;

export const SemanticDocumentSchema = z.strictObject({
  version: z.literal(1),
  groups: z.array(SemanticGroupSchema)
    .max(MAP_SEMANTIC_GROUPS_MAX)
    .refine((groups) => new Set(groups.map((group) => group.id)).size === groups.length, {
      message: 'Semantic group IDs must be unique',
    }),
});
export type SemanticDocument = z.infer<typeof SemanticDocumentSchema>;

export const MapSemanticSummarySchema = z.strictObject({
  version: z.literal(1),
  groupCount: MapSafeRevisionSchema.max(MAP_SEMANTIC_GROUPS_MAX),
  mappedLayerCount: MapSafeRevisionSchema,
  mappedSourceCount: MapSafeRevisionSchema,
});
export type MapSemanticSummary = z.infer<typeof MapSemanticSummarySchema>;

export const MapValidationStatusSchema = z.enum(['unknown', 'valid', 'invalid']);
export type MapValidationStatus = z.infer<typeof MapValidationStatusSchema>;

export const MapValidationSummarySchema = z.strictObject({
  status: MapValidationStatusSchema,
  errors: MapSafeRevisionSchema,
  warnings: MapSafeRevisionSchema,
  infos: MapSafeRevisionSchema,
  totalFindings: MapSafeRevisionSchema,
  returnedFindings: MapSafeRevisionSchema.max(500),
  omittedFindings: MapSafeRevisionSchema,
}).refine(
  (summary) => summary.totalFindings === summary.errors + summary.warnings + summary.infos
    && summary.totalFindings === summary.returnedFindings + summary.omittedFindings,
  { message: 'Validation counts must be consistent' },
).refine(
  (summary) => {
    if (summary.status === 'valid') {
      return summary.errors === 0;
    }
    if (summary.status === 'invalid') {
      return summary.errors > 0;
    }
    return summary.errors === 0
      && summary.warnings === 0
      && summary.infos === 0
      && summary.totalFindings === 0
      && summary.returnedFindings === 0
      && summary.omittedFindings === 0;
  },
  { message: 'Validation status must agree with finding counts' },
);
export type MapValidationSummary = z.infer<typeof MapValidationSummarySchema>;

export const MapValidationFindingScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('root') }),
  z.strictObject({ kind: z.literal('layer'), id: MapIdentifierSchema }),
  z.strictObject({ kind: z.literal('source'), id: MapIdentifierSchema }),
  z.strictObject({ kind: z.literal('source-layer'), sourceId: MapIdentifierSchema, sourceLayer: MapIdentifierSchema }),
  z.strictObject({ kind: z.literal('design-system'), id: MapIdentifierSchema }),
  z.strictObject({ kind: z.literal('runtime') }),
]);
export type MapValidationFindingScope = z.infer<typeof MapValidationFindingScopeSchema>;

export const MapValidationFindingSchema = z.strictObject({
  severity: z.enum(['error', 'warning', 'info']),
  code: MapShortIdentifierSchema,
  message: trimmedString(2_048),
  scope: MapValidationFindingScopeSchema,
  jsonPointer: trimmedString(1_024).optional(),
});
export type MapValidationFinding = z.infer<typeof MapValidationFindingSchema>;

export const MapDesignProjectReadSchema = z.strictObject({
  projectId: MapIdentifierSchema,
  lifecycle: MapProjectLifecycleSchema,
  sourceKind: MapSourceKindSchema.nullable(),
  designSystemId: MapIdentifierSchema,
  designSystemDigest: MapDigestSchema,
  draftRevision: MapSafeRevisionSchema,
  committedRevision: MapSafeRevisionSchema.nullable(),
  failure: z.strictObject({
    code: MapShortIdentifierSchema,
    message: trimmedString(2_048),
  }).nullable(),
  createdAt: MapTimestampSchema,
  updatedAt: MapTimestampSchema,
});
export type MapDesignProjectRead = z.infer<typeof MapDesignProjectReadSchema>;

export const MapRevisionSchema = z.strictObject({
  revision: MapSafeRevisionSchema,
  draftRevision: MapSafeRevisionSchema,
  styleHash: StyleHashSchema,
  sourceDigest: MapDigestSchema,
  semanticDigest: MapDigestSchema,
  designSystemDigest: MapDigestSchema,
  previewId: MapIdentifierSchema.nullable(),
  attestationDigest: MapDigestSchema,
  committedAt: MapTimestampSchema,
}).superRefine((revision, context) => {
  const previewMatchesRevision = revision.revision === 0
    ? revision.previewId === null
    : revision.previewId !== null;
  if (!previewMatchesRevision) {
    context.addIssue({
      code: 'custom',
      path: ['previewId'],
      message: 'Only revision zero may omit preview provenance',
    });
  }
});
export type MapRevision = z.infer<typeof MapRevisionSchema>;

export const MapRevisionHistoryOutputSchema = z.strictObject({
  revisions: z.array(MapRevisionSchema).max(MAP_REVISION_HISTORY_MAX),
  returned: MapSafeRevisionSchema.max(MAP_REVISION_HISTORY_MAX),
  truncated: z.boolean(),
}).refine((output) => output.returned === output.revisions.length, {
  message: 'Returned count must match revisions',
});
export type MapRevisionHistoryOutput = z.infer<typeof MapRevisionHistoryOutputSchema>;
