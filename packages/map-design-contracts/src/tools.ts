import { z } from 'zod';

import { MapToolEnvelopeSchema } from './errors.js';

import {
  LayerTypeSchema,
  MapDesignSystemSummarySchema,
  MapDigestSchema,
  MapIdentifierSchema,
  MapJsonValueSchema,
  MapLayerSummarySchema,
  MapProjectLifecycleSchema,
  MapProjectSourceSummarySchema,
  MapSafeRevisionSchema,
  MapSemanticSummarySchema,
  MapStyleSourceSummarySchema,
  MapStyleSummarySchema,
  MapTimestampSchema,
  MapValidationFindingSchema,
  MapValidationStatusSchema,
  MapValidationSummarySchema,
  SemanticDocumentSchema,
  StyleHashSchema,
  mapJsonByteLength,
  type MapValidationFinding,
} from './project.js';
import {
  MapPreviewPngDescriptorSchema,
  MapPreviewReportDescriptorSchema,
  MapPreviewStatusSchema,
  MapPreviewViewportSchema,
} from './preview.js';

export const MAP_INSPECT_MAX_BYTES = 256 * 1024;
export const MAP_VALIDATION_FINDINGS_MAX = 500;
export const MAP_DIFF_MAX_BYTES = 1024 * 1024;

export const MapIntentSummarySchema = z.string().trim().min(1).max(500);
export type MapIntentSummary = z.infer<typeof MapIntentSummarySchema>;

export const MapIdempotencyKeySchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export type MapIdempotencyKey = z.infer<typeof MapIdempotencyKeySchema>;
const uniqueIdentifiers = z.array(MapIdentifierSchema)
  .refine((values) => new Set(values).size === values.length, { message: 'Identifiers must be unique' });
const transportUnknownSchema: z.ZodType<unknown> = MapJsonValueSchema;

export const MAP_TOOL_NAMES = [
  'map_get_context',
  'map_inspect',
  'map_search_layers',
  'map_apply_transaction',
  'map_update_semantics',
  'map_validate',
  'map_render_preview',
  'map_commit_revision',
  'map_discard_draft',
] as const;

export const MapToolNameSchema = z.enum(MAP_TOOL_NAMES);
export type MapToolName = z.infer<typeof MapToolNameSchema>;

export const MapGetContextInputSchema = z.strictObject({});
export type MapGetContextInput = z.infer<typeof MapGetContextInputSchema>;

export const MapInspectTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('root') }),
  z.strictObject({ kind: z.literal('layer'), layerId: MapIdentifierSchema }),
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
});
export type MapInspectInput = z.infer<typeof MapInspectInputSchema>;

export const MapSearchLayersInputSchema = z.strictObject({
  query: z.string().trim().max(256).optional(),
  types: z.array(LayerTypeSchema)
    .max(LayerTypeSchema.options.length)
    .refine((values) => new Set(values).size === values.length, { message: 'Layer types must be unique' })
    .optional(),
  sourceId: MapIdentifierSchema.optional(),
  sourceLayer: MapIdentifierSchema.optional(),
  limit: z.int().min(1).max(100).default(25),
});
export type MapSearchLayersInput = z.infer<typeof MapSearchLayersInputSchema>;

export const MapApplyTransactionInputSchema = z.strictObject({
  expectedRevision: MapSafeRevisionSchema,
  idempotencyKey: MapIdempotencyKeySchema,
  transaction: transportUnknownSchema,
  intentSummary: MapIntentSummarySchema,
});
export type MapApplyTransactionInput = z.infer<typeof MapApplyTransactionInputSchema>;

export const MapUpdateSemanticsInputSchema = z.strictObject({
  expectedRevision: MapSafeRevisionSchema,
  idempotencyKey: MapIdempotencyKeySchema,
  semantics: SemanticDocumentSchema,
  intentSummary: MapIntentSummarySchema,
});
export type MapUpdateSemanticsInput = z.infer<typeof MapUpdateSemanticsInputSchema>;

export const MapValidateInputSchema = z.strictObject({
  expectedRevision: MapSafeRevisionSchema,
});
export type MapValidateInput = z.infer<typeof MapValidateInputSchema>;

export const MapRenderPreviewInputSchema = z.strictObject({
  expectedRevision: MapSafeRevisionSchema,
  idempotencyKey: MapIdempotencyKeySchema,
  viewport: MapPreviewViewportSchema.optional(),
});
export type MapRenderPreviewInput = z.infer<typeof MapRenderPreviewInputSchema>;

