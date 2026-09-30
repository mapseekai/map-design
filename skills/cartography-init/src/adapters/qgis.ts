import { XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
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

const units: Readonly<Record<string, DimensionUnit>> = {
  MM: 'mm', Point: 'pt', Points: 'pt', Pixels: 'px', Inches: 'in',
};

export function parseQgis(buffer: Buffer, fileName: string): ExtractedStyle {
  const xml = qgsXml(buffer);
  const parsed: unknown = new XMLParser({
    ignoreAttributes: false,
    isArray: (tagName) => ['maplayer', 'symbol', 'layer', 'rule', 'category', 'range', 'prop', 'Option'].includes(tagName),
  }).parse(xml);
  const extracted = emptyExtracted({ kind: 'qgis', name: fileName });
  extracted.unresolved.push(
    { topic: 'target tile source url/type', detail: '桌面样式不含瓦片源定义,转换需另行供给' },
    { topic: 'crs/tiling', detail: '坐标参考与切片方案未定' },
    { topic: 'glyphs', detail: '字体供给未定' },
    { topic: 'sprites', detail: '符号精灵图供给未定' },
  );
  if (!isNode(parsed)) return extracted;

  for (const mapLayer of findNodes(parsed, 'maplayer')) extractMapLayer(mapLayer, extracted);
  return extracted;
}

function qgsXml(buffer: Buffer): string {
  if (buffer.subarray(0, 4).equals(Buffer.from('PK\x03\x04'))) {
    const entries = unzipSync(buffer);
    const entry = Object.entries(entries).find(([name]) => name.toLowerCase().endsWith('.qgs'));
    if (!entry) throw new Error('QGZ archive does not contain a .qgs entry');
    return new TextDecoder().decode(entry[1]);
  }
  return buffer.toString('utf8');
}

function extractMapLayer(mapLayer: XmlNode, extracted: ExtractedStyle): void {
  const layerName = textOf(mapLayer.layername) ?? 'Unnamed layer';
  const provider = textOf(mapLayer.provider);
  const datasource = textOf(mapLayer.datasource);
  if (provider && datasource) {
    extracted.datasources.push({ source: 'qgis', layer: layerName, identity: `${provider}:${datasource}`, providerType: provider });
  }

  const renderer = firstNode(mapLayer['renderer-v2']);
  if (renderer) extractRenderer(renderer, layerName, extracted);
  else {
    for (const rasterRenderer of findNodes(mapLayer, 'rasterrenderer')) {
      skip(extracted, layerName, '栅格渲染器尚未转换', rasterRenderer);
    }
  }
  if (attribute(mapLayer, 'labelsEnabled') === '0' && mapLayer.labeling) {
    skip(extracted, layerName, 'labelsEnabled=0：当前标注提取未应用启用状态');
  }
  if (attribute(mapLayer, 'labelsEnabled') === '1' && !mapLayer.labeling) {
    skip(extracted, layerName, 'labelsEnabled=1 但缺少 labeling，未生成标注');
  }
  const legacyLabels = findNodes(mapLayer.customproperties, 'property')
    .filter(property => attribute(property, 'key')?.startsWith('labeling'));
  if (legacyLabels.length) skip(extracted, layerName, '旧版 customproperties labeling 尚未转换', legacyLabels);
  extractLabeling(firstNode(mapLayer.labeling), layerName, extracted);
}

function extractRenderer(renderer: XmlNode, layerName: string, extracted: ExtractedStyle): void {
  const type = attribute(renderer, 'type');
  if (!['singleSymbol', 'RuleBased', 'categorizedSymbol', 'graduatedSymbol'].includes(type ?? '')) {
    skip(extracted, layerName, `未转换的渲染器: ${type ?? 'unknown'}`, renderer);
    return;
  }
  if (type === 'categorizedSymbol' || type === 'graduatedSymbol') {
    skip(extracted, layerName, `分类条件尚未转换: ${type}, attr=${attribute(renderer, 'attr') ?? ''}`, renderer.categories ?? renderer.ranges);
  }
  for (const rule of findNodes(renderer.rules, 'rule')) {
    if (nodesOf(rule.rule).length) skip(extracted, layerName, '嵌套渲染规则尚未转换', rule);
  }
  const symbols = new Map(nodesOf(firstNode(renderer.symbols)?.symbol).map((symbol) => [attribute(symbol, 'name') ?? '', symbol]));
  if (type === 'singleSymbol') {
    const symbol = symbols.values().next().value as XmlNode | undefined;
    if (symbol) extractSymbol(symbol, layerName, undefined, undefined, extracted);
    else skip(extracted, layerName, 'singleSymbol 缺少符号');
    return;
  }

  const entries = type === 'RuleBased'
    ? nodesOf(firstNode(renderer.rules)?.rule).map((rule) => ({
      symbol: attribute(rule, 'symbol'), name: attribute(rule, 'label') ?? layerName, filter: attribute(rule, 'filter'), value: undefined,
    }))
    : type === 'categorizedSymbol'
      ? nodesOf(firstNode(renderer.categories)?.category).map((category) => ({
        symbol: attribute(category, 'symbol'), name: attribute(category, 'label') ?? attribute(category, 'value') ?? layerName,
        filter: undefined, value: attribute(category, 'value'),
      }))
      : type === 'graduatedSymbol'
        ? nodesOf(firstNode(renderer.ranges)?.range).map((range) => ({
          symbol: attribute(range, 'symbol'), name: attribute(range, 'label') ?? layerName,
          filter: undefined, value: attribute(range, 'lower') ?? attribute(range, 'upper'),
        }))
        : [];

  for (const [index, entry] of entries.entries()) {
    const symbol = entry.symbol ? symbols.get(entry.symbol) : undefined;
    if (!symbol) {
      skip(extracted, layerName, `规则引用的符号未找到: ${entry.symbol ?? 'unknown'}`, entry);
      continue;
    }
    const element = extractSymbol(symbol, entry.name, layerName, roleFor(index), extracted);
    if (!element) continue;
    if (entry.filter) extracted.bindings.push({ source: 'qgis', layer: entry.name, family: layerName, kind: 'filter', expression: entry.filter });
    if (entry.value) extracted.bindings.push({ source: 'qgis', layer: entry.name, family: layerName, kind: 'field-ref', expression: entry.value });
  }
}

function extractSymbol(symbol: XmlNode, name: string, family: string | undefined, roleHint: ExtractedElement['roleHint'] | undefined, extracted: ExtractedStyle): ExtractedElement | undefined {
  const geometry = geometryFor(attribute(symbol, 'type'));
  if (!geometry) {
    skip(extracted, name, `未转换的符号几何类型: ${attribute(symbol, 'type') ?? 'unknown'}`, symbol);
    return undefined;
  }
  const style: CoreStyleProps = {};
  const element: ExtractedElement = { name, geometry, style, scaleHints: [] };
  if (family) element.family = family;
  if (roleHint) element.roleHint = roleHint;

  const layers = nodesOf(symbol.layer);
  if (layers.length > 1) skip(extracted, name, `多个 symbol layer 的叠加语义尚未转换（${layers.length} 层，核心属性按原顺序覆盖）`);
  if (attribute(symbol, 'alpha') && attribute(symbol, 'alpha') !== '1') skip(extracted, name, '符号 alpha 尚未转换', attribute(symbol, 'alpha'));
  for (const layer of layers) extractSymbolLayer(layer, style, name, extracted, family);
  if (Object.keys(style).length) extracted.elements.push(element);
  else extracted.skipped.push({ source: 'qgis', layer: name, reason: '未提取到可表示的核心样式属性，省略空符号' });
  return element;
}

function extractSymbolLayer(layer: XmlNode, style: CoreStyleProps, name: string, extracted: ExtractedStyle, family?: string): void {
  const props = properties(layer);
  const className = attribute(layer, 'class');
  const unit = unitFor(props.get('line_width_unit') ?? props.get('outline_width_unit') ?? props.get('size_unit'), name, extracted);
  if (className === 'SimpleLine') {
    setColor(props.get('line_color'), 'strokeColor', style, name, extracted);
    setDimension(props.get('line_width'), 'strokeWidth', style, unit, name, extracted);
    const dash = props.get('customdash');
    if (props.get('line_style') === 'dash' && dash && unit) setDash(dash, unit, style, name, extracted);
  } else if (className === 'SimpleFill') {
    setColor(props.get('color'), 'fillColor', style, name, extracted);
    setColor(props.get('outline_color'), 'strokeColor', style, name, extracted);
    setDimension(props.get('outline_width'), 'outlineWidth', style, unit, name, extracted);
  } else if (className === 'SimpleMarker') {
    setColor(props.get('color'), 'fillColor', style, name, extracted);
    setColor(props.get('outline_color'), 'strokeColor', style, name, extracted);
    setDimension(props.get('size'), 'size', style, unit, name, extracted);
  } else {
    extracted.skipped.push({ source: 'qgis', layer: name, reason: `不支持的符号图层: ${className ?? 'unknown'}` });
  }
  // Keep existing extraction semantics; explicitly account for properties outside
  // the core mapping, including solid/dash/none flags and per-property units.
  const mapped = className === 'SimpleLine' ? ['line_color', 'line_width', 'line_width_unit']
    : className === 'SimpleFill' ? ['color', 'outline_color', 'outline_width', 'outline_width_unit']
      : className === 'SimpleMarker' ? ['color', 'outline_color', 'size', 'size_unit'] : [];
  if (className === 'SimpleLine' && props.get('line_style') === 'dash' && props.get('customdash') && unit) mapped.push('customdash');
  const remaining = Object.fromEntries([...props].filter(([key]) => !mapped.includes(key)));
  if (Object.keys(remaining).length) skip(extracted, name, `${className ?? 'unknown'} 未转换属性: ${Object.keys(remaining).join(', ')}`, remaining);
  if (attribute(layer, 'enabled') === '0') skip(extracted, name, 'symbol layer enabled=0：当前提取未应用启用状态');
  extractDataDefined(firstNode(layer.data_defined_properties), name, family, extracted);
}

function extractLabeling(labeling: XmlNode | undefined, layerName: string, extracted: ExtractedStyle): void {
  if (!labeling) return;
  const textStyles = findNodes(labeling, 'text-style');
  const textStyle = textStyles[0];
  if (!textStyle) {
    skip(extracted, layerName, '标注缺少 text-style，尚未转换', labeling);
    return;
  }
  if (attribute(labeling, 'type') === 'rule-based') skip(extracted, layerName, '规则式标注条件尚未转换；仅提取首个 text-style', firstNode(labeling.rules));
  for (const [index, item] of textStyles.entries()) {
    const supported = ['fontFamily', 'font-family', 'fontSize', 'font-size', 'fontSizeUnit', 'font-size-unit', 'bufferColor', 'buffer-color', 'bufferSize', 'buffer-size'];
    const remaining = Object.fromEntries([...attributesAndProperties(item)].filter(([key]) => !supported.includes(key)));
    if (Object.keys(remaining).length) skip(extracted, layerName, `text-style[${index}] 未转换属性: ${Object.keys(remaining).join(', ')}`, remaining);
    const children = Object.keys(item).filter(key => !key.startsWith('@_'));
    if (children.length) skip(extracted, layerName, `text-style[${index}] 子设置尚未转换: ${children.join(', ')}`);
    if (index > 0) skip(extracted, layerName, `额外 text-style[${index}] 尚未转换`, item);
  }
  const labelSettings = findNodes(labeling, 'settings');
  for (const [index, settings] of labelSettings.entries()) {
    const remaining = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'text-style'));
    if (Object.keys(remaining).length) skip(extracted, layerName, `标注 settings[${index}] 尚未转换: ${Object.keys(remaining).join(', ')}`, remaining);
    for (const tag of ['text-buffer', 'text-mask', 'background', 'shadow']) {
      for (const item of findNodes(settings['text-style'], tag)) skip(extracted, layerName, `标注 ${tag}[${index}] 尚未转换`, item);
    }
  }
  const props = attributesAndProperties(textStyle);
  const family = props.get('fontFamily') ?? props.get('font-family');
  const size = numberOf(props.get('fontSize') ?? props.get('font-size'));
  const unit = unitFor(props.get('fontSizeUnit') ?? props.get('font-size-unit'), layerName, extracted);
  if (!family || size === undefined || !unit) {
    skip(extracted, layerName, '标注缺少可转换的字体、字号或单位', textStyle);
    return;
  }
  const rawTypography: ExtractedType = { fontFamily: [family], fontSize: dimension(size, unit), nameHint: layerName, usedBy: [layerName] };
  const element: ExtractedElement = { name: layerName, geometry: 'label', style: {}, rawTypography, scaleHints: [] };
  const haloColor = props.get('bufferColor') ?? props.get('buffer-color');
  const haloWidth = numberOf(props.get('bufferSize') ?? props.get('buffer-size'));
  setColor(haloColor, 'haloColor', element.style, layerName, extracted);
  setDimensionValue(haloWidth, 'haloWidth', element.style, unit, layerName, extracted);
  extracted.typography.push(rawTypography);
  extracted.elements.push(element);
}

