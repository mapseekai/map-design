import { XMLParser } from 'fast-xml-parser';
import {
  emptyExtracted,
  type CoreStyleProps,
  type Dimension,
  type DimensionUnit,
  type ExtractedElement,
  type ExtractedStyle,
  type ExtractedType,
  type Geometry,
} from '../ir.js';

type XmlNode = Record<string, unknown>;

const symbolizers: ReadonlyArray<[string, Geometry]> = [
  ['LineSymbolizer', 'line'],
  ['PolygonSymbolizer', 'polygon'],
  ['PointSymbolizer', 'point'],
  ['TextSymbolizer', 'label'],
];

export function parseSld(text: string, fileName?: string): ExtractedStyle {
  const parsed: unknown = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    isArray: (tagName) => ['Rule', 'LineSymbolizer', 'PolygonSymbolizer', 'PointSymbolizer', 'TextSymbolizer'].includes(tagName),
  }).parse(text);
  const extracted = emptyExtracted(fileName === undefined ? { kind: 'sld' } : { kind: 'sld', name: fileName });
  extracted.unresolved.push(
    { topic: 'target tile source url/type', detail: '桌面样式不含瓦片源定义,转换需另行供给' },
    { topic: 'crs/tiling', detail: '坐标参考与切片方案未定' },
    { topic: 'glyphs', detail: '字体供给未定' },
    { topic: 'sprites', detail: '符号精灵图供给未定' },
  );
  if (!isNode(parsed)) return extracted;

  for (const rule of findNodes(parsed, 'Rule')) extractRule(rule, extracted);
  return extracted;
}

function extractRule(rule: XmlNode, extracted: ExtractedStyle): void {
  const name = textOf(rule.Name) || 'Unnamed rule';
  extractFilters(rule, name, extracted);
  const scaleHints = extractScaleHints(rule, extracted);

  for (const [tag, geometry] of symbolizers) {
    for (const symbolizer of nodesOf(rule[tag])) {
      const unit = unitFor(symbolizer, name, extracted);
      if (!unit) continue;
      const style: CoreStyleProps = {};
      let rawTypography: ExtractedType | undefined;
      if (tag === 'LineSymbolizer') extractLine(symbolizer, style, unit, name, extracted);
      else if (tag === 'PolygonSymbolizer') extractPolygon(symbolizer, style, unit, name, extracted);
      else if (tag === 'PointSymbolizer') extractPoint(symbolizer, style, unit, name, extracted);
      else rawTypography = extractText(symbolizer, unit, name);

      const element: ExtractedElement = { name, geometry, style, scaleHints: [...scaleHints] };
      if (rawTypography) {
        element.rawTypography = rawTypography;
        extracted.typography.push(rawTypography);
      }
      extracted.elements.push(element);
    }
  }
}

function extractLine(symbolizer: XmlNode, style: CoreStyleProps, unit: DimensionUnit, name: string, extracted: ExtractedStyle): void {
  extractStroke(firstNode(symbolizer.Stroke), style, unit, name, extracted);
}

function extractPolygon(symbolizer: XmlNode, style: CoreStyleProps, unit: DimensionUnit, name: string, extracted: ExtractedStyle): void {
  const fill = parameters(firstNode(symbolizer.Fill));
  setColor(fill.get('fill'), 'fillColor', style, name, extracted);
  setOpacity(fill.get('fill-opacity'), 'fillOpacity', style, name, extracted);
  extractStroke(firstNode(symbolizer.Stroke), style, unit, name, extracted);
}

function extractPoint(symbolizer: XmlNode, style: CoreStyleProps, unit: DimensionUnit, name: string, extracted: ExtractedStyle): void {
  const graphic = firstNode(symbolizer.Graphic);
  if (!graphic) return;
  const mark = firstNode(graphic.Mark);
  const fill = parameters(firstNode(mark?.Fill));
  setColor(fill.get('fill'), 'fillColor', style, name, extracted);
  setOpacity(fill.get('fill-opacity'), 'fillOpacity', style, name, extracted);
  extractStroke(firstNode(mark?.Stroke), style, unit, name, extracted);
  const size = numberOf(graphic.Size);
  if (size !== undefined) setDimension(size, 'size', style, unit, name, extracted);
}

function extractText(symbolizer: XmlNode, unit: DimensionUnit, name: string): ExtractedType | undefined {
  const font = parameters(firstNode(symbolizer.Font));
  const family = font.get('font-family');
  const size = numberOf(font.get('font-size'));
  if (!family || size === undefined) return undefined;
  const rawTypography: ExtractedType = { fontFamily: [family], fontSize: dimension(size, unit), nameHint: name, usedBy: [name] };
  const weight = font.get('font-weight');
  const fontStyle = font.get('font-style');
  if (fontStyle) rawTypography.fontStyle = fontStyle;
  const numericWeight = numberOf(weight);
  if (weight === 'normal' || weight === 'bold') rawTypography.fontWeight = weight;
  else if (numericWeight !== undefined) rawTypography.fontWeight = numericWeight;
  return rawTypography;
}

