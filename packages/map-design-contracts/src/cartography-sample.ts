import { z } from 'zod';
import type { CartographyMapElement } from './cartography.js';

export const CARTOGRAPHY_SAMPLE_GEOMETRY = {
  "background.canvas": "background",
  "building.public": "polygon",
  "building.residential": "polygon",
  "label.district": "label",
  "label.park": "label",
  "label.water": "label",
  "landuse.park": "polygon",
  "poi.bus-stop": "point",
  "poi.cafe": "point",
  "poi.library": "point",
  "poi.museum": "point",
  "poi.station": "point",
  "poi.viewpoint": "point",
  "road.bridge": "line",
  "road.local": "line",
  "road.path": "line",
  "road.primary": "line",
  "road.secondary": "line",
  "water.lake": "polygon",
  "water.river": "polygon"
} as const;
export type CartographySampleKey = keyof typeof CARTOGRAPHY_SAMPLE_GEOMETRY;
export const CartographySampleBindingsSchema = z.partialRecord(
  z.enum(Object.keys(CARTOGRAPHY_SAMPLE_GEOMETRY) as [CartographySampleKey, ...CartographySampleKey[]]),
  z.string().min(1).max(128),
);
export type CartographySampleBindings = z.infer<typeof CartographySampleBindingsSchema>;

export function validCartographySampleBindings(elements: readonly CartographyMapElement[], bindings: CartographySampleBindings): boolean {
  return Object.entries(bindings).every(([key, name]) => elements.some((element) =>
    element.name === name && element.geometry === CARTOGRAPHY_SAMPLE_GEOMETRY[key as CartographySampleKey],
  ));
}