function skip(extracted: ExtractedStyle, layer: string, reason: string, detail?: unknown): void {
  extracted.skipped.push({ source: 'qgis', layer, reason,
    ...(detail === undefined ? {} : { detail: JSON.stringify(detail).slice(0, 200) }) });
}

function extractDataDefined(properties: XmlNode | undefined, name: string, family: string | undefined, extracted: ExtractedStyle): void {
  for (const option of findNodes(properties, 'Option')) {
    if (attribute(option, 'name') === 'active') continue;
    const children = nodesOf(option.Option);
    const active = children.find((child) => attribute(child, 'name') === 'active');
    const expression = children.find((child) => attribute(child, 'name') === 'expression');
    const expressionValue = attribute(expression, 'value');
    if (attribute(active, 'value') !== '1' || !expressionValue) continue;
    const binding = { source: 'qgis' as const, layer: name, kind: 'field-override' as const, expression: expressionValue };
    if (family) extracted.bindings.push({ ...binding, family });
    else extracted.bindings.push(binding);
  }
}

function properties(layer: XmlNode): Map<string, string> {
  const result = new Map<string, string>();
  for (const prop of nodesOf(layer.prop)) {
    const key = attribute(prop, 'k');
    const value = attribute(prop, 'v');
    if (key && value !== undefined) result.set(key, value);
  }
  for (const option of nodesOf(firstNode(layer.Option)?.Option)) {
    const key = attribute(option, 'name');
    const value = attribute(option, 'value');
    if (key && value !== undefined) result.set(key, value);
  }
  return result;
}

