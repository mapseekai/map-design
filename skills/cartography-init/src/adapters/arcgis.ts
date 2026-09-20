import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { cimSymbolToStyle } from './cim.js';
import { emptyExtracted, type ExtractedElement, type ExtractedStyle } from '../ir.js';

type CimNode = Record<string, unknown>;

export function parseLyrx(buffer: Buffer, fileName: string): ExtractedStyle {
  const extracted = emptyExtracted({ kind: 'lyrx', name: fileName });
  extracted.unresolved.push(
    { topic: 'target tile source url/type', detail: '桌面样式不含瓦片源定义,转换需另行供给' },
    { topic: 'crs/tiling', detail: '坐标参考与切片方案未定' },
    { topic: 'glyphs', detail: '字体供给未定' },
    { topic: 'sprites', detail: '符号精灵图供给未定' },
  );
  const document = parseDocument(buffer);
  if (!document) return extracted;
  for (const layer of nodes(document.layerDefinitions)) extractLayer(layer, extracted);
  return extracted;
}

export function parseStylx(buffer: Buffer, fileName: string): ExtractedStyle {
  const directory = mkdtempSync(path.join(tmpdir(), 'cartography-stylx-'));
  const file = path.join(directory, 'input.stylx');
  writeFileSync(file, buffer);

  let database: Database.Database | undefined;
  try {
    database = new Database(file, { readonly: true, fileMustExist: true });
    const itemsTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ITEMS'").get();
    if (!itemsTable) throw new Error('.stylx database does not contain an ITEMS table');

    const extracted = emptyExtracted({ kind: 'stylx', name: fileName });
    extracted.unresolved.push(
      { topic: 'target tile source url/type', detail: '桌面样式不含瓦片源定义,转换需另行供给' },
      { topic: 'crs/tiling', detail: '坐标参考与切片方案未定' },
      { topic: 'glyphs', detail: '字体供给未定' },
      { topic: 'sprites', detail: '符号精灵图供给未定' },
    );
    const items = database.prepare('SELECT NAME AS name, CATEGORY AS category, CONTENT AS content FROM ITEMS').all() as StylxItem[];
    for (const item of items) extractStylxItem(item, extracted);
    return extracted;
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

type StylxItem = {
  name: unknown;
  category: unknown;
  content: unknown;
};

function extractStylxItem(item: StylxItem, extracted: ExtractedStyle): void {
  const name = stringOf(item.name) ?? 'Unnamed symbol';
  const category = stringOf(item.category);
  if (!category || !['Symbols', 'Colors', 'Labels'].includes(category)) {
    extracted.skipped.push({ source: 'stylx', layer: name, reason: `Unsupported .stylx category: ${category ?? 'unknown'}` });
    return;
  }

  let symbol: unknown;
  try {
    symbol = JSON.parse(Buffer.isBuffer(item.content) ? item.content.toString('utf8') : String(item.content));
  } catch {
    extracted.skipped.push({ source: 'stylx', layer: name, reason: 'Invalid .stylx item JSON' });
    return;
  }
  extractElement(node(symbol), name, category, undefined, extracted, 'stylx');
}

function parseDocument(buffer: Buffer): CimNode | undefined {
  const text = buffer.subarray(0, 4).equals(Buffer.from('PK\x03\x04'))
    ? lyrxFromArchive(buffer)
    : buffer.toString('utf8');
  try {
    const parsed: unknown = JSON.parse(text);
    return isNode(parsed) ? parsed : undefined;
  } catch {
    throw new Error('Invalid .lyrx JSON document');
  }
}

function lyrxFromArchive(buffer: Buffer): string {
  const entries = unzipSync(buffer);
  const entry = Object.entries(entries).find(([name]) => name.toLowerCase().endsWith('.lyrx') || name.toLowerCase().endsWith('.json'));
  if (!entry) throw new Error('.lyrx archive does not contain a JSON layer document');
  return new TextDecoder().decode(entry[1]);
}

function extractLayer(layer: CimNode, extracted: ExtractedStyle): void {
  const layerName = stringOf(layer.name) ?? 'Unnamed layer';
  extractDataConnection(layer.featureTable, layerName, extracted);
  const renderer = node(layer.renderer);
  if (!renderer) return;
  extractWhereAndMappings(layer, renderer, layerName, extracted);

  switch (renderer.type) {
    case 'CIMSimpleRenderer':
      extractElement(symbolFor(renderer), layerName, undefined, undefined, extracted);
      return;
    case 'CIMUniqueValueRenderer':
      extractUniqueValues(renderer, layerName, extracted);
      return;
    case 'CIMClassBreaksRenderer':
      extractClassBreaks(renderer, layerName, extracted);
      return;
    default:
      extracted.skipped.push({ source: 'lyrx', layer: layerName, reason: `Unsupported CIM renderer: ${stringOf(renderer.type) ?? 'unknown'}` });
  }
}

function extractDataConnection(featureTable: unknown, layerName: string, extracted: ExtractedStyle): void {
  const dataConnection = node(node(featureTable)?.dataConnection);
  if (!dataConnection) return;
  const identity = stringOf(dataConnection.workspaceConnectionString) ?? stringOf(dataConnection.connectionString) ?? stringOf(dataConnection.path) ?? JSON.stringify(dataConnection);
  const providerType = stringOf(dataConnection.type);
  extracted.datasources.push({ source: 'lyrx', layer: layerName, identity, ...(providerType ? { providerType } : {}) });
}

function extractWhereAndMappings(layer: CimNode, renderer: CimNode, layerName: string, extracted: ExtractedStyle): void {
  for (const candidate of [layer.whereClause, layer.definitionExpression, renderer.whereClause]) {
    const expression = stringOf(candidate);
    if (expression) extracted.bindings.push({ source: 'lyrx', layer: layerName, kind: 'filter', expression });
  }
  for (const mapping of nodes(layer.attributeMapping).concat(nodes(renderer.attributeMapping))) {
    for (const [field, expression] of Object.entries(mapping)) {
      const value = stringOf(expression);
      if (value) extracted.bindings.push({ source: 'lyrx', layer: layerName, kind: 'field-override', expression: `${field}: ${value}` });
    }
  }
}

function extractUniqueValues(renderer: CimNode, layerName: string, extracted: ExtractedStyle): void {
  const field = (Array.isArray(renderer.fields) ? stringOf(renderer.fields[0]) : undefined) ?? stringOf(renderer.field);
  const classes = nodes(renderer.groups).flatMap((group) => nodes(group.classes)).concat(nodes(renderer.uniqueValues));
  for (const [index, item] of classes.entries()) {
    const name = stringOf(item.label) ?? stringOf(item.name) ?? `${layerName} ${index + 1}`;
    if (!extractElement(symbolFor(item), name, layerName, roleFor(index), extracted)) continue;
    const values = (Array.isArray(item.values) ? item.values.flat(Infinity) : []).map(String).filter(Boolean);
    if (values.length) extracted.bindings.push({ source: 'lyrx', layer: name, family: layerName, kind: 'field-ref', expression: field ? `${field} = ${values.join(', ')}` : values.join(', ') });
  }
}

function extractClassBreaks(renderer: CimNode, layerName: string, extracted: ExtractedStyle): void {
  const field = stringOf(renderer.field) ?? (Array.isArray(renderer.fields) ? stringOf(renderer.fields[0]) : undefined);
  for (const [index, item] of nodes(renderer.classBreaks).entries()) {
    const name = stringOf(item.label) ?? `${layerName} ${index + 1}`;
    if (!extractElement(symbolFor(item), name, layerName, roleFor(index), extracted)) continue;
    const bound = numberOf(item.upperBound) ?? numberOf(item.lowerBound);
    if (bound !== undefined) extracted.bindings.push({ source: 'lyrx', layer: name, family: layerName, kind: 'field-ref', expression: field ? `${field} <= ${bound}` : String(bound) });
  }
}

function extractElement(symbol: CimNode | undefined, name: string, family: string | undefined, roleHint: ExtractedElement['roleHint'] | undefined, extracted: ExtractedStyle, source: 'lyrx' | 'stylx' = 'lyrx'): ExtractedElement | undefined {
  const styleAndGeometry = symbol && cimSymbolToStyle(symbol);
  if (!styleAndGeometry) {
    extracted.skipped.push({ source, layer: name, reason: `Unsupported CIM symbol: ${stringOf(symbol?.type) ?? 'unknown'}` });
    return undefined;
  }
  const element: ExtractedElement = { name, geometry: styleAndGeometry.geometry, style: styleAndGeometry.style, scaleHints: [] };
  if (family) element.family = family;
  if (roleHint) element.roleHint = roleHint;
  extracted.elements.push(element);
  for (const reason of styleAndGeometry.skippedReasons) extracted.skipped.push({ source, layer: name, reason });
  collectFacts(element, extracted);
  return element;
}

function collectFacts(element: ExtractedElement, extracted: ExtractedStyle): void {
  for (const color of [element.style.color, element.style.fillColor, element.style.strokeColor, element.style.haloColor]) {
    if (color) extracted.colors.push({ value: color, nameHint: element.name, usedBy: [element.name] });
  }
  for (const width of [element.style.strokeWidth, element.style.haloWidth, element.style.outlineWidth, element.style.casingWidth]) {
    if (width) extracted.widths.push({ value: width, nameHint: element.name, usedBy: [element.name] });
  }
  if (element.style.size) extracted.sizes.push({ value: element.style.size, nameHint: element.name, usedBy: [element.name] });
  if (element.style.spacing) extracted.spacing.push({ value: element.style.spacing, nameHint: element.name, usedBy: [element.name] });
  if (element.style.offset?.value) extracted.unresolved.push({ topic: 'offset', detail: `${element.name}: confirm reference, axis and signed direction before completing the design prose` });
  if (element.style.dash) extracted.dashes.push({ pattern: element.style.dash, nameHint: element.name, usedBy: [element.name] });
}

function symbolFor(renderer: CimNode): CimNode | undefined {
  const reference = node(renderer.symbol);
  return node(reference?.symbol) ?? reference;
}

function roleFor(index: number): ExtractedElement['roleHint'] {
  return undefined; // Class order does not establish a design role.
}

function nodes(value: unknown): CimNode[] {
  return (Array.isArray(value) ? value : [value]).filter(isNode);
}

function node(value: unknown): CimNode | undefined {
  return isNode(value) ? value : undefined;
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
