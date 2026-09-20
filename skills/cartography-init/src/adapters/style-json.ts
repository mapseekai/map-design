import {
  emptyExtracted,
  type CoreStyleProps,
  type Dimension,
  type ExtractedElement,
  type ExtractedStyle,
  type ExtractedType,
  type Geometry,
} from '../ir.js';

type JsonObject = Record<string, unknown>;

export function parseStyleJson(text: string, fileName?: string): ExtractedStyle {
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) throw new Error('style.json 根节点必须是对象');

  const extracted = emptyExtracted(fileName === undefined ? { kind: 'style' } : { kind: 'style', name: fileName });
  extractSources(parsed.sources, extracted);
  if (!Object.hasOwn(parsed, 'glyphs')) {
    extracted.unresolved.push({ topic: 'glyphs', detail: 'style.json 未定义 glyphs,下游转换需补充' });
  }
  if (!Object.hasOwn(parsed, 'sprite')) {
    extracted.unresolved.push({ topic: 'sprites', detail: 'style.json 未定义 sprite,下游转换需补充' });
  }
  if (!Array.isArray(parsed.layers)) return extracted;

  for (const layer of parsed.layers) {
    if (isObject(layer)) extractLayer(layer, extracted);
  }
  return extracted;
}

function extractSources(sources: unknown, extracted: ExtractedStyle): void {
  if (!isObject(sources)) return;
  for (const [name, source] of Object.entries(sources)) {
    if (!isObject(source) || typeof source.type !== 'string') continue;
    const location = typeof source.url === 'string'
      ? source.url
      : Array.isArray(source.tiles) && source.tiles.every((tile) => typeof tile === 'string')
        ? source.tiles.join(',')
        : '';
    extracted.datasources.push({
      source: 'style',
      layer: name,
      identity: `${source.type}:${location}`,
      providerType: source.type,
    });
  }
}

function extractLayer(layer: JsonObject, extracted: ExtractedStyle): void {
  if (typeof layer.id !== 'string' || typeof layer.type !== 'string') return;
  const name = layer.id;
  if (typeof layer['source-layer'] === 'string') {
    extracted.bindings.push({ source: 'style', layer: name, kind: 'source-layer', expression: layer['source-layer'] });
  }
  if (layer.filter !== undefined) {
    extracted.bindings.push({ source: 'style', layer: name, kind: 'filter', expression: JSON.stringify(layer.filter) });
  }

  const scaleHints = extractZoomHints(layer, extracted);
  const style: CoreStyleProps = {};
  let rawTypography: ExtractedType | undefined;
  const paint = isObject(layer.paint) ? layer.paint : {};
  const layout = isObject(layer.layout) ? layer.layout : {};

  for (const [property, value] of Object.entries(paint)) {
    if (property === 'line-dasharray' && isNumericArray(value)) {
      const width = paint['line-width'] ?? 1;
      if (typeof width !== 'number' || width <= 0 || value.some(part => part <= 0) || value.length % 2 !== 0) {
        extracted.skipped.push({ source: 'style', layer: name, reason: 'Dash lengths require a positive literal line width and an even positive pattern; adaptation warning' });
        continue;
      }
      const dash = value.map((part) => px(part * width));
      style.dash = dash;
      extracted.dashes.push({ pattern: dash, nameHint: name, usedBy: [name] });
      continue;
    }
    if (!isLiteral(value)) {
      recordExpression(value, name, property, extracted);
      if (isInterpolate(value)) extractInterpolateHints(value, scaleHints, extracted);
      continue;
    }
    extractPaintLiteral(property, value, name, style, extracted);
  }

  const fontFamily = Array.isArray(layout['text-font']) && layout['text-font'].every((font) => typeof font === 'string')
    ? layout['text-font'] as string[]
    : undefined;
  const textSize = layout['text-size'];
  if (typeof layout['symbol-spacing'] === 'number') {
    style.spacing = px(layout['symbol-spacing']);
    extracted.spacing.push({ value: style.spacing, nameHint: name, usedBy: [name] });
    extracted.unresolved.push({ topic: 'spacing', detail: `${name}: symbol-spacing is repeat spacing along the path; confirm design guidance` });
  }
  if (layout['icon-size'] !== undefined) extracted.unresolved.push({ topic: 'size', detail: `${name}: icon-size is a scale factor; intrinsic asset dimensions are required to determine nominal body long side` });
  if (fontFamily && typeof textSize === 'number') {
    rawTypography = { fontFamily, fontSize: px(textSize), nameHint: name, usedBy: [name] };
    if (typeof layout['text-letter-spacing'] === 'number') rawTypography.letterSpacing = { value: layout['text-letter-spacing'], unit: 'em' };
    if (typeof layout['text-line-height'] === 'number') rawTypography.lineHeight = layout['text-line-height'];
    const transform = layout['text-transform'];
    if (transform === 'none' || transform === 'uppercase' || transform === 'lowercase') rawTypography.textTransform = transform;
    extracted.typography.push(rawTypography);
  }
  for (const [property, value] of Object.entries(layout)) {
    if (property === 'text-font' || property === 'text-size') continue;
    if (!isLiteral(value)) recordExpression(value, name, property, extracted);
  }
  if (layout['text-font'] !== undefined && !fontFamily) recordExpression(layout['text-font'], name, 'text-font', extracted);
  if (textSize !== undefined && typeof textSize !== 'number') recordExpression(textSize, name, 'text-size', extracted);

  if (Object.keys(style).length === 0 && !rawTypography) {
    extracted.skipped.push({ source: 'style', layer: name, reason: '图层没有可转换的字面量样式属性' });
    return;
  }
  const geometry = geometryFor(layer.type, rawTypography !== undefined);
  const element: ExtractedElement = { name, geometry, style, scaleHints };
  if (rawTypography) element.rawTypography = rawTypography;
  extracted.elements.push(element);
}