function attributesAndProperties(node: XmlNode): Map<string, string> {
  const result = properties(node);
  for (const [key, value] of Object.entries(node)) if (key.startsWith('@_') && typeof value === 'string') result.set(key.slice(2), value);
  return result;
}

function setColor(value: string | undefined, property: 'fillColor' | 'strokeColor' | 'haloColor', style: CoreStyleProps, name: string, extracted: ExtractedStyle): void {
  const color = qgisColor(value);
  if (!color) return;
  style[property] = color;
  extracted.colors.push({ value: color, nameHint: name, usedBy: [name] });
}

function setDimension(value: string | undefined, property: 'strokeWidth' | 'outlineWidth' | 'size', style: CoreStyleProps, unit: DimensionUnit | undefined, name: string, extracted: ExtractedStyle): void {
  setDimensionValue(numberOf(value), property, style, unit, name, extracted);
}

function setDimensionValue(value: number | undefined, property: 'strokeWidth' | 'outlineWidth' | 'size' | 'haloWidth', style: CoreStyleProps, unit: DimensionUnit | undefined, name: string, extracted: ExtractedStyle): void {
  if (value === undefined || !unit) return;
  const result = dimension(value, unit);
  style[property] = result;
  (property === 'size' ? extracted.sizes : extracted.widths).push({ value: result, nameHint: name, usedBy: [name] });
}

