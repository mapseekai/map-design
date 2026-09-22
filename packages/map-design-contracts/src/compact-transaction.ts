import { z } from 'zod';
import { MapIdentifierSchema, MapJsonValueSchema } from './project.js';

export const MAP_TRANSACTION_MAX_OPERATIONS = 100;

export const MapSetLayersPropertiesOperationSchema = z.strictObject({
  op: z.literal('setLayersProperties'),
  layerIds: z.array(MapIdentifierSchema).min(1).max(MAP_TRANSACTION_MAX_OPERATIONS)
    .refine(ids => new Set(ids).size === ids.length, { message: 'Layer identifiers must be unique' }),
  paint: z.record(z.string(), MapJsonValueSchema).optional(),
  layout: z.record(z.string(), MapJsonValueSchema).optional(),
  metadata: z.record(z.string(), MapJsonValueSchema).nullable().optional(),
  minzoom: z.number().min(0).max(24).nullable().optional(),
  maxzoom: z.number().min(0).max(24).nullable().optional(),
}).refine(operation => typeof operation.minzoom !== 'number'
  || typeof operation.maxzoom !== 'number' || operation.minzoom <= operation.maxzoom,
{ message: 'minzoom must be less than or equal to maxzoom', path: ['maxzoom'] });

export type MapSetLayersPropertiesOperation = z.infer<typeof MapSetLayersPropertiesOperationSchema>;
export const MapSetLayersPropertiesOperationJsonSchema = z.toJSONSchema(MapSetLayersPropertiesOperationSchema);
