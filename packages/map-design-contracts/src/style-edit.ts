import { Color, createPropertyExpression, convertFunction, isExpression, isFunction, v8, type StylePropertySpecification } from '@maplibre/maplibre-gl-style-spec';
import { z } from 'zod';

import { MapCommentTargetSchema } from './comments.js';
import { MapSafeRevisionSchema, StyleHashSchema } from './project.js';
import { MapIdempotencyKeySchema } from './tools.js';

export const MapStyleEditScopeSchema = z.enum(['feature', 'similar', 'layer']);
export type MapStyleEditScope = z.infer<typeof MapStyleEditScopeSchema>;

export const MapStyleEditMatchSchema = z.strictObject({
  property: z.string().min(1).max(256),
  value: z.union([z.string().max(8192), z.number().finite(), z.boolean(), z.null()]),
});
export type MapStyleEditMatch = z.infer<typeof MapStyleEditMatchSchema>;

const propertiesByType = {
  fill: ['fill-color', 'fill-opacity', 'fill-outline-color', 'fill-antialias', 'fill-translate', 'fill-translate-anchor', 'visibility'],
  line: ['line-color', 'line-opacity', 'line-width', 'line-gap-width', 'line-offset', 'line-blur', 'line-dasharray', 'line-cap', 'line-join', 'line-miter-limit', 'line-round-limit', 'line-translate', 'line-translate-anchor', 'visibility'],
  circle: ['circle-color', 'circle-opacity', 'circle-radius', 'circle-stroke-color', 'circle-stroke-width', 'circle-stroke-opacity', 'circle-blur', 'circle-translate', 'circle-translate-anchor', 'circle-pitch-alignment', 'circle-pitch-scale', 'visibility'],
  symbol: ['text-color', 'text-opacity', 'text-size', 'text-halo-color', 'text-halo-width', 'text-halo-blur', 'text-rotate', 'text-offset', 'text-letter-spacing', 'text-max-width', 'text-line-height', 'text-anchor', 'text-justify', 'text-transform', 'text-allow-overlap', 'text-ignore-placement',
    'icon-color', 'icon-opacity', 'icon-size', 'icon-rotate', 'icon-offset', 'icon-halo-color', 'icon-halo-width', 'icon-halo-blur', 'icon-anchor', 'icon-allow-overlap', 'symbol-placement', 'symbol-spacing', 'visibility'],
  'fill-extrusion': ['fill-extrusion-color', 'fill-extrusion-opacity', 'fill-extrusion-height', 'fill-extrusion-base', 'fill-extrusion-vertical-gradient', 'fill-extrusion-translate', 'fill-extrusion-translate-anchor', 'visibility'],
} as const;

export type MapStyleEditableLayerType = keyof typeof propertiesByType;
export type MapStyleEditProperty = (typeof propertiesByType)[MapStyleEditableLayerType][number];
export type MapStyleEditChangeValue = string | number | boolean | number[];

export type MapStyleControl = {
  property: MapStyleEditProperty;
  label: string;
  section: 'paint' | 'layout';
  kind: 'color' | 'number' | 'boolean' | 'enum' | 'array';
  min?: number;
  max?: number;
  step?: number;
  length?: number;
  options?: readonly string[];
  defaultValue?: MapStyleEditChangeValue;
  supportsFeature: boolean;
  transition: boolean;
  units?: string;
};

type PropertySpec = {
  type: MapStyleControl['kind'];
  default?: MapStyleEditChangeValue;
  minimum?: number; maximum?: number; length?: number;
  values?: Record<string, unknown>;
  expression?: { parameters: readonly string[] };
  transition?: boolean;
  units?: string;
};

