import {describe, expect, it} from 'vitest';
import {lint, parseCartography, resolveReferences} from '@mapseekai/cartography.md';
import {emptyExtracted, type ExtractedType} from '../src/ir.js';
import {consolidate} from '../src/consolidate.js';
import {emitDocument} from '../src/emit.js';
import {renderReportJson, renderReportMarkdown} from '../src/report.js';
import {parseStyleJson} from '../src/adapters/style-json.js';
import {parseQgis} from '../src/adapters/qgis.js';
import {parseLyrx} from '../src/adapters/arcgis.js';
import {loadFixture} from './helpers.js';

const options = {name: 'Contract', sourceFile: '/private/source.json'};

describe('0.4.0 initializer regressions', () => {
  it('groups dimensions, preserves signed offsets, and does not infer singleton role/state', () => {
    const ir = emptyExtracted({kind: 'style'});
    ir.elements.push({name: 'singleton-selected', geometry: 'point', family: 'valve', scaleHints: [], style: {
      strokeWidth: {value: 4, unit: 'px'}, casingWidth: {value: 1, unit: 'px'},
      size: {value: 12, unit: 'px'}, spacing: {value: 3, unit: 'px'}, offset: {value: -2, unit: 'px'},
    }});
    const c = consolidate(ir);
    expect(c.elements[0]?.role).toBeUndefined();
    expect(c.elements[0]?.state).toBeUndefined();
    expect(Object.values(c.tokens.widths)).toEqual([{value: 4, unit: 'px'}, {value: 1, unit: 'px'}]);
    expect(Object.values(c.tokens.sizes)).toEqual([{value: 12, unit: 'px'}]);
    expect(Object.values(c.tokens.spacing)).toEqual([{value: 3, unit: 'px'}]);
    const source = emitDocument(c, ir, options);
    expect(source).toContain('offset: "-2px"');
    expect(source).toContain('size: "{sizes.');
    expect(source).toContain('spacing: "{spacing.');
    expect(lint(source).valid).toBe(true);
  });

  it.each([
    {letterSpacing: {value: 0.05, unit: 'em'}}, {lineHeight: 1.5},
    {fontStyle: 'italic'}, {textTransform: 'uppercase'}, {fontFeature: 'smcp'},
    {fontVariation: 'wght 550'}, {extension: {enabled: true, alternatives: [{value: 'yes'}], empty: {}, nullable: null}},
    {extension: {kind: 'dimension', value: 'not-a-dimension', '1': '.inf'}},
  ])('does not merge or discard typography variation %j', variation => {
    const ir = emptyExtracted({kind: 'style'});
    const baseline: ExtractedType = {fontFamily: ['Sans'], fontSize: {value: 12, unit: 'px'}, letterSpacing: {value: 0, unit: 'em'}, usedBy: []};
    ir.typography.push({...baseline, nameHint: 'label'}, {...baseline, ...variation, nameHint: 'label'} as ExtractedType);
    const c = consolidate(ir);
    expect(Object.keys(c.tokens.typography)).toHaveLength(2);
    const source = emitDocument(c, ir, options);
    expect(lint(source).valid).toBe(true);
    const config = parseCartography(source).config!;
    const expected = Object.fromEntries(Object.entries(variation).map(([key, value]) => [key,
      value && typeof value === 'object' && 'unit' in value ? `${value.value}${value.unit}` : value]));
    expect(Object.values(config.typography!)[1]).toMatchObject(expected);
  });

  it('preserves equal-valued semantic tokens and reports sharing candidates', () => {
    const ir = emptyExtracted({kind: 'style'});
    ir.elements.push(...['road-secondary', 'waterway'].map(name => ({name, geometry: 'line' as const, style: {strokeWidth: {value: 1.25, unit: 'px' as const}}, scaleHints: []})));
    const c = consolidate(ir);
    expect(Object.keys(c.tokens.widths)).toHaveLength(2);
    expect(c.elements[0]?.style.strokeWidth).not.toBe(c.elements[1]?.style.strokeWidth);
    expect(c.notes.some(note => note.includes('Shared-value candidate'))).toBe(true);
  });

  it('keeps colliding and non-ASCII element names from implicitly sharing tokens', () => {
    const ir = emptyExtracted({kind: 'style'});
    ir.elements.push(...['水系', '道路', 'Road A', 'road-a', 'road-a'].map(name => ({name, geometry: 'line' as const, style: {strokeWidth: {value: 2, unit: 'px' as const}}, scaleHints: []})));
    const c = consolidate(ir);
    expect(Object.keys(c.tokens.widths)).toHaveLength(5);
    expect(new Set(c.elements.map(e => e.style.strokeWidth)).size).toBe(5);
    expect(lint(emitDocument(c, ir, options)).valid).toBe(true);
  });

  it('keeps process evidence in both reports rather than the nine design chapters', () => {
    const ir = emptyExtracted({kind: 'style', name: options.sourceFile});
    ir.scaleHints.push({fact: 'zoom 5–15 visible'});
    ir.skipped.push({source: 'style', reason: 'unsupported expression'});
    const c = consolidate(ir);
    const source = emitDocument(c, ir, options);
    for (const text of [options.sourceFile, 'zoom 5', '已识别', '已提取', '来源:', 'unsupported expression', 'Data & Legend']) expect(source).not.toContain(text);
    expect(parseCartography(source).sections).toHaveLength(9);
    for (const report of [renderReportJson(ir, c), renderReportMarkdown(ir, c)]) {
      expect(report).toContain(options.sourceFile);
      expect(report).toContain('zoom 5–15 visible');
      expect(report).toContain('unsupported expression');
      expect(report).toContain('statistics');
    }
    expect(lint(source).valid).toBe(true);
  });

  it('converts imported MapLibre radius to body diameter and preserves typography spacing', () => {
    const ir = parseStyleJson(JSON.stringify({layers: [
      {id: 'circle', type: 'circle', paint: {'circle-radius': 6, 'circle-stroke-width': 2}},
      {id: 'label', type: 'symbol', layout: {'text-font': ['Sans'], 'text-size': 12, 'text-letter-spacing': 0.05, 'text-line-height': 1.3}},
    ]}));
    const source = emitDocument(consolidate(ir), ir, options);
    expect(lint(source).valid).toBe(true);
    const resolved = resolveReferences(parseCartography(source).rawFrontmatter) as any;
    expect(resolved.elements.circle.size).toBe('12px');
    expect(resolved.elements.circle.outlineWidth).toBe('2px');
    expect(resolved.elements.label.typography.letterSpacing).toBe('0.05em');
    expect(resolved.elements.label.typography.lineHeight).toBe(1.3);
    expect(ir.widths.every(f => f.value.value !== 12)).toBe(true);
  });

  it('does not infer roles from QGIS or ArcGIS class ordering', () => {
    const qgis = parseQgis(loadFixture('qgis-rulebased.qgs'), 'rules.qgs');
    expect(qgis.elements.every(e => e.roleHint === undefined)).toBe(true);
    const arcgis = parseLyrx(Buffer.from(JSON.stringify({layerDefinitions: [{name: 'classes', renderer: {
      type: 'CIMUniqueValueRenderer', groups: [{classes: ['a', 'b'].map(label => ({label,
        symbol: {symbol: {type: 'CIMLineSymbol', symbolLayers: [{type: 'CIMSolidStroke', width: 2}]}}}))}],
    }}]})), 'classes.lyrx');
    expect(arcgis.elements).toHaveLength(2);
    expect(arcgis.elements.every(e => e.roleHint === undefined)).toBe(true);
  });
});
