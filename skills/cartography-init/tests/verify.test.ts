import { describe, expect, it } from 'vitest';
import { verifyDocument } from '../src/verify.js';
import { emitDocument } from '../src/emit.js';
import { consolidate } from '../src/consolidate.js';
import { emptyExtracted } from '../src/ir.js';

function validDoc(): string {
  const ir = emptyExtracted({ kind: 'style', name: 'Demo' });
  ir.colors.push({ value: '#3388ff', nameHint: 'accent', usedBy: ['road'] });
  ir.elements.push({
    name: 'road', geometry: 'line', family: 'road', roleHint: 'primary',
    style: { strokeColor: '#3388ff' }, scaleHints: [],
  });
  return emitDocument(consolidate(ir), ir, { name: 'Demo', sourceFile: 'style-min.json' });
}

describe('verifyDocument', () => {
  it('returns ok with empty errors for a lint-clean document', () => {
    const res = verifyDocument(validDoc());
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('maps error findings to "ruleId: message" strings when invalid', () => {
    const res = verifyDocument('---\nname: Missing Version\n---\n\n## Overview\nx\n');
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    for (const e of res.errors) expect(e).toContain(':');
  });
});
