import type { CoreStyleProps, Dimension, Geometry } from '../ir.js';

type CimNode = Record<string, unknown>;

export interface CimSymbolStyle {
  style: CoreStyleProps;
  geometry: Geometry;
  skippedReasons: string[];
}

export function cimColorToCss(color: unknown): string | null {
  if (!isNode(color)) return null;
  const values = numbers(color.values);
  if (color.type === 'CIMRGBColor' && values.length >= 3) return hex(values[0]!, values[1]!, values[2]!);
  if (color.type === 'CIMGrayColor' && values.length >= 1) return hex(values[0]!, values[0]!, values[0]!);
  if (color.type === 'CIMHSVColor' && values.length >= 3) return hsvToHex(values[0]!, values[1]!, values[2]!);
  return null;
}

export function cimSymbolToStyle(sym: CimNode): CimSymbolStyle | null {
  const geometry = geometryFor(sym.type);
  if (!geometry) return null;

  const style: CoreStyleProps = {};
  const skippedReasons: string[] = [];
  for (const layer of nodes(sym.symbolLayers)) extractSymbolLayer(layer, style, skippedReasons);
  for (const effect of nodes(sym.effects)) extractEffect(effect, style, skippedReasons);
  return { style, geometry, skippedReasons };
}

function extractSymbolLayer(layer: CimNode, style: CoreStyleProps, skippedReasons: string[]): void {
  const color = cimColorToCss(layer.color);
  switch (layer.type) {
    case 'CIMSolidStroke':
      if (color) style.strokeColor = color;
      setDimension(layer.width, 'strokeWidth', style);
      setOffset(layer, style, skippedReasons);
      return;
    case 'CIMSolidFill':
      if (color) style.fillColor = color;
      return;
    case 'CIMCharacterMarker':
    case 'CIMVectorMarker':
      style.symbol = markerName(layer);
      setDimension(layer.size, 'size', style);
      setOffset(layer, style, skippedReasons);
      return;
    case 'CIMHaloFill':
      if (color) style.haloColor = color;
      setDimension(layer.width, 'haloWidth', style);
      return;
    default:
      skippedReasons.push(`Unsupported CIM symbol layer: ${stringOf(layer.type) ?? 'unknown'}`);
  }
}

function extractEffect(effect: CimNode, style: CoreStyleProps, skippedReasons: string[]): void {
  if (effect.type !== 'CIMGeometricEffectDashes') {
    skippedReasons.push(`Unsupported CIM geometric effect: ${stringOf(effect.type) ?? 'unknown'}`);
    return;
  }
  const pattern = numbers(effect.dashTemplate ?? effect.dashPattern ?? effect.template);
  if (pattern.length) style.dash = pattern.map(pt);
}

function geometryFor(type: unknown): Geometry | undefined {
  if (type === 'CIMLineSymbol') return 'line';
  if (type === 'CIMPolygonSymbol') return 'polygon';
  if (type === 'CIMPointSymbol') return 'point';
  if (type === 'CIMTextSymbol') return 'label';
  return undefined;
}

function markerName(layer: CimNode): string {
  const marker = stringOf(layer.marker) ?? stringOf(layer.name) ?? stringOf(layer.character);
  if (marker) return marker;
  return layer.type === 'CIMCharacterMarker' ? 'character-marker' : 'vector-marker';
}

function setDimension(value: unknown, property: 'strokeWidth' | 'haloWidth' | 'size' | 'offset', style: CoreStyleProps): void {
  const number = numberOf(value);
  if (number !== undefined) style[property] = pt(number);
}

function setOffset(layer: CimNode, style: CoreStyleProps, skippedReasons: string[]): void {
  setDimension(layer.xoffset, 'offset', style);
  if (numberOf(layer.yoffset)) skippedReasons.push('CIM yoffset not migrated: IR offset only supports one axis');
}

function pt(value: number): Dimension {
  return { value, unit: 'pt' };
}

function hsvToHex(hue: number, saturation: number, value: number): string {
  const h = ((hue % 360) + 360) % 360 / 60;
  const s = saturation > 1 ? saturation / 100 : saturation;
  const v = value > 1 ? value / 100 : value;
  const chroma = v * s;
  const x = chroma * (1 - Math.abs(h % 2 - 1));
  const [red, green, blue] = h < 1 ? [chroma, x, 0] : h < 2 ? [x, chroma, 0] : h < 3 ? [0, chroma, x] : h < 4 ? [0, x, chroma] : h < 5 ? [x, 0, chroma] : [chroma, 0, x];
  const match = v - chroma;
  return hex((red + match) * 255, (green + match) * 255, (blue + match) * 255);
}

function hex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0')).join('')}`;
}

function nodes(value: unknown): CimNode[] {
  return (Array.isArray(value) ? value : [value]).filter(isNode);
}

function numbers(value: unknown): number[] {
  return (Array.isArray(value) ? value : []).map(numberOf).filter((item): item is number => item !== undefined);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isNode(value: unknown): value is CimNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
