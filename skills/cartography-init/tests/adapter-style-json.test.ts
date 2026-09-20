import { describe, expect, it } from 'vitest';
import { parseStyleJson } from '../src/adapters/style-json.js';
import { loadFixtureText } from './helpers.js';

describe('parseStyleJson', () => {
  it('extracts literal paint tokens and element geometry', () => {
    const ir = parseStyleJson(loadFixtureText('style-min.json'), 'style-min.json');
    expect(ir.source.kind).toBe('style');
    expect(ir.colors.map((c) => c.value)).toContain('#3388ff');
    const line = ir.elements.find((e) => e.name === 'roads-primary');
    expect(line?.geometry).toBe('line');
    expect(line?.style.strokeColor).toBe('#3388ff');
    expect(line?.style.strokeWidth).toEqual({ value: 2, unit: 'px' });
    expect(line?.style.dash).toEqual([{ value: 8, unit: 'px' }, { value: 4, unit: 'px' }]);
  });

  it('routes filters and source-layer to bindings, never to elements', () => {
    const ir = parseStyleJson(loadFixtureText('style-boundary.json'), 'style-boundary.json');
    expect(ir.bindings.some((b) => b.kind === 'source-layer' && b.expression === 'transportation')).toBe(true);
    expect(ir.bindings.some((b) => b.kind === 'filter' && b.expression.includes('"class"'))).toBe(true);
    for (const e of ir.elements) {
      expect(JSON.stringify(e)).not.toContain('source-layer');
      expect(JSON.stringify(e)).not.toContain('highway');
    }
  });

  it('skips data-driven expressions and records scale hints from zoom stops', () => {
    const ir = parseStyleJson(loadFixtureText('style-boundary.json'), 'style-boundary.json');
    expect(ir.skipped.some((s) => s.reason.includes('数据驱动') || s.reason.includes('expression'))).toBe(true);
    expect(ir.scaleHints.length).toBeGreaterThan(0);
  });
});