export const MapCommitRevisionInputSchema = z.strictObject({
  expectedRevision: MapSafeRevisionSchema,
  idempotencyKey: MapIdempotencyKeySchema,
  previewId: MapIdentifierSchema,
  intentSummary: MapIntentSummarySchema,
});
export type MapCommitRevisionInput = z.infer<typeof MapCommitRevisionInputSchema>;

export function mapCommitPreviewIntentSummary(projectId: string, previewId: string): string {
  const project = MapIdentifierSchema.parse(projectId);
  const preview = MapIdentifierSchema.parse(previewId);
  return MapIntentSummarySchema.parse(
    `Commit MapDesign preview ${summarizeCommitIdentifier(preview)}`
    + ` for project ${summarizeCommitIdentifier(project)}.`,
  );
}

const COMMIT_IDENTIFIER_EDGE_LENGTH = 64;
const COMMIT_IDENTIFIER_INLINE_LENGTH = COMMIT_IDENTIFIER_EDGE_LENGTH * 2;

function summarizeCommitIdentifier(identifier: string): string {
  if (identifier.length <= COMMIT_IDENTIFIER_INLINE_LENGTH) return identifier;
  // Full project + preview identity remains authoritative in the route, body,
  // and idempotency key. This protocol summary includes length and both edges
  // for diagnosis while staying bounded; it is deliberately not an identity
  // or collision boundary.
  return `${safeLeadingCodeUnits(identifier, COMMIT_IDENTIFIER_EDGE_LENGTH)}…`
    + `${safeTrailingCodeUnits(identifier, COMMIT_IDENTIFIER_EDGE_LENGTH)} [${identifier.length}]`;
}

function safeLeadingCodeUnits(value: string, maximum: number): string {
  let end = Math.min(maximum, value.length);
  if (end > 0 && isHighSurrogate(value.charCodeAt(end - 1)) && isLowSurrogate(value.charCodeAt(end))) {
    end -= 1;
  }
  return value.slice(0, end);
}

function safeTrailingCodeUnits(value: string, maximum: number): string {
  let start = Math.max(0, value.length - maximum);
  if (start > 0 && isLowSurrogate(value.charCodeAt(start)) && isHighSurrogate(value.charCodeAt(start - 1))) {
    start += 1;
  }
  return value.slice(start);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export const MapDiscardDraftInputSchema = z.strictObject({
  expectedRevision: MapSafeRevisionSchema,
  idempotencyKey: MapIdempotencyKeySchema,
  intentSummary: MapIntentSummarySchema,
});
export type MapDiscardDraftInput = z.infer<typeof MapDiscardDraftInputSchema>;

export const MapGetContextOutputSchema = z.strictObject({
  lifecycle: MapProjectLifecycleSchema,
  source: MapProjectSourceSummarySchema,
  designSystem: MapDesignSystemSummarySchema,
  draftRevision: MapSafeRevisionSchema,
  committedRevision: MapSafeRevisionSchema.nullable(),
  styleHash: StyleHashSchema,
  styleSummary: MapStyleSummarySchema,
  semanticSummary: MapSemanticSummarySchema,
  validationStatus: MapValidationStatusSchema,
  previewStatus: MapPreviewStatusSchema,
  cartographicGuidance: z.array(z.string().trim().min(1).max(500)).max(256),
});
export type MapGetContextOutput = z.infer<typeof MapGetContextOutputSchema>;

export const MapInspectViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('root'),
    style: MapStyleSummarySchema,
    layers: z.array(MapLayerSummarySchema).max(100),
    sources: z.array(MapStyleSourceSummarySchema).max(100),
  }),
  z.strictObject({
    kind: z.literal('layer'),
    layer: MapLayerSummarySchema.extend({
      filter: MapJsonValueSchema.optional(),
      paint: z.record(z.string(), MapJsonValueSchema).optional(),
      layout: z.record(z.string(), MapJsonValueSchema).optional(),
    }),
    semanticGroupIds: uniqueIdentifiers,
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
    layerIds: uniqueIdentifiers,
  }),
]);
export type MapInspectView = z.infer<typeof MapInspectViewSchema>;

