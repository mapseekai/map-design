import { z } from 'zod';
import { MapIdentifierSchema, MapJsonValueSchema, MapSafeRevisionSchema, StyleHashSchema, mapJsonByteLength } from './project.js';

export const MAP_STYLE_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;

export const MapStyleDocumentInputSchema = z.strictObject({
  expectedRevision: MapSafeRevisionSchema,
  styleHash: StyleHashSchema,
  idempotencyKey: MapIdentifierSchema,
  style: MapJsonValueSchema,
}).refine(input => mapJsonByteLength(input.style) <= MAP_STYLE_DOCUMENT_MAX_BYTES, { message: 'Style document is too large.', path: ['style'] });

export type MapStyleDocumentInput = z.infer<typeof MapStyleDocumentInputSchema>;