function setDash(value: string, unit: DimensionUnit, style: CoreStyleProps, name: string, extracted: ExtractedStyle): void {
  const values = value.split(/[;, ]+/).map(Number).filter(Number.isFinite);
  if (!values.length) return;
  style.dash = values.map((item) => dimension(item, unit));
  extracted.dashes.push({ pattern: style.dash, nameHint: name, usedBy: [name] });
}

function unitFor(value: string | undefined, layer: string, extracted: ExtractedStyle): DimensionUnit | undefined {
  if (!value) return 'mm';
  const unit = units[value];
  if (unit) return unit;
  extracted.skipped.push({ source: 'qgis', layer, reason: `不支持且无法无损换算的长度单位: ${value}` });
  return undefined;
}

function qgisColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const channels = value.replace(/,rgb:.*$/, '').split(',').map((channel) => Number(channel.trim()));
  if (channels.length < 3 || channels.length > 4 || !channels.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)) return undefined;
  const red = channels[0]!;
  const green = channels[1]!;
  const blue = channels[2]!;
  const alpha = channels[3] ?? 255;
  if (alpha < 255) return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function geometryFor(type: string | undefined): Geometry | undefined {
  if (type === 'line') return 'line';
  if (type === 'fill') return 'polygon';
  if (type === 'marker') return 'point';
  return undefined;
}

function roleFor(index: number): ExtractedElement['roleHint'] {
  return undefined; // Renderer order is not evidence of a stable design role.
}

function attribute(node: XmlNode | undefined, name: string): string | undefined {
  return node ? stringOf(node[`@_${name}`]) : undefined;
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
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dimension(value: number, unit: DimensionUnit): Dimension {
  return { value, unit };
}

function isNode(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