export const MapInspectOutputSchema = z.strictObject({
  target: MapInspectTargetSchema,
  view: MapInspectViewSchema,
  truncated: z.boolean(),
}).refine(
  (value) => {
    switch (value.target.kind) {
      case 'root':
        return value.view.kind === 'root';
      case 'layer':
        return value.view.kind === 'layer' && value.view.layer.id === value.target.layerId;
      case 'source':
        return value.view.kind === 'source' && value.view.source.id === value.target.sourceId;
      case 'source-layer':
        return value.view.kind === 'source-layer'
          && value.view.sourceId === value.target.sourceId
          && value.view.sourceLayer === value.target.sourceLayer;
    }
  },
  { message: 'Inspect view must match its target' },
).refine(
  (value) => mapJsonByteLength(value) <= MAP_INSPECT_MAX_BYTES,
  { message: `Inspect payload must not exceed ${MAP_INSPECT_MAX_BYTES} bytes` },
);
export type MapInspectOutput = z.infer<typeof MapInspectOutputSchema>;

export const MapSearchLayersOutputSchema = z.strictObject({
  layers: z.array(MapLayerSummarySchema).max(100),
  returned: z.int().min(0).max(100),
  truncated: z.boolean(),
}).refine((output) => output.returned === output.layers.length, {
  message: 'Returned count must match layers',
});
export type MapSearchLayersOutput = z.infer<typeof MapSearchLayersOutputSchema>;

export const MapToolWarningSchema = z.strictObject({
  code: z.string().trim().min(1).max(128),
  message: z.string().trim().min(1).max(2_048),
  jsonPointer: z.string().trim().min(1).max(1_024).optional(),
});
export type MapToolWarning = z.infer<typeof MapToolWarningSchema>;

export const MapJsonPointerSchema = z.string().regex(/^(?:|(?:\/(?:[^~/]|~[01])*)+)$/);
export type MapJsonPointer = z.infer<typeof MapJsonPointerSchema>;

export const MapStyleDiffTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('style') }),
  z.strictObject({ kind: z.literal('layer'), id: MapIdentifierSchema }),
  z.strictObject({ kind: z.literal('source'), id: MapIdentifierSchema }),
]);
export type MapStyleDiffTarget = z.infer<typeof MapStyleDiffTargetSchema>;

export const MapStyleDiffEntrySchema = z.strictObject({
  op: z.enum(['add', 'remove', 'replace', 'move']),
  path: MapJsonPointerSchema,
  from: MapJsonPointerSchema.optional(),
  before: MapJsonValueSchema.optional(),
  after: MapJsonValueSchema.optional(),
  target: MapStyleDiffTargetSchema,
});
export type MapStyleDiffEntry = z.infer<typeof MapStyleDiffEntrySchema>;

export const MapStyleDiffSchema = z.array(MapStyleDiffEntrySchema).refine(
  (diff) => mapJsonByteLength(diff) <= MAP_DIFF_MAX_BYTES,
  { message: `Diff must not exceed ${MAP_DIFF_MAX_BYTES} bytes` },
);
export type MapStyleDiff = z.infer<typeof MapStyleDiffSchema>;

export const MapApplyTransactionOutputSchema = z.strictObject({
  draftRevision: MapSafeRevisionSchema,
  styleHash: StyleHashSchema,
  changedLayers: uniqueIdentifiers,
  changedSources: uniqueIdentifiers,
  diff: MapStyleDiffSchema,
  warnings: z.array(MapToolWarningSchema),
  validationSummary: MapValidationSummarySchema,
});
export type MapApplyTransactionOutput = z.infer<typeof MapApplyTransactionOutputSchema>;

export const MapUpdateSemanticsOutputSchema = z.strictObject({
  draftRevision: MapSafeRevisionSchema,
  semanticDigest: MapDigestSchema,
  semanticSummary: MapSemanticSummarySchema,
  validationSummary: MapValidationSummarySchema,
});
export type MapUpdateSemanticsOutput = z.infer<typeof MapUpdateSemanticsOutputSchema>;

const severityRank = { error: 0, warning: 1, info: 2 } as const;
const findingSortKey = (finding: MapValidationFinding) => {
  const scopeId = 'id' in finding.scope
    ? finding.scope.id
    : 'sourceId' in finding.scope
      ? `${finding.scope.sourceId}/${finding.scope.sourceLayer}`
      : '';
  return `${severityRank[finding.severity]}\u0000${finding.code}\u0000${finding.scope.kind}\u0000${scopeId}\u0000${finding.message}`;
};