function extractPaintLiteral(property: string, value: string | number | boolean | null, name: string, style: CoreStyleProps, extracted: ExtractedStyle): void {
  if (property.endsWith('-color') && typeof value === 'string') {
    extracted.colors.push({ value, nameHint: name, usedBy: [name] });
    if (property === 'line-color') style.strokeColor = value;
    else if (property === 'fill-color' || property === 'circle-color') style.fillColor = value;
    else if (property === 'fill-outline-color' || property === 'circle-stroke-color') style.outlineColor = value;
    else if (property === 'text-halo-color') style.haloColor = value;
    else style.color = value;
    return;
  }
  if (typeof value !== 'number') return;
  if (property === 'line-width') {
    style.strokeWidth = px(value);
    extracted.widths.push({ value: style.strokeWidth, nameHint: name, usedBy: [name] });
  } else if (property === 'circle-radius') {
    style.size = px(value * 2);
    style.symbol = 'circle';
    extracted.sizes.push({ value: style.size, nameHint: name, usedBy: [name] });
  } else if (property === 'text-size') {
    extracted.skipped.push({ source: 'style', layer: name, reason: 'text-size belongs to layout typography; not a symbol size' });
  } else if (property === 'circle-stroke-width') {
    style.outlineWidth = px(value);
    extracted.widths.push({ value: style.outlineWidth, nameHint: name, usedBy: [name] });
  } else if (property === 'line-offset') {
    style.offset = px(value);
    extracted.unresolved.push({ topic: 'offset', detail: `${name}: confirm line-relative direction and signed offset convention in design prose` });
  } else if (property === 'text-halo-width') {
    style.haloWidth = px(value);
    extracted.widths.push({ value: style.haloWidth, nameHint: name, usedBy: [name] });
  } else if (property.endsWith('-opacity')) {
    extracted.opacities.push({ value, nameHint: name, usedBy: [name] });
    if (property === 'fill-opacity') style.fillOpacity = value;
    else if (property === 'line-opacity') style.strokeOpacity = value;
    else if (property === 'circle-opacity') style.fillOpacity = value;
    else if (property === 'circle-stroke-opacity') {
      extracted.skipped.push({ source: 'style', layer: name, reason: 'Independent outline opacity has no equivalent core property; adaptation warning' });
    } else style.opacity = value;
  }
}

function extractZoomHints(layer: JsonObject, extracted: ExtractedStyle) {
  const hints = [];
  if (typeof layer.minzoom === 'number' && typeof layer.maxzoom === 'number') {
    hints.push({ fact: `zoom ${layer.minzoom}–${layer.maxzoom} 可见` });
  } else if (typeof layer.minzoom === 'number') {
    hints.push({ fact: `zoom ${layer.minzoom} 以上可见` });
  } else if (typeof layer.maxzoom === 'number') {
    hints.push({ fact: `zoom ${layer.maxzoom} 以下可见` });
  }
  extracted.scaleHints.push(...hints);
  return hints;
}

function extractInterpolateHints(value: unknown[], hints: ExtractedElement['scaleHints'], extracted: ExtractedStyle): void {
  const stops: string[] = [];
  for (let index = 3; index + 1 < value.length; index += 2) {
    if (typeof value[index] === 'number' && typeof value[index + 1] === 'number') {
      stops.push(`zoom ${value[index]} 时 ${value[index + 1]}px`);
    }
  }
  if (stops.length === 0) return;
  const hint = { fact: stops.join(',') };
  hints.push(hint);
  extracted.scaleHints.push(hint);
}

function recordExpression(value: unknown, layer: string, property: string, extracted: ExtractedStyle): void {
  const dataDriven = containsGet(value);
  extracted.skipped.push({
    source: 'style',
    layer,
    reason: dataDriven ? `数据驱动 expression: ${property}` : `不支持的 expression: ${property}`,
    detail: JSON.stringify(value).slice(0, 200),
  });
}

function geometryFor(type: string, hasText: boolean): Geometry {
  if (type === 'line') return 'line';
  if (type === 'fill') return 'polygon';
  if (type === 'circle') return 'point';
  if (type === 'symbol') return hasText ? 'label' : 'point';
  if (type === 'background') return 'background';
  if (type === 'raster') return 'raster';
  return 'mixed';
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumericArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'number');
}

function isLiteral(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isInterpolate(value: unknown): value is unknown[] {
  return Array.isArray(value) && value[0] === 'interpolate';
}

function containsGet(value: unknown): boolean {
  return Array.isArray(value)
    ? value.some((part, index) => (index === 0 && part === 'get') || containsGet(part))
    : isObject(value) && Object.values(value).some(containsGet);
}

function px(value: number): Dimension {
  return { value, unit: 'px' };
}