export const MAP_STYLE_CONTROLS = Object.fromEntries(Object.entries(propertiesByType).map(([type, properties]) => {
  const paint = v8[`paint_${type}` as keyof typeof v8] as Record<string, PropertySpec>;
  const layout = v8[`layout_${type}` as keyof typeof v8] as Record<string, PropertySpec>;
  return [type, properties.map(property => {
    const section = Object.hasOwn(paint, property) ? 'paint' : 'layout';
    const spec = (section === 'paint' ? paint : layout)[property]!;
    return {
      property, label: property, section, kind: spec.type,
      ...(spec.minimum === undefined ? {} : { min: spec.minimum }),
      ...(spec.maximum === undefined ? {} : { max: spec.maximum }),
      ...(spec.length === undefined ? {} : { length: spec.length }),
      ...(spec.values ? { options: Object.keys(spec.values) } : {}),
      ...(spec.default === undefined ? {} : { defaultValue: spec.default }),
      ...(spec.type === 'number' ? { step: property.includes('opacity') ? 0.05 : 0.5 } : {}),
      ...(spec.units ? { units: ({ pixels: 'px', meters: 'm', degrees: '°', ems: 'em', 'line widths': '× width' } as Record<string, string>)[spec.units] ?? spec.units } : {}),
      supportsFeature: spec.expression?.parameters.includes('feature') ?? false,
      transition: spec.transition === true,
    } satisfies MapStyleControl;
  })];
})) as unknown as Record<MapStyleEditableLayerType, readonly MapStyleControl[]>;

const controlsByProperty = new Map(Object.values(MAP_STYLE_CONTROLS).flat().map(control => [control.property, control]));

export function isMapStyleEditValue(control: MapStyleControl, value: unknown): value is MapStyleEditChangeValue {
  if (control.kind === 'color') return typeof value === 'string' && value.length <= 256 && Boolean(Color.parse(value));
  if (control.kind === 'enum') return typeof value === 'string' && Boolean(control.options?.includes(value));
  if (control.kind === 'boolean') return typeof value === 'boolean';
  const validNumber = (n: unknown) => typeof n === 'number' && Number.isFinite(n)
    && (control.min === undefined || n >= control.min) && (control.max === undefined || n <= control.max);
  if (control.kind === 'number') return validNumber(value);
  return Array.isArray(value) && value.length > 0 && value.length <= 32
    && (control.length === undefined || value.length === control.length) && value.every(validNumber);
}

export const MapStyleEditChangesSchema = z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.number().finite()).max(32)]))
  .superRefine((changes, context) => {
    if (Object.keys(changes).length === 0) context.addIssue({ code: 'custom', message: 'Choose at least one style change.' });
    for (const [property, value] of Object.entries(changes)) {
      const control = controlsByProperty.get(property as MapStyleEditProperty);
      if (!control) context.addIssue({ code: 'custom', path: [property], message: 'This style property is not supported.' });
      else if (!isMapStyleEditValue(control, value)) context.addIssue({ code: 'custom', path: [property], message: 'The style value is invalid.' });
    }
  });

export const MapStyleEditInputSchema = z.strictObject({
  expectedRevision: MapSafeRevisionSchema,
  styleHash: StyleHashSchema,
  idempotencyKey: MapIdempotencyKeySchema,
  target: MapCommentTargetSchema,
  scope: MapStyleEditScopeSchema,
  match: MapStyleEditMatchSchema.optional(),
  changes: MapStyleEditChangesSchema,
}).superRefine((input, context) => {
  if (input.scope === 'feature' && input.target.featureId === undefined) {
    context.addIssue({ code: 'custom', path: ['target', 'featureId'], message: 'Feature scope requires a stable identifier.' });
  }
  if (input.scope !== 'similar' && input.match !== undefined) {
    context.addIssue({ code: 'custom', path: ['match'], message: 'A property match is only valid for similar scope.' });
  }
  if (input.scope === 'similar' && (!input.match
    || !Object.hasOwn(input.target.properties, input.match.property)
    || input.target.properties[input.match.property] !== input.match.value)) {
    context.addIssue({ code: 'custom', path: ['match'], message: 'Similar scope requires a property from the selected feature.' });
  }
});
export type MapStyleEditInput = z.infer<typeof MapStyleEditInputSchema>;

export type MapStyleEditLayer = {
  id: string;
  type: string;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
};
export type MapStyleEditPatch = { paint: Record<string, unknown>; layout: Record<string, unknown> };