export const MapValidateOutputSchema = z.strictObject({
  draftRevision: MapSafeRevisionSchema,
  styleHash: StyleHashSchema,
  validationDigest: MapDigestSchema,
  summary: MapValidationSummarySchema,
  findings: z.array(MapValidationFindingSchema).max(MAP_VALIDATION_FINDINGS_MAX),
}).refine(
  (output) => output.summary.returnedFindings === output.findings.length,
  { message: 'Returned finding count must match findings' },
).refine(
  (output) => output.findings.every((finding, index) => index === 0
    || findingSortKey(output.findings[index - 1]!) <= findingSortKey(finding)),
  { message: 'Validation findings must be sorted' },
);
export type MapValidateOutput = z.infer<typeof MapValidateOutputSchema>;

const mapRenderPreviewOutputBase = {
  previewId: MapIdentifierSchema,
  draftRevision: MapSafeRevisionSchema,
  styleHash: StyleHashSchema,
  report: MapPreviewReportDescriptorSchema,
  validationSummary: MapValidationSummarySchema,
};

export const MapRenderPreviewOutputSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...mapRenderPreviewOutputBase,
    status: z.literal('succeeded'),
    png: MapPreviewPngDescriptorSchema,
  }),
  z.strictObject({
    ...mapRenderPreviewOutputBase,
    status: z.literal('failed'),
    png: z.null(),
  }),
]);
export type MapRenderPreviewOutput = z.infer<typeof MapRenderPreviewOutputSchema>;

export const MapCurrentPreviewOutputSchema = z.strictObject({
  preview: MapRenderPreviewOutputSchema.nullable(),
});
export type MapCurrentPreviewOutput = z.infer<typeof MapCurrentPreviewOutputSchema>;

export const MapCommitRevisionOutputSchema = z.strictObject({
  revision: MapSafeRevisionSchema,
  draftRevision: MapSafeRevisionSchema,
  styleHash: StyleHashSchema,
  attestationDigest: MapDigestSchema,
  committedAt: MapTimestampSchema,
});
export type MapCommitRevisionOutput = z.infer<typeof MapCommitRevisionOutputSchema>;

export const MapDiscardDraftOutputSchema = z.strictObject({
  draftRevision: MapSafeRevisionSchema,
  restoredCommittedRevision: MapSafeRevisionSchema,
  styleHash: StyleHashSchema,
  semanticDigest: MapDigestSchema,
  validationSummary: MapValidationSummarySchema,
});
export type MapDiscardDraftOutput = z.infer<typeof MapDiscardDraftOutputSchema>;

export const MapToolInputSchemas = {
  map_get_context: MapGetContextInputSchema,
  map_inspect: MapInspectInputSchema,
  map_search_layers: MapSearchLayersInputSchema,
  map_apply_transaction: MapApplyTransactionInputSchema,
  map_update_semantics: MapUpdateSemanticsInputSchema,
  map_validate: MapValidateInputSchema,
  map_render_preview: MapRenderPreviewInputSchema,
  map_commit_revision: MapCommitRevisionInputSchema,
  map_discard_draft: MapDiscardDraftInputSchema,
} as const satisfies Record<MapToolName, z.ZodType>;

export const MapToolOutputSchemas = {
  map_get_context: MapGetContextOutputSchema,
  map_inspect: MapInspectOutputSchema,
  map_search_layers: MapSearchLayersOutputSchema,
  map_apply_transaction: MapApplyTransactionOutputSchema,
  map_update_semantics: MapUpdateSemanticsOutputSchema,
  map_validate: MapValidateOutputSchema,
  map_render_preview: MapRenderPreviewOutputSchema,
  map_commit_revision: MapCommitRevisionOutputSchema,
  map_discard_draft: MapDiscardDraftOutputSchema,
} as const satisfies Record<MapToolName, z.ZodType>;

export const MapToolJsonInputSchemas = Object.fromEntries(
  MAP_TOOL_NAMES.map((name) => [name, z.toJSONSchema(MapToolInputSchemas[name])]),
) as unknown as Record<MapToolName, object>;

export const MapToolJsonOutputSchemas = Object.fromEntries(
  MAP_TOOL_NAMES.map((name) => [name, z.toJSONSchema(MapToolEnvelopeSchema(MapToolOutputSchemas[name]))]),
) as unknown as Record<MapToolName, object>;
