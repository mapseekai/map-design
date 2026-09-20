import { z } from 'zod';

import {
  MapDigestSchema,
  MapJsonValueSchema,
  MapRevisionSchema,
  MapSafeRevisionSchema,
  MapValidationSummarySchema,
  SemanticDocumentSchema,
  StyleHashSchema,
  mapJsonByteLength,
} from './project.js';
import {
  MapIdempotencyKeySchema,
  MapInspectOutputSchema,
  MapIntentSummarySchema,
  MapValidateOutputSchema,
} from './tools.js';

export const MAP_REVISION_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

export const MapRevisionSnapshotOutputSchema = z.strictObject({
  revision: MapRevisionSchema,
  style: MapJsonValueSchema,
  semantics: SemanticDocumentSchema,
  validation: MapValidateOutputSchema,
  inspect: MapInspectOutputSchema,
}).refine(
  (value) => mapJsonByteLength(value) <= MAP_REVISION_SNAPSHOT_MAX_BYTES,
  { message: 'Revision snapshot exceeds the response limit' },
);
export type MapRevisionSnapshotOutput = z.infer<typeof MapRevisionSnapshotOutputSchema>;

export const MapRestoreRevisionInputSchema = z.strictObject({
  expectedDraftRevision: MapSafeRevisionSchema,
  idempotencyKey: MapIdempotencyKeySchema,
  confirmReplaceDraft: z.literal(true),
  intentSummary: MapIntentSummarySchema,
});
export type MapRestoreRevisionInput = z.infer<typeof MapRestoreRevisionInputSchema>;

export const MapRestoreRevisionOutputSchema = z.strictObject({
  draftRevision: MapSafeRevisionSchema,
  restoredRevision: MapSafeRevisionSchema,
  styleHash: StyleHashSchema,
  semanticDigest: MapDigestSchema,
  validationSummary: MapValidationSummarySchema,
});
export type MapRestoreRevisionOutput = z.infer<typeof MapRestoreRevisionOutputSchema>;
