import { describe, expect, it } from 'vitest';
import { consolidate, slugify } from '../src/consolidate.js';
import { emptyExtracted } from '../src/ir.js';

describe('slugify', () => {
  it('keeps TokenIdentifier charset and transliterates nothing', () => {
    expect(slugify('Roads (primary)')).toBe('roads-primary');
    expect(slugify('主干道')).toBe('');
    expect(slugify('a  b__c')).toBe('a-b__c');
  });
});

describe('consolidate', () => {
  it('preserves distinct name hints even when their slugs and values coincide', () => {
    const ir = emptyExtracted({ kind: 'style' });
    ir.colors.push(
      { value: '#3388ff', nameHint: 'Roads Primary', usedBy: ['l1'] },
      { value: '#3388ff', nameHint: 'roads-primary', usedBy: ['l2'] },
      { value: '#ffffff', usedBy: ['l3'] },
    );
    const c = consolidate(ir);
    expect(Object.values(c.tokens.colors)).toEqual(['#3388ff', '#3388ff', '#ffffff']);
    expect(c.tokens.colors['roads-primary']).toBe('#3388ff');
    expect(c.tokens.colors['l3']).toBe('#ffffff');
  });

  it('keeps distinct dimension values in separate width tokens', () => {
    const ir = emptyExtracted({ kind: 'style' });
    ir.widths.push(
      { value: { value: 12, unit: 'px' }, usedBy: ['a'] },
      { value: { value: 1.2, unit: 'px' }, usedBy: ['b'] },
    );

    expect(Object.values(consolidate(ir).tokens.widths)).toEqual([
      { value: 12, unit: 'px' },
      { value: 1.2, unit: 'px' },
    ]);
  });

  it('assigns roles within a family and replaces element values with token names', () => {
    const ir = emptyExtracted({ kind: 'style' });
    ir.colors.push({ value: '#3388ff', nameHint: 'accent', usedBy: ['a', 'b'] });
    ir.elements.push(
      { name: 'road-a', geometry: 'line', family: 'road', roleHint: 'primary', style: { strokeColor: '#3388ff', strokeWidth: { value: 2, unit: 'px' } }, scaleHints: [] },
      { name: 'road-b', geometry: 'line', family: 'road', roleHint: 'secondary', style: { strokeColor: '#3388ff', strokeWidth: { value: 2, unit: 'px' } }, scaleHints: [] },
    );
    ir.widths.push({ value: { value: 2, unit: 'px' }, nameHint: 'line', usedBy: ['a', 'b'] });
    const c = consolidate(ir);
    expect(c.elements[0]!.role).toBe('primary');
    expect(c.tokens.colors[c.elements[0]!.style.strokeColor as string]).toBe('#3388ff');
    expect(c.tokens.widths[c.elements[0]!.style.strokeWidth as string]).toEqual({value: 2, unit: 'px'});
    expect(c.elements[0]!.style.strokeWidth).not.toBe(c.elements[1]!.style.strokeWidth);
  });
});
