import { describe, expect, it } from 'vitest';
import { parseSld } from '../src/adapters/sld.js';
import { loadFixtureText } from './helpers.js';

describe('parseSld', () => {
  it('extracts line/polygon symbolizers from SLD 1.0', () => {
    const ir = parseSld(loadFixtureText('sld-min.xml'), 'sld-min.xml');
    expect(ir.source.kind).toBe('sld');
    const road = ir.elements.find((e) => e.name === 'PrimaryRoad');
    expect(road?.geometry).toBe('line');
    expect(road?.style.strokeColor).toBe('#FF6600');
    expect(road?.style.strokeWidth).toEqual({ value: 2, unit: 'px' });
  });

  it('routes ogc:Filter to bindings and scaleDenominator to scale hints', () => {
    const ir = parseSld(loadFixtureText('sld-boundary.xml'), 'sld-boundary.xml');
    expect(ir.bindings.some((b) => b.kind === 'filter' && b.expression.includes('highway'))).toBe(true);
    expect(ir.scaleHints.some((h) => h.fact.includes('50000'))).toBe(true);
    for (const e of ir.elements) expect(JSON.stringify(e)).not.toContain('highway');
  });
});
