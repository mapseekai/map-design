import {canonicalJson} from '../../../src/map-design/storage/canonical-json.js';
import { describe, expect, it } from 'vitest';
import { cartographyPreview } from '../../../src/map-design/application/cartography-preview.js';

describe('declared cartography tokens', () => {
  it('resolves color and typography tokens without inferring map roles', () => {
    const preview = cartographyPreview(`---
version: "0.4.0"
name: Test
colors:
  blue: "#123456"
  water: "{colors.blue}"
typography:
  display:
    fontFamily: [Georgia, serif]
    fontSize: 24px
    fontWeight: 600
  body:
    fontFamily: Arial
    fontSize: 12px
---
`);
    expect(preview.palette).toEqual([{ name: 'blue', color: '#123456' }, { name: 'water', color: '#123456' }]);
    expect(preview.typography).toEqual([
      { name: 'display', fontFamily: '"Georgia", serif', fontSize: '24px', fontWeight: 600 },
      { name: 'body', fontFamily: '"Arial"', fontSize: '12px' },
    ]);
    expect(preview).not.toHaveProperty('background');
  });
  it('does not invent tokens for prose-only specifications', () => {
    expect(cartographyPreview('A warm blue map #123456')).toEqual({ palette: [], typography: [] });
    expect(cartographyPreview('---\nversion: "0.4.0"\nname: Test\n---\n')).toEqual({ palette: [], typography: [], elements: [] });
  });
  it('retains more than eight palette entries and excludes resource URLs', () => {
    const colors = Array.from({ length: 12 }, (_, i) => `  color-${i}: "#123456"`).join('\n');
    const preview = cartographyPreview(`---\nversion: "0.4.0"\nname: Test\ncolors:\n${colors}\n  unsafe: "url(https://example.com/a.svg)"\n---\n`);
    expect(preview.palette).toHaveLength(12);
    expect(preview.palette.at(-1)?.name).toBe('color-11');
  });
  it('includes inline element fonts without duplicating referenced typography', () => {
    const preview = cartographyPreview(`---
version: "0.4.0"
name: Test
typography:
  label:
    fontFamily: Georgia
    fontSize: 12px
elements:
  primary-label:
    geometry: label
    typography: "{typography.label}"
  inline-label:
    geometry: label
    typography:
      fontFamily: Arial
      fontSize: 10px
---
`);
    expect(preview.typography?.map((token) => token.name)).toEqual(['label', 'elements.inline-label']);
  });
});

it('normalizes safe map properties and excludes non-default states', () => {
  const result = cartographyPreview(`---
version: "0.4.0"
name: Test
colors:
  road: "#123456"
elements:
  primary-road:
    geometry: line
    family: road
    role: primary
    strokeColor: "{colors.road}"
    strokeWidth: 3pt
    dash: [6px, 3px]
  selected-road:
    geometry: line
    state: selected
    color: "#ff0000"
  marker:
    geometry: point
    symbol: square
    size: 10px
---
`);
  expect(result.elements).toHaveLength(2);
  expect(result.elements?.[0]).toMatchObject({ strokeWidth: 4, strokeColor: '#123456', dash: [6, 3] });
  expect(result.elements?.[1]?.unsupported).toContain('symbol');
});


it('produces canonical JSON for standard elements with omitted family/role and preserves explicit zero', () => {
  const source = '---\nversion: "0.4.0"\nname: Minimal\nelements:\n  hidden-point:\n    geometry: point\n    color: "#123456"\n    size: 0px\n    opacity: 0\n---\n\n## Overview\n\nMinimal reusable visual identity.\n';
  const preview = cartographyPreview(source);
  expect(() => canonicalJson(preview)).not.toThrow();
  expect(JSON.parse(canonicalJson(preview))).toEqual(preview);
  expect(preview.elements?.[0]).toMatchObject({name: 'hidden-point', size: 0, opacity: 0});
  expect(Object.hasOwn(preview.elements?.[0] ?? {}, 'family')).toBe(false);
  expect(Object.hasOwn(preview.elements?.[0] ?? {}, 'role')).toBe(false);
});
