import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLyrx, parseStylx } from '../src/adapters/arcgis.js';
import { cimSymbolToStyle } from '../src/adapters/cim.js';
import { loadFixture, makeStylx } from './helpers.js';

describe('parseLyrx', () => {
  it('extracts CIM solid stroke/fill with pt units and hex colors', () => {
    const ir = parseLyrx(loadFixture('arcgis-min.lyrx'), 'arcgis-min.lyrx');
    expect(ir.source.kind).toBe('lyrx');
    const roads = ir.elements.find((e) => e.name === 'roads');
    expect(roads?.geometry).toBe('line');
    expect(roads?.style.strokeColor).toBe('#3388ff');
    expect(roads?.style.strokeWidth).toEqual({ value: 1.5, unit: 'pt' });
    const water = ir.elements.find((e) => e.name === 'water');
    expect(water?.geometry).toBe('polygon');
    expect(water?.style.fillColor).toBe('#d8ecff');
  });

  it('skips unsupported CIM effects with reasons', () => {
    const ir = parseLyrx(loadFixture('arcgis-min.lyrx'), 'arcgis-min.lyrx');
    for (const skipped of ir.skipped) expect(skipped.reason.length).toBeGreaterThan(0);
  });

  it('binds CIM unique-value group values to their renderer field', () => {
    const ir = parseLyrx(Buffer.from(JSON.stringify({
      layerDefinitions: [{
        name: 'land use',
        renderer: {
          type: 'CIMUniqueValueRenderer',
          fields: ['kind'],
          groups: [{ classes: [{
            label: 'park',
            values: [['park']],
            symbol: { symbol: { type: 'CIMPolygonSymbol', symbolLayers: [] } },
          }] }],
        },
      }],
    })), 'unique.lyrx');

    expect(ir.bindings).toContainEqual({
      source: 'lyrx', layer: 'park', family: 'land use', kind: 'field-ref', expression: 'kind = park',
    });
  });

  it('records unsupported CIM symbols as skipped', () => {
    const ir = parseLyrx(Buffer.from(JSON.stringify({
      layerDefinitions: [{
        name: 'mesh',
        renderer: { type: 'CIMSimpleRenderer', symbol: { symbol: { type: 'CIMMeshSymbol', symbolLayers: [] } } },
      }],
    })), 'unsupported.lyrx');

    expect(ir.skipped).toContainEqual({
      source: 'lyrx', layer: 'mesh', reason: 'Unsupported CIM symbol: CIMMeshSymbol',
    });
  });

  it('records an unrepresentable CIM yoffset as skipped', () => {
    const result = cimSymbolToStyle({
      type: 'CIMPointSymbol',
      symbolLayers: [{ type: 'CIMCharacterMarker', character: 'A', size: 8, xoffset: 2, yoffset: 3 }],
    });

    expect(result?.skippedReasons).toContain('CIM yoffset not migrated: IR offset only supports one axis');
  });
});


function makeEmptyStylx(): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), 'stylx-'));
  const file = path.join(dir, 'empty.stylx');
  const db = new Database(file);
  db.close();
  return readFileSync(file);
}

describe('parseStylx', () => {
  it('extracts named symbols from a stylx sqlite file', () => {
    const ir = parseStylx(makeStylx(), 'test.stylx');

    expect(ir.source.kind).toBe('stylx');
    const element = ir.elements.find((candidate) => candidate.name === 'major-road');
    expect(element?.style.strokeColor).toBe('#3388ff');
    expect(element?.style.strokeWidth).toEqual({ value: 1.5, unit: 'pt' });
  });

  it('skips malformed and unsupported category items', () => {
    const ir = parseStylx(makeStylx([
      { category: 'Symbols', name: 'broken', content: '{' },
      { category: 'Other', name: 'ignored', content: '{}' },
    ]), 'test.stylx');

    expect(ir.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'stylx', layer: 'broken' }),
      expect.objectContaining({ source: 'stylx', layer: 'ignored' }),
    ]));
  });

  it('rejects a database without an ITEMS table', () => {
    expect(() => parseStylx(makeEmptyStylx(), 'empty.stylx')).toThrow('ITEMS table');
  });
});
