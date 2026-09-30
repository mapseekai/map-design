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
  const extracted = emptyExtracted({ kind: 'qgis', name: fileName });
  const xml = qgsXml(buffer, extracted);
  const parsed: unknown = new XMLParser({
    ignoreAttributes: false,
    isArray: (tagName) => ['maplayer', 'symbol', 'layer', 'rule', 'category', 'range', 'prop', 'Option'].includes(tagName),
  }).parse(xml);
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

function qgsXml(buffer: Buffer, extracted: ExtractedStyle): string {
  if (buffer.subarray(0, 4).equals(Buffer.from('PK\x03\x04'))) {
    const entries = unzipSync(buffer);
    const entry = Object.entries(entries).find(([name]) => name.toLowerCase().endsWith('.qgs'));
    if (!entry) throw new Error('QGZ archive does not contain a .qgs entry');
    for (const name of Object.keys(entries)) {
      if (name !== entry[0]) extracted.skipped.push({ source: 'qgis', reason: `QGZ 附属文件未读取: ${name}` });
    }
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
  extractLabeling(firstNode(mapLayer.labeling), layerName, extracted);
  if (attribute(mapLayer, 'labelsEnabled') === '0' && mapLayer.labeling) {
    extracted.skipped.push({ source: 'qgis', layer: layerName, reason: 'labelsEnabled=0：保留标注样式定义，未转换启用状态' });
  }
}

function extractRenderer(renderer: XmlNode, layerName: string, extracted: ExtractedStyle): void {
  const type = attribute(renderer, 'type');
  const symbols = new Map(nodesOf(firstNode(renderer.symbols)?.symbol).map((symbol) => [attribute(symbol, 'name') ?? '', symbol]));
  if (type === 'singleSymbol') {
    const symbol = symbols.values().next().value as XmlNode | undefined;
    if (symbol) extractSymbol(symbol, layerName, undefined, undefined, extracted);
    return;
  }

  const field = attribute(renderer, 'attr');
  if (field) extracted.bindings.push({ source: 'qgis', layer: layerName, kind: 'field-ref', expression: field });
  if (!['RuleBased', 'RuleRenderer', 'categorizedSymbol', 'graduatedSymbol'].includes(type ?? '')) {
    extracted.skipped.push({ source: 'qgis', layer: layerName, reason: `不支持的渲染器: ${type ?? 'unknown'}` });
    return;
  }
  for (const rule of nodesOf(firstNode(renderer.rules)?.rule)) {
    if (rule.rule) extracted.skipped.push({ source: 'qgis', layer: layerName, reason: '嵌套规则未转换', detail: JSON.stringify(rule).slice(0, 200) });
  }
  const entries = type === 'RuleBased' || type === 'RuleRenderer'
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
    if (!symbol) continue;
    const element = extractSymbol(symbol, entry.name, layerName, roleFor(index), extracted);
    if (!element) continue;
    if (entry.filter) extracted.bindings.push({ source: 'qgis', layer: entry.name, family: layerName, kind: 'filter', expression: entry.filter });
    if (entry.value) extracted.bindings.push({ source: 'qgis', layer: entry.name, family: layerName, kind: 'field-ref', expression: entry.value });
  }
}

function extractSymbol(symbol: XmlNode, name: string, family: string | undefined, roleHint: ExtractedElement['roleHint'] | undefined, extracted: ExtractedStyle): ExtractedElement | undefined {
  const geometry = geometryFor(attribute(symbol, 'type'));
  if (!geometry) {
    extracted.skipped.push({ source: 'qgis', layer: name, reason: `不支持的符号类型: ${attribute(symbol, 'type') ?? 'unknown'}` });
    return undefined;
  }
  const style: CoreStyleProps = {};
  const element: ExtractedElement = { name, geometry, style, scaleHints: [] };
  if (family) element.family = family;
  if (roleHint) element.roleHint = roleHint;

  const layers = nodesOf(symbol.layer);
  if (layers.length > 1) extracted.skipped.push({ source: 'qgis', layer: name,
    reason: `多个符号图层的叠加效果未转换（${layers.map(layer => attribute(layer, 'class')).join(', ')}）；同名核心属性保留最后一个可提取值` });
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
  const converted = className === 'SimpleLine' ? ['line_color', 'line_width', 'line_width_unit', ...(props.get('line_style') === 'dash' ? ['customdash'] : [])]
    : className === 'SimpleFill' ? ['color', 'outline_color', 'outline_width', 'outline_width_unit']
      : className === 'SimpleMarker' ? ['color', 'outline_color', 'size', 'size_unit'] : null;
  if (converted) {
    const remaining = [...props.keys()].filter(key => !converted.includes(key)).sort();
    if (remaining.length) extracted.skipped.push({ source: 'qgis', layer: name,
      reason: `${className} 未映射配置（含默认值）: ${remaining.join(', ')}`,
      detail: JSON.stringify(Object.fromEntries(remaining.map(key => [key, props.get(key)]))).slice(0, 200) });
  }
  extractDataDefined(firstNode(layer.data_defined_properties), name, family, extracted);
}

function extractLabeling(labeling: XmlNode | undefined, layerName: string, extracted: ExtractedStyle): void {
  if (!labeling) return;
  const textStyle = findNodes(labeling, 'text-style')[0];
  if (!textStyle) return;
  const props = attributesAndProperties(textStyle);
  const field = props.get('fieldName');
  if (field) extracted.bindings.push({ source: 'qgis', layer: layerName,
    kind: props.get('isExpression') === '1' ? 'field-override' : 'field-ref', expression: field });
  const converted = ['fontFamily', 'font-family', 'fontSize', 'font-size', 'fontSizeUnit', 'font-size-unit', 'bufferColor', 'buffer-color', 'bufferSize', 'buffer-size', 'fieldName', 'isExpression'];
  const remaining = [...props.keys()].filter(key => !converted.includes(key));
  const sections = [...Object.keys(textStyle).filter(key => !key.startsWith('@_')), ...Object.keys(firstNode(labeling.settings) ?? {}).filter(key => key !== 'text-style')];
  if (remaining.length || sections.length) extracted.skipped.push({ source: 'qgis', layer: layerName,
    reason: `未转换的标注配置（含默认或未启用设置）: ${[...new Set([...remaining, ...sections])].sort().join(', ')}` });
  if (findNodes(labeling, 'text-style').length > 1) extracted.skipped.push({ source: 'qgis', layer: layerName, reason: '多个标注样式仅提取第一个，其余标注规则未转换' });
  const family = props.get('fontFamily') ?? props.get('font-family');
  const size = numberOf(props.get('fontSize') ?? props.get('font-size'));
  const unit = unitFor(props.get('fontSizeUnit') ?? props.get('font-size-unit'), layerName, extracted);
  if (!family || size === undefined || !unit) return;
  const rawTypography: ExtractedType = { fontFamily: [family], fontSize: dimension(size, unit), nameHint: layerName, usedBy: [layerName] };
  const element: ExtractedElement = { name: layerName, geometry: 'label', style: {}, rawTypography, scaleHints: [] };
  const haloColor = props.get('bufferColor') ?? props.get('buffer-color');
  const haloWidth = numberOf(props.get('bufferSize') ?? props.get('buffer-size'));
  setColor(haloColor, 'haloColor', element.style, layerName, extracted);
  setDimensionValue(haloWidth, 'haloWidth', element.style, unit, layerName, extracted);
  extracted.typography.push(rawTypography);
  extracted.elements.push(element);
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