export function mapStyleControlFallback(layer: MapStyleEditLayer, control: MapStyleControl): unknown {
  // MapLibre inherits an omitted fill outline from the fill color, including expressions.
  if (control.property === 'fill-outline-color') return layer.paint?.['fill-color'] ?? '#000000';
  return control.defaultValue;
}

export function canScopeMapStyleControl(layer: MapStyleEditLayer, control: MapStyleControl): boolean {
  return control.supportsFeature && (layer[control.section]?.[control.property] !== undefined
    || mapStyleControlFallback(layer, control) !== undefined);
}

export function getMapStyleControls(type: string): readonly MapStyleControl[] {
  return Object.hasOwn(MAP_STYLE_CONTROLS, type) ? MAP_STYLE_CONTROLS[type as MapStyleEditableLayerType] : [];
}

export function buildMapStyleEditPatch(layer: MapStyleEditLayer, value: MapStyleEditInput): MapStyleEditPatch {
  const input = MapStyleEditInputSchema.parse(value);
  if (layer.id !== input.target.layerId) throw new TypeError('The style layer does not match the selected target.');
  const controls = new Map(getMapStyleControls(layer.type).map(control => [control.property, control]));
  const patch: MapStyleEditPatch = { paint: {}, layout: {} };
  const predicate = input.scope === 'feature'
    ? ['==', ['id'], input.target.featureId]
    : input.scope === 'similar'
      ? ['all', ['has', input.match!.property], ['==', ['get', input.match!.property], input.match!.value]]
      : null;
  for (const [property, next] of Object.entries(input.changes) as Array<[MapStyleEditProperty, MapStyleEditChangeValue]>) {
    const control = controls.get(property);
    if (!control) throw new TypeError(`The ${property} property is not supported by ${layer.type} layers.`);
    if (predicate && !canScopeMapStyleControl(layer, control)) throw new TypeError(`The ${property} property requires layer scope.`);
    const bucket = patch[control.section];
    let current = layer[control.section]?.[property] ?? mapStyleControlFallback(layer, control);
    if (predicate && isFunction(current)) {
      const specification = v8[`${control.section}_${layer.type}` as keyof typeof v8] as Record<string, StylePropertySpecification>;
      current = convertFunction(current, specification[property]!);
    }
    bucket[property] = predicate ? scopeValue(predicate, next, current) : next;
    if (predicate) {
      const specification = v8[`${control.section}_${layer.type}` as keyof typeof v8] as Record<string, StylePropertySpecification>;
      const compiled = createPropertyExpression(bucket[property], property, specification[property]!);
      if (compiled.result === 'error') throw new TypeError(`The ${property} expression cannot be applied to this scope.`);
    }
  }
  return patch;
}

function scopeValue(predicate: unknown[], next: MapStyleEditChangeValue, current: unknown): unknown {
  if (!containsZoom(current)) return ['case', cloneExpression(predicate), expressionLiteral(next), expressionLiteral(current)];
  if (!Array.isArray(current) || !['step', 'interpolate', 'interpolate-lab', 'interpolate-hcl'].includes(current[0])) {
    throw new TypeError('The current zoom expression cannot be preserved for a scoped edit.');
  }
  const inputIndex = current[0] === 'step' ? 1 : 2;
  if (!isZoom(current[inputIndex])) {
    throw new TypeError('The current zoom expression cannot be preserved for a scoped edit.');
  }
  return current.map((value, index) => {
    const output = current[0] === 'step' ? index === 2 || (index >= 4 && index % 2 === 0) : index >= 4 && index % 2 === 0;
    return output ? ['case', cloneExpression(predicate), expressionLiteral(next), expressionLiteral(value)] : value;
  });
}

function containsZoom(value: unknown): boolean {
  return Array.isArray(value) && (isZoom(value) || value.some(containsZoom));
}

function isZoom(value: unknown): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === 'zoom';
}

function cloneExpression(value: unknown): unknown {
  return Array.isArray(value) ? value.map(cloneExpression) : value;
}

function expressionLiteral(value: unknown): unknown {
  return Array.isArray(value) && !isExpression(value) ? ['literal', value] : value;
}
