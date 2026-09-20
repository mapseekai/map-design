import { describe, expect, it } from 'vitest';

import { MapValidateOutputSchema, type MapSourceManifest, type SemanticDocument } from '@mapseekai/map-design-contracts';
import type { StyleDocument } from 'maplibre-style-tools/core';

import { summarizeFindings } from '../../../src/map-design/validation/findings.js';
import type { LoadedMapDesignSystem } from '../../../src/map-design/validation/design-system-loader.js';
import { validateMapDesign } from '../../../src/map-design/validation/map-validator.js';
import { validateSemanticMapping } from '../../../src/map-design/validation/semantic-validator.js';

const style = {
  version: 8,
  sources: {
    city: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
  },
  layers: [
    { id: 'parks-fill', type: 'fill', source: 'city', paint: { 'fill-color': '#2d6a4f' } },
    { id: 'walking-path', type: 'line', source: 'city', paint: { 'line-color': '#457b9d' } },
    { id: 'labels', type: 'symbol', source: 'city', layout: { 'text-field': ['get', 'name'] } },
  ],
} as StyleDocument;

const sourceManifest: MapSourceManifest = {
  kind: 'geojson', digest: 'a'.repeat(64), mediaType: 'application/geo+json', byteLength: 2,
  resourceCount: 1, capturedAt: '2026-08-14T00:00:00.000Z',
};

const semantics: SemanticDocument = {
  version: 1,
  groups: [
    { id: 'parks', label: 'Parks', role: 'park', layerIds: ['parks-fill'], sourceIds: ['city'] },
    { id: 'walking', label: 'Walking paths', role: 'path', layerIds: ['walking-path'], sourceIds: ['city'] },
  ],
};

