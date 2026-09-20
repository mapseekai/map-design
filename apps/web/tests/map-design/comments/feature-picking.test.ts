import { describe, expect, it } from 'vitest';

import {
  buildCommentTarget,
  deduplicateFeatureCandidates,
  featureScopeAvailable,
  normalizeAnchor,
  persistedProperties,
  queryBox,
  type PickedFeature,
} from '../../../src/map-design/comments/feature-picking';

function feature(overrides: Partial<PickedFeature> = {}): PickedFeature {
  return {
    id: 0,
    layer: { id: 'roads' },
    source: 'transport',
    sourceLayer: 'road',
    properties: { class: 'primary', lanes: 2, bridge: false, nullable: null },
    geometry: { type: 'LineString', coordinates: [[10, 20], [11, 21]] },
    ...overrides,
  };
}

describe('feature picking', () => {
  it('deduplicates wrapped tile copies while retaining separate style layers', () => {
    const candidates = deduplicateFeatureCandidates([
      feature(),
      feature({ geometry: { type: 'LineString', coordinates: [[-350, 20], [-349, 21]] } }),
      feature({ layer: { id: 'road-labels' } }),
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.feature.layer.id)).toEqual(['roads', 'road-labels']);
  });

  it('uses a deterministic geometry and property fallback only when ids are absent', () => {
    const first = feature({ id: undefined });
    const same = feature({ id: undefined, properties: { bridge: false, lanes: 2, class: 'primary', nullable: null } });
    const different = feature({ id: undefined, properties: { class: 'secondary' } });

    expect(deduplicateFeatureCandidates([first, same, different])).toHaveLength(2);
  });

  it('retains typed properties and accepts id zero in a persisted target', () => {
    const target = buildCommentTarget(feature(), [10.5, 20.5]);

    expect(target).toMatchObject({ featureId: 0, anchor: [10.5, 20.5], properties: {
      class: 'primary', lanes: 2, bridge: false, nullable: null,
    } });
  });

  it('disables feature scope for generated or missing identifiers', () => {
    expect(featureScopeAvailable(feature(), new Set())).toBe(true);
    expect(featureScopeAvailable(feature({ id: undefined }), new Set())).toBe(false);
    expect(featureScopeAvailable(feature(), new Set(['transport']))).toBe(false);
    expect(featureScopeAvailable(feature({ id: Number.MAX_SAFE_INTEGER + 1 }), new Set())).toBe(false);
    expect(featureScopeAvailable(feature({ id: '' }), new Set())).toBe(false);
  });

  it('rejects IDs coerced from inline GeoJSON strings but accepts unique numeric and promoted IDs', () => {
    const style = (ids: Array<string | number>, promoteId?: string) => ({ sources: { transport: {
      type: 'geojson', ...(promoteId ? { promoteId } : {}),
      data: { type: 'FeatureCollection', features: ids.map((id) => ({ type: 'Feature', id })) },
    } } });
    expect(featureScopeAvailable(feature(), new Set(), style(['qa-point']))).toBe(false);
    expect(featureScopeAvailable(feature(), new Set(), style([0, 'qa-point']))).toBe(false);
    expect(featureScopeAvailable(feature(), new Set(), style([0, 0]))).toBe(false);
    expect(featureScopeAvailable(feature(), new Set(), style([1]))).toBe(false);
    expect(featureScopeAvailable(feature(), new Set(), style([0, 1]))).toBe(true);
    expect(featureScopeAvailable(feature({ id: 'qa-point' }), new Set(), style(['qa-point'], 'name'))).toBe(true);
  });

  it('preserves special property names and normalizes wrapped click anchors', () => {
    const properties = persistedProperties(Object.fromEntries([['__proto__', 'kept'], ['', 'ignored']]));
    expect(Object.prototype.hasOwnProperty.call(properties, '__proto__')).toBe(true);
    expect(properties.__proto__).toBe('kept');
    expect(normalizeAnchor([370, 20])).toEqual([10, 20]);
  });

  it('keeps numeric and string identifiers distinct and ignores overlays without a source', () => {
    const candidates = deduplicateFeatureCandidates([
      feature({ id: 1 }), feature({ id: '1' }), feature({ source: '' }),
    ]);
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((item) => item.key)).size).toBe(2);
  });

  it('queries a small tolerance around a pointer', () => {
    expect(queryBox({ x: 20, y: 30 }, 4)).toEqual([[16, 26], [24, 34]]);
  });

  it('does not offer the temporary selection layer as a comment or style target', () => {
    expect(deduplicateFeatureCandidates([
      feature({ layer: { id: '__map-design-highlight:selection' } }),
      feature({ layer: { id: '__map-design-comments:points' } }), feature(),
    ]).map((candidate) => candidate.feature.layer.id)).toEqual(['roads']);
  });

});
