import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { SemanticDocument } from '@mapseekai/map-design-contracts';
import type { StyleDocument } from 'maplibre-style-tools/core';

import { loadMapDesignSystem } from '../../../src/map-design/validation/design-system-loader.js';
import type { LoadedMapDesignSystem } from '../../../src/map-design/validation/design-system-loader.js';
import { validateDesignSystemRules } from '../../../src/map-design/validation/design-system-validator.js';

const fixtureRoot = path.resolve(import.meta.dirname, '../../fixtures/map-design');
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
const contrastSystem: LoadedMapDesignSystem = {
  id: 'contrast-system',
  digest: 'd'.repeat(64),
  humanGuidance: '',
  rules: {
    version: 1,
    requiredSemanticRoles: [],
    maxLabelLayerCount: 10,
    minimumContrastRatio: 4.5,
  },
};
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeSystem(content: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'map-design-system-'));
  cleanup.push(root);
  const directory = path.join(root, 'design-systems', 'test-system');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'CARTOGRAPHY.md'), content, 'utf8');
  return root;
}

describe('MapDesign design-system loading and validation', () => {
  it('loads exactly one machine-readable rules block and hashes the complete file', async () => {
    const loaded = await loadMapDesignSystem({ projectRoot: fixtureRoot, designSystemId: 'quiet-walking' });
    const alteredRoot = await makeSystem(`${loaded.humanGuidance}\n\nExtra prose.\n\n\`\`\`mapdesign-rules\n${JSON.stringify(loaded.rules)}\n\`\`\`\n`);
    const altered = await loadMapDesignSystem({ projectRoot: alteredRoot, designSystemId: 'test-system' });

    expect(loaded.humanGuidance).toContain('Human guidance');
    expect(loaded.rules).toEqual({ version: 1, requiredSemanticRoles: ['park'], maxLabelLayerCount: 1, minimumContrastRatio: 4.5 });
    expect(altered.digest).not.toBe(loaded.digest);
  });

  it('rejects unsafe IDs, traversal, and symlink escapes without exposing local paths', async () => {
    for (const designSystemId of ['', '.', '..', '../quiet-walking', 'a/b', 'a\\b', '/absolute', 'bad\u0000id']) {
      await expect(loadMapDesignSystem({ projectRoot: fixtureRoot, designSystemId })).rejects.toThrow(/invalid design system id/);
    }
    const root = await makeSystem('placeholder');
    const systems = path.join(root, 'design-systems');
    await rm(path.join(systems, 'test-system', 'CARTOGRAPHY.md'));
    await symlink('/tmp', path.join(systems, 'test-system', 'CARTOGRAPHY.md'));
    await expect(loadMapDesignSystem({ projectRoot: root, designSystemId: 'test-system' })).rejects.toThrow(/design system file is outside configured root/);
  });

  it.each([
    ['missing block', 'Human prose only.'],
    ['duplicate block', '```mapdesign-rules\n{"version":1,"requiredSemanticRoles":[],"maxLabelLayerCount":1,"minimumContrastRatio":1}\n```\n```mapdesign-rules\n{"version":1,"requiredSemanticRoles":[],"maxLabelLayerCount":1,"minimumContrastRatio":1}\n```'],
    ['invalid JSON', '```mapdesign-rules\n{not json}\n```'],
    ['unknown key', '```mapdesign-rules\n{"version":1,"requiredSemanticRoles":[],"maxLabelLayerCount":1,"minimumContrastRatio":1,"unknown":true}\n```'],
    ['duplicate JSON key', '```mapdesign-rules\n{"version":1,"version":1,"requiredSemanticRoles":[],"maxLabelLayerCount":1,"minimumContrastRatio":1}\n```'],
  ])('rejects %s', async (_name, content) => {
    const root = await makeSystem(content);
    await expect(loadMapDesignSystem({ projectRoot: root, designSystemId: 'test-system' })).rejects.toThrow(/invalid map design rules|expected exactly one mapdesign-rules block/);
  });

  it('executes only the machine-readable semantic, density, and contrast rules', async () => {
    const designSystem = await loadMapDesignSystem({ projectRoot: fixtureRoot, designSystemId: 'quiet-walking' });
    const findings = validateDesignSystemRules({ style, semantics, designSystem });

    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.code === 'DESIGN_SYSTEM_VIOLATION')).toBe(true);
    expect(findings.every((finding) => finding.scope.kind === 'design-system'
      && finding.scope.id === 'quiet-walking')).toBe(true);
  });

  it('does not execute human guidance text', async () => {
    const root = await makeSystem('Human-only rule: every road must be purple.\n\n```mapdesign-rules\n{"version":1,"requiredSemanticRoles":[],"maxLabelLayerCount":5,"minimumContrastRatio":1}\n```\n');
    const designSystem = await loadMapDesignSystem({ projectRoot: root, designSystemId: 'test-system' });
    expect(validateDesignSystemRules({ style, semantics, designSystem })).toEqual([]);
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

    const findings = validateDesignSystemRules({ style: surfaceStyle, semantics, designSystem: contrastSystem });

    expect(findings).toEqual([expect.objectContaining({
      code: 'DESIGN_SYSTEM_VIOLATION',
      jsonPointer: '/rules/minimumContrastRatio',
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

    const first = validateDesignSystemRules({ style: surfaceStyle, semantics, designSystem: contrastSystem });
    const second = validateDesignSystemRules({ style: surfaceStyle, semantics, designSystem: contrastSystem });

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

    const findings = validateDesignSystemRules({ style: surfaceStyle, semantics, designSystem: contrastSystem });

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

    const findings = validateDesignSystemRules({ style: surfaceStyle, semantics, designSystem: contrastSystem });

    expect(findings).toEqual([expect.objectContaining({
      code: 'DESIGN_SYSTEM_VIOLATION',
      jsonPointer: '/rules/minimumContrastRatio',
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

    const findings = validateDesignSystemRules({ style: surfaceStyle, semantics, designSystem: contrastSystem });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'DESIGN_SYSTEM_VIOLATION',
      jsonPointer: '/rules/minimumContrastRatio',
    });
    expect(findings[0]?.message).toContain('could not be verified');
  });
});