function extractStroke(stroke: XmlNode | undefined, style: CoreStyleProps, unit: DimensionUnit, name: string, extracted: ExtractedStyle): void {
  const params = parameters(stroke);
  setColor(params.get('stroke'), 'strokeColor', style, name, extracted);
  const width = numberOf(params.get('stroke-width'));
  if (width !== undefined) setDimension(width, 'strokeWidth', style, unit, name, extracted);
  setOpacity(params.get('stroke-opacity'), 'strokeOpacity', style, name, extracted);
  const dash = params.get('stroke-dasharray');
  if (dash) {
    const values = dash.trim().split(/[ ,]+/).map(Number);
    if (values.length > 0 && values.every(Number.isFinite)) {
      style.dash = values.map((value) => dimension(value, unit));
      extracted.dashes.push({ pattern: style.dash, nameHint: name, usedBy: [name] });
    }
  }
}

function setColor(value: string | undefined, property: 'fillColor' | 'strokeColor', style: CoreStyleProps, name: string, extracted: ExtractedStyle): void {
  if (!value) return;
  style[property] = value;
  extracted.colors.push({ value, nameHint: name, usedBy: [name] });
}

function setOpacity(value: string | undefined, property: 'fillOpacity' | 'strokeOpacity', style: CoreStyleProps, name: string, extracted: ExtractedStyle): void {
  const opacity = numberOf(value);
  if (opacity === undefined || opacity < 0 || opacity > 1) return;
  style[property] = opacity;
  extracted.opacities.push({ value: opacity, nameHint: name, usedBy: [name] });
}

function setDimension(value: number, property: 'size' | 'strokeWidth', style: CoreStyleProps, unit: DimensionUnit, name: string, extracted: ExtractedStyle): void {
  const result = dimension(value, unit);
  style[property] = result;
  (property === 'size' ? extracted.sizes : extracted.widths).push({ value: result, nameHint: name, usedBy: [name] });
}

function extractFilters(rule: XmlNode, name: string, extracted: ExtractedStyle): void {
  for (const filter of nodesOf(rule.Filter)) {
    extracted.bindings.push({ source: 'sld', layer: name, kind: 'filter', expression: serialize(filter) });
  }
}

function extractScaleHints(rule: XmlNode, extracted: ExtractedStyle): ExtractedElement['scaleHints'] {
  const hints: ExtractedElement['scaleHints'] = [];
  for (const [tag, label] of [['MinScaleDenominator', 'minimum'], ['MaxScaleDenominator', 'maximum']] as const) {
    const value = numberOf(rule[tag]);
    if (value === undefined) continue;
    const hint = { fact: `${label} scaleDenominator ${value}` };
    hints.push(hint);
    extracted.scaleHints.push(hint);
  }
  return hints;
}

function unitFor(symbolizer: XmlNode, name: string, extracted: ExtractedStyle): DimensionUnit | undefined {
  const uom = stringOf(symbolizer['@_uom']);
  if (!uom || uom === 'px' || uom.endsWith('/pixel')) return 'px';
  if (uom === 'pt' || uom === 'mm' || uom === 'cm' || uom === 'in') return uom;
  extracted.skipped.push({ source: 'sld', layer: name, reason: `不支持且无法无损换算的长度单位: ${uom}` });
  return undefined;
}

function parameters(node: XmlNode | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!node) return result;
  for (const tag of ['CssParameter', 'SvgParameter']) {
    for (const parameter of nodesOf(node[tag])) {
      const name = stringOf(parameter['@_name']);
      const value = textOf(parameter);
      if (name && value) result.set(name, value);
    }
  }
  return result;
}

function findNodes(node: unknown, key: string): XmlNode[] {
  if (!isNode(node)) return [];
  const found = nodesOf(node[key]);
  for (const value of Object.values(node)) {
    if (isNode(value)) found.push(...findNodes(value, key));
    else if (Array.isArray(value)) for (const item of value) found.push(...findNodes(item, key));
  }
  return found;
}

function nodesOf(value: unknown): XmlNode[] {
  return (Array.isArray(value) ? value : [value]).filter(isNode);
}

function firstNode(value: unknown): XmlNode | undefined {
  return nodesOf(value)[0];
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim() || undefined;
  if (!isNode(value)) return undefined;
  return stringOf(value['#text']) ?? stringOf(value.__text);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() || undefined : undefined;
}

function numberOf(value: unknown): number | undefined {
  const parsed = Number(typeof value === 'string' ? value.trim() : value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dimension(value: number, unit: DimensionUnit): Dimension {
  return { value, unit };
}

function serialize(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(serialize).join(',');
  if (!isNode(value)) return '';
  return Object.entries(value)
    .map(([key, child]) => key.startsWith('@_') ? `${key.slice(2)}=${serialize(child)}` : `${key}(${serialize(child)})`)
    .join(' ');
}

function isNode(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
