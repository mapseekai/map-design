import { z } from 'zod';
import { MapIdentifierSchema, MapSafeRevisionSchema, MapTimestampSchema, StyleHashSchema, mapJsonByteLength } from './project.js';

export const MAP_COMMENT_BATCH_MAX = 20;
export const MAP_COMMENT_TEXT_MAX = 4000;
const propertyValue = z.union([z.string().max(8192), z.number(), z.boolean(), z.null()]);

export const MapCommentTargetSchema = z.strictObject({
  layerId: MapIdentifierSchema,
  sourceId: MapIdentifierSchema,
  sourceLayer: MapIdentifierSchema.optional(),
  featureId: z.union([z.string().min(1).max(256), z.number().int().safe()]).optional(),
  properties: z.record(z.string().min(1).max(256), propertyValue)
    .refine((value) => Object.keys(value).length <= 64 && mapJsonByteLength(value) <= 16_384, 'Feature properties are too large.'),
  anchor: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  geometryType: z.enum(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection']),
});
export type MapCommentTarget = z.infer<typeof MapCommentTargetSchema>;

const commentFields = {
  transient: z.boolean().optional(),
  id: MapIdentifierSchema,
  version: MapSafeRevisionSchema,
  text: z.string().trim().min(1).max(MAP_COMMENT_TEXT_MAX),
  target: MapCommentTargetSchema,
  scope: z.enum(['feature', 'similar', 'layer']),
  match: z.strictObject({ property: z.string().min(1).max(256), value: propertyValue }).optional(),
  draftRevision: MapSafeRevisionSchema,
  styleHash: StyleHashSchema,
};

function validScope(value: {
  scope: string; target: MapCommentTarget; match?: { property: string; value: unknown } | undefined;
}): boolean {
  if (value.scope === 'feature' && value.target.featureId === undefined) return false;
  if (value.scope !== 'similar') return value.match === undefined;
  return value.match !== undefined && Object.hasOwn(value.target.properties, value.match.property)
    && value.target.properties[value.match.property] === value.match.value;
}

export const MapCommentInputSchema = z.strictObject(commentFields).refine(validScope, 'Choose an identifiable target and matching scope.');
export type MapCommentInput = z.infer<typeof MapCommentInputSchema>;
export const MapCommentSchema = z.strictObject({
  ...commentFields,
  projectId: MapIdentifierSchema,
  status: z.enum(['draft', 'submitted', 'succeeded', 'failed', 'canceled']),
  runId: MapIdentifierSchema.nullable(),
  createdAt: MapTimestampSchema,
  updatedAt: MapTimestampSchema,
}).refine(validScope, 'Choose an identifiable target and matching scope.');
export type MapComment = z.infer<typeof MapCommentSchema>;
export const MapCommentListSchema = z.array(MapCommentSchema).max(500);
export const MapCommentRefSchema = z.strictObject({ id: MapIdentifierSchema, version: MapSafeRevisionSchema });
export type MapCommentRef = z.infer<typeof MapCommentRefSchema>;
export const MapCommentRefsSchema = z.array(MapCommentRefSchema).min(1).max(MAP_COMMENT_BATCH_MAX)
  .refine((refs) => new Set(refs.map((ref) => ref.id)).size === refs.length, 'Comment references must be unique.');
