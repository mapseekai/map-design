import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { parseQgis } from '../src/adapters/qgis.js';
import { loadFixture } from './helpers.js';

describe('parseQgis', () => {
  it('extracts single symbols with unit and color conversion', () => {
    const ir = parseQgis(loadFixture('qgis-min.qgs'), 'qgis-min.qgs');
    expect(ir.source.kind).toBe('qgis');
    const road = ir.elements.find((e) => e.name === 'roads');
    expect(road?.geometry).toBe('line');
    expect(road?.style.strokeColor).toBe('#dd8844');
    expect(road?.style.strokeWidth).toEqual({ value: 0.26, unit: 'mm' });
    expect(ir.datasources.some((d) => d.identity.includes('ogr'))).toBe(true);
  });

  it('skips QGIS units outside the allowed mapping table', () => {
    const cmProject = loadFixture('qgis-min.qgs').toString('utf8').replace('v="MM"', 'v="CM"');
    const ir = parseQgis(Buffer.from(cmProject), 'qgis-cm.qgs');
    expect(ir.elements[0]?.style.strokeWidth).toBeUndefined();
    expect(ir.skipped).toContainEqual(expect.objectContaining({ layer: 'roads', reason: expect.stringContaining('CM') }));
  });

  it('unpacks QGZ archives identified by their ZIP signature', () => {
    const ir = parseQgis(Buffer.from(zipSync({ 'project.qgs': loadFixture('qgis-min.qgs') })), 'project.qgz');
    expect(ir.elements).toHaveLength(1);
    expect(ir.elements[0]?.name).toBe('roads');
  });

  it('keeps rule symbols as one family and routes filter expressions to bindings', () => {
    const ir = parseQgis(loadFixture('qgis-rulebased.qgs'), 'qgis-rulebased.qgs');
    const fam = ir.elements.filter((e) => e.family === 'roads');
    expect(fam.length).toBe(2);
    expect(ir.bindings.some((b) => b.kind === 'filter' && b.expression.includes('highway'))).toBe(true);
    expect(ir.bindings.some((b) => b.kind === 'field-override')).toBe(true);
    for (const e of ir.elements) expect(JSON.stringify(e)).not.toContain('"highway"');
  });
});
