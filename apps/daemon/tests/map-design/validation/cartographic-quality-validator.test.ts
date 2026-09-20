import {testDesignSystem} from '../../fixtures/map-design/test-design-system.js';
import {validateMapDesign} from '../../../src/map-design/validation/map-validator.js';
import { describe, expect, it } from 'vitest';
import type { SemanticDocument } from '@mapseekai/map-design-contracts';
import type { StyleDocument } from 'maplibre-style-tools/core';
import { DEFAULT_CARTOGRAPHIC_QUALITY_POLICY, validateCartographicQuality, type CartographicQualityPolicy } from '../../../src/map-design/validation/cartographic-quality-validator.js';

const style = {
  version: 8,
  sources: { city: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
  layers: [
    { id: 'land', type: 'fill', source: 'city', paint: { 'fill-color': '#ffffff' } },
    { id: 'label-a', type: 'symbol', source: 'city', layout: { 'text-field': 'A' }, paint: { 'text-color': '#eeeeee' } },
    { id: 'label-b', type: 'symbol', source: 'city', layout: { 'text-field': 'B' } },
  ],
} as StyleDocument;
const semantics: SemanticDocument = { version: 1, groups: [] };
const contrastPolicy: CartographicQualityPolicy = {
  version: 1, requiredSemanticRoles: [], maxLabelLayerCount: 10, minimumContrastRatio: 4.5,
};

describe('cartographic output quality policy (outside the document format)', () => {
  it('includes runtime policy in the validation digest even when no findings change', () => {
    const input = {
      style: {version: 8 as const, sources: {}, layers: []}, semantics,
      sourceManifest: {kind: 'style' as const, digest: 'a'.repeat(64), mediaType: 'application/json', byteLength: 1, resourceCount: 0, capturedAt: '2026-09-20T00:00:00.000Z'},
      designSystem: testDesignSystem(),
    };
    const before = validateMapDesign(input);
    const after = validateMapDesign({...input, runtimePolicy: {...DEFAULT_CARTOGRAPHIC_QUALITY_POLICY, maxLabelLayerCount: 120}});
    expect(before.findings).toEqual(after.findings);
    expect(before.validationDigest).not.toBe(after.validationDigest);
  });

  it('supports explicit task policies without inferring required datasets from visual components', () => {
    expect(DEFAULT_CARTOGRAPHIC_QUALITY_POLICY.requiredSemanticRoles).toEqual([]);
    const findings = validateCartographicQuality({ style, semantics, policy: {
      ...contrastPolicy, requiredSemanticRoles: ['park'], maxLabelLayerCount: 1,
    } });
    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.code === 'CARTOGRAPHIC_QUALITY_WARNING' && finding.scope.kind === 'runtime')).toBe(true);
  });

  // Catches treating the first literal fill as the map background while ignoring the
  // MapLibre background/background-color surface that actually covers the canvas.
  it('uses a standard background layer as the cartographic contrast surface before fills', () => {
    const surfaceStyle = {
      version: 8,
      sources: style.sources,
      layers: [
        { id: 'canvas', type: 'background', paint: { 'background-color': '#ffffff' } },
        { id: 'land', type: 'fill', source: 'city', paint: { 'fill-color': '#111111' } },
        { id: 'label', type: 'symbol', source: 'city', layout: { 'text-field': 'A' }, paint: { 'text-color': '#eeeeee' } },
      ],
    } as StyleDocument;

    const findings = validateCartographicQuality({ style: surfaceStyle, semantics, policy: contrastPolicy });

    expect(findings).toEqual([expect.objectContaining({
      code: 'CARTOGRAPHIC_QUALITY_WARNING',
      jsonPointer: '/runtimePolicy/minimumContrastRatio',
      message: expect.stringContaining('below 4.5'),
    })]);
  });

  // Catches non-deterministic/first-match selection when multiple full-canvas surfaces exist.
  it('deterministically uses the last background layer in Style order', () => {
    const surfaceStyle = {
      version: 8,
      sources: style.sources,
      layers: [
        { id: 'canvas-dark', type: 'background', paint: { 'background-color': '#000000' } },
        { id: 'canvas-light', type: 'background', paint: { 'background-color': '#ffffff' } },
        { id: 'label', type: 'symbol', source: 'city', layout: { 'text-field': 'A' }, paint: { 'text-color': '#eeeeee' } },
      ],
    } as StyleDocument;

    const first = validateCartographicQuality({ style: surfaceStyle, semantics, policy: contrastPolicy });
    const second = validateCartographicQuality({ style: surfaceStyle, semantics, policy: contrastPolicy });

    expect(second).toEqual(first);
    expect(first).toHaveLength(1);
    expect(first[0]?.message).toContain('below 4.5');
  });

  // Catches accepting rgba syntactically but discarding alpha instead of compositing the
  // rendered text color over the selected opaque rgb surface.
  it('parses rgb/rgba literals and composites text alpha before contrast calculation', () => {
    const surfaceStyle = {
      version: 8,
      sources: style.sources,
      layers: [
        { id: 'canvas', type: 'background', paint: { 'background-color': 'rgb(255, 255, 255)' } },
        { id: 'label', type: 'symbol', source: 'city', layout: { 'text-field': 'A' }, paint: { 'text-color': 'rgba(0, 0, 0, 0.5)' } },
      ],
    } as StyleDocument;

    const findings = validateCartographicQuality({ style: surfaceStyle, semantics, policy: contrastPolicy });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('below 4.5');
  });

  // Catches silently skipping a valid MapLibre expression whose runtime color cannot be
  // resolved deterministically at canonical validation time.
  it('reports an unverifiable finding for an expression-based cartographic surface', () => {
    const surfaceStyle = {
      version: 8,
      sources: style.sources,
      layers: [
        {
          id: 'canvas',
          type: 'background',
          paint: { 'background-color': ['interpolate', ['linear'], ['zoom'], 0, '#ffffff', 10, '#000000'] },
        },
        { id: 'label', type: 'symbol', source: 'city', layout: { 'text-field': 'A' }, paint: { 'text-color': '#111111' } },
      ],
    } as StyleDocument;

    const findings = validateCartographicQuality({ style: surfaceStyle, semantics, policy: contrastPolicy });

    expect(findings).toEqual([expect.objectContaining({
      code: 'CARTOGRAPHIC_QUALITY_WARNING',
      jsonPointer: '/runtimePolicy/minimumContrastRatio',
      message: expect.stringContaining('could not be verified'),
    })]);
  });

  // Catches treating the absence of any determinable background/fill surface as a clean map.
  it('reports an unverifiable finding when no cartographic surface exists', () => {
    const surfaceStyle = {
      version: 8,
      sources: style.sources,
      layers: [
        { id: 'label', type: 'symbol', source: 'city', layout: { 'text-field': 'A' }, paint: { 'text-color': '#111111' } },
      ],
    } as StyleDocument;

    const findings = validateCartographicQuality({ style: surfaceStyle, semantics, policy: contrastPolicy });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'CARTOGRAPHIC_QUALITY_WARNING',
      jsonPointer: '/runtimePolicy/minimumContrastRatio',
    });
    expect(findings[0]?.message).toContain('could not be verified');
  });
});