describe('MapDesign semantic validation', () => {
  it('accepts semantic references to existing style layer and source IDs', () => {
    expect(validateSemanticMapping(style, semantics, sourceManifest)).toEqual([]);
  });

  it('reports a missing semantic layer through an RFC6901 escaped pointer', () => {
    const result = validateSemanticMapping(style, {
      version: 1,
      groups: [{ id: 'bad', label: 'Bad', role: 'bad', layerIds: ['missing/~layer'], sourceIds: [] }],
    }, sourceManifest);

    expect(result).toContainEqual(expect.objectContaining({
      severity: 'error', code: 'SEMANTIC_INVALID', scope: { kind: 'root' },
      jsonPointer: '/groups/0/layerIds/0',
    }));
  });

  it('rejects duplicate semantic role and layer assignments across groups', () => {
    const result = validateSemanticMapping(style, {
      version: 1,
      groups: [
        { id: 'parks', label: 'Parks', role: 'park', layerIds: ['parks-fill'], sourceIds: ['city'] },
        { id: 'also-parks', label: 'Also parks', role: 'park', layerIds: ['parks-fill'], sourceIds: ['city'] },
      ],
    }, sourceManifest);

    expect(result.filter((finding) => finding.code === 'SEMANTIC_INVALID')).toHaveLength(2);
  });

  it('reports a semantic source that is absent from the style', () => {
    const result = validateSemanticMapping(style, {
      version: 1,
      groups: [{ id: 'parks', label: 'Parks', role: 'park', layerIds: ['parks-fill'], sourceIds: ['missing'] }],
    }, sourceManifest);

    expect(result).toContainEqual(expect.objectContaining({
      code: 'SEMANTIC_INVALID', jsonPointer: '/groups/0/sourceIds/0',
    }));
  });

  it('reports domain zoom and MapLibre base-style errors, then produces a stable digest', () => {
    const invalidStyle = {
      ...style,
      layers: [
        { ...style.layers[0], minzoom: 8, maxzoom: 8 },
        { id: 'orphan', type: 'fill', source: 'absent' },
      ],
    } as StyleDocument;
    const designSystem: LoadedMapDesignSystem = {
      id: 'quiet-walking', digest: 'b'.repeat(64), humanGuidance: 'Human guidance only.',
      rules: { version: 1, requiredSemanticRoles: [], maxLabelLayerCount: 3, minimumContrastRatio: 1 },
    };

    const first = validateMapDesign({ style: invalidStyle, semantics, sourceManifest, designSystem });
    const second = validateMapDesign({ style: invalidStyle, semantics, sourceManifest, designSystem });

    expect(first.findings).toContainEqual(expect.objectContaining({ code: 'STYLE_INVALID' }));
    expect(first.findings).toContainEqual(expect.objectContaining({ code: 'DOMAIN_INVALID', jsonPointer: '/layers/0' }));
    expect(first.validationDigest).toBe(second.validationDigest);
    expect(first.summary).toMatchObject({ status: 'invalid', errors: expect.any(Number) });
  });

  it('marks an executed clean validation as valid and digests every canonical input', () => {
    const designSystem: LoadedMapDesignSystem = {
      id: 'quiet-walking', digest: 'b'.repeat(64), humanGuidance: 'Human guidance only.',
      rules: { version: 1, requiredSemanticRoles: [], maxLabelLayerCount: 3, minimumContrastRatio: 1 },
    };
    const clean = validateMapDesign({ style, semantics, sourceManifest, designSystem });
    const styleChanged = validateMapDesign({
      style: { ...style, layers: [{ ...style.layers[0], paint: { 'fill-color': '#3d7a5f' } }, ...style.layers.slice(1)] } as StyleDocument,
      semantics, sourceManifest, designSystem,
    });
    const semanticsChanged = validateMapDesign({
      style, semantics: { ...semantics, groups: semantics.groups.map((group, index) => index === 0 ? { ...group, label: 'City parks' } : group) },
      sourceManifest, designSystem,
    });
    const manifestChanged = validateMapDesign({
      style, semantics, sourceManifest: { ...sourceManifest, mediaType: 'application/geo+json;profile=changed' }, designSystem,
    });

    expect(clean.summary.status).toBe('valid');
    expect(clean.validationDigest).toBe(validateMapDesign({ style, semantics, sourceManifest, designSystem }).validationDigest);
    expect(styleChanged.validationDigest).not.toBe(clean.validationDigest);
    expect(semanticsChanged.validationDigest).not.toBe(clean.validationDigest);
    expect(manifestChanged.validationDigest).not.toBe(clean.validationDigest);
  });

  it('sorts and caps findings while preserving all summary counts', () => {
    const findings = Array.from({ length: 501 }, (_, index) => ({
      severity: index === 0 ? 'error' as const : 'warning' as const,
      code: index === 0 ? 'Z' : 'A', message: `finding ${String(index).padStart(3, '0')}`,
      scope: { kind: 'root' as const }, jsonPointer: `/x/${index}`,
    }));

    const result = summarizeFindings(findings);

    expect(result.findings).toHaveLength(500);
    expect(result.findings[0]).toMatchObject({ severity: 'error', code: 'Z' });
    expect(result.summary).toEqual({
      status: 'invalid', errors: 1, warnings: 500, infos: 0, totalFindings: 501,
      returnedFindings: 500, omittedFindings: 1,
    });
  });

  it('uses the contract UTF-16 code-unit ordering rather than locale ordering', () => {
    const result = summarizeFindings([
      { severity: 'error', code: 'a', message: 'same message', scope: { kind: 'root' } },
      { severity: 'error', code: 'B', message: 'same message', scope: { kind: 'root' } },
    ]);
    const output = {
      draftRevision: 0,
      styleHash: 'a'.repeat(64),
      validationDigest: 'b'.repeat(64),
      summary: result.summary,
      findings: result.findings,
    };

    expect(result.findings.map((finding) => finding.code)).toEqual(['B', 'a']);
    expect(MapValidateOutputSchema.safeParse(output).success).toBe(true);
  });

  it('mirrors the contract NUL-delimited sort key when finding fields contain NUL', () => {
    const result = summarizeFindings([
      { severity: 'error', code: 'a', message: 'same message', scope: { kind: 'root' } },
      { severity: 'error', code: 'a\u0000A', message: 'same message', scope: { kind: 'root' } },
    ]);
    const output = {
      draftRevision: 0,
      styleHash: 'a'.repeat(64),
      validationDigest: 'b'.repeat(64),
      summary: result.summary,
      findings: result.findings,
    };

    expect(result.findings.map((finding) => finding.code)).toEqual(['a\u0000A', 'a']);
    expect(MapValidateOutputSchema.safeParse(output).success).toBe(true);
  });
});
