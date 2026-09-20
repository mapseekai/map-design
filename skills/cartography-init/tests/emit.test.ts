import { describe, expect, it } from 'vitest';
import { emitDocument } from '../src/emit.js';
import { consolidate } from '../src/consolidate.js';
import { emptyExtracted } from '../src/ir.js';

function sample() {
  const ir = emptyExtracted({ kind: 'style', name: 'Demo' });
  ir.colors.push({ value: '#3388ff', nameHint: 'accent', usedBy: ['road-a'] });
  ir.widths.push({ value: { value: 2, unit: 'px' }, nameHint: 'line', usedBy: ['road-a'] });
  ir.elements.push({
    name: 'road-a', geometry: 'line', family: 'road', roleHint: 'primary',
    style: {
      strokeColor: '#3388ff',
      strokeWidth: { value: 2, unit: 'px' },
      offset: { value: -2, unit: 'px' },
      dash: [{ value: 4, unit: 'px' }, { value: 2, unit: 'px' }],
      symbol: 'entry: #{}"\'',
    },
    scaleHints: [{ fact: 'zoom 5–15 可见' }],
  });
  ir.scaleHints.push({ fact: 'zoom 5–15 可见' });
  return { ir, c: consolidate(ir) };
}

describe('emitDocument', () => {
  it('emits version 0.4.0 front matter with token references', () => {
    const { ir, c } = sample();
    const doc = emitDocument(c, ir, { name: 'Demo Atlas', sourceFile: 'style-min.json' });
    expect(doc).toContain('version: "0.4.0"');
    expect(doc).toContain('name: "Demo Atlas"');
    expect(doc).toContain('road-a-strokecolor: "#3388ff"');
    expect(doc).toContain('strokeColor: "{colors.road-a-strokecolor}"');
    expect(doc).toContain('strokeWidth: "{widths.road-a-strokewidth}"');
    expect(doc).not.toContain('来源:style-min.json');
    expect(doc).toContain('"-2px"');
    expect(doc).toContain('["4px", "2px"]');
    expect(doc).toContain('symbol: "entry: #{}\\"\'"');
  });

  it('keeps all nine sections non-empty and marks unknowns as TODO(agent)', () => {
    const { ir, c } = sample();
    const doc = emitDocument(c, ir, { name: 'Demo Atlas', sourceFile: 'style-min.json' });
    for (const h of ['## Overview', '## Color', '## Typography & Labels', '## Composition & Density',
      '## Layering & Depth', '## Geometry & Symbols', '## Scale & Generalization',
      '## Map Elements', "## Do's and Don'ts"]) {
      expect(doc).toContain(h);
    }
    expect(doc).toContain('TODO(agent)');
    expect(doc).not.toContain('zoom 5–15 可见');
  });

  it('never leaks bindings into the document', () => {
    const { ir, c } = sample();
    ir.bindings.push({ source: 'style', layer: 'roads', kind: 'filter', expression: '"highway" = \'primary\'' });
    const doc = emitDocument(c, ir, { name: 'Demo Atlas', sourceFile: 'style-min.json' });
    expect(doc).not.toContain('highway');
    expect(doc).not.toContain('dataProfile');
  });
});
