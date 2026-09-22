import { expect, it } from 'vitest';
import { getMapValidationCacheStats, validateMapSnapshot } from '../../../src/map-design/application/map-validation-cache.js';
import { DEFAULT_CARTOGRAPHIC_QUALITY_POLICY } from '../../../src/map-design/validation/cartographic-quality-validator.js';
import type { MapValidationInput } from '../../../src/map-design/validation/map-validator.js';
import { testDesignSystem } from '../../fixtures/map-design/test-design-system.js';

function input(): MapValidationInput {
  return {
    style: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#ffffff' } }] },
    semantics: { version: 1, groups: [] },
    sourceManifest: { kind: 'style', digest: 'a'.repeat(64), mediaType: 'application/json', byteLength: 1,
      resourceCount: 1, capturedAt: '2026-09-22T00:00:00.000Z' },
    designSystem: testDesignSystem(),
  };
}

it('reuses identical validation input without sharing mutable findings', () => {
  const snapshot = input();
  const before = getMapValidationCacheStats();
  const first = validateMapSnapshot('clone-isolation', snapshot);
  const original = structuredClone(first);
  first.findings.length = 0;
  first.summary.errors = 100;
  const second = validateMapSnapshot('clone-isolation', structuredClone(snapshot));
  expect(second).toEqual(original);
  expect(getMapValidationCacheStats()).toMatchObject({ hits: before.hits + 1, misses: before.misses + 1 });
});

it.each(['style', 'semantics', 'source', 'design-system', 'policy'] as const)(
  'invalidates cached validation when %s contents change', (part) => {
    const snapshot = input();
    validateMapSnapshot(`invalidate-${part}`, snapshot);
    switch (part) {
      case 'style': snapshot.style.name = 'Changed map'; break;
      case 'semantics': snapshot.semantics.groups.push({ id: 'roads', label: 'Roads', role: 'roads', layerIds: [], sourceIds: [] }); break;
      case 'source': snapshot.sourceManifest.resourceCount = 2; break;
      case 'design-system': snapshot.designSystem = testDesignSystem({ name: 'Changed design system' }); break;
      case 'policy': snapshot.runtimePolicy = { ...DEFAULT_CARTOGRAPHIC_QUALITY_POLICY, maxLabelLayerCount: 120 }; break;
      default: assertNever(part);
    }
    const before = getMapValidationCacheStats();
    validateMapSnapshot(`invalidate-${part}`, snapshot);
    expect(getMapValidationCacheStats()).toMatchObject({ hits: before.hits, misses: before.misses + 1 });
  },
);

it('bounds validation cache size and evicts least recently used results', () => {
  const snapshot = input();
  for (let index = 0; index < 70; index += 1) validateMapSnapshot(`bounded-${index}`, snapshot);
  const before = getMapValidationCacheStats();
  expect(before.entries).toBeLessThanOrEqual(64);
  expect(before.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  validateMapSnapshot('bounded-0', snapshot);
  expect(getMapValidationCacheStats()).toMatchObject({ misses: before.misses + 1 });
});

function assertNever(value: never): never {
  throw new TypeError(`Unexpected validation input part: ${String(value)}`);
}
