import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emitDocument } from '../src/emit.js';
import { consolidate } from '../src/consolidate.js';
import { parseStyleJson } from '../src/adapters/style-json.js';
import { fixturesDir } from './helpers.js';

describe('boundary', () => {
  it('generated document contains no data bindings', () => {
    const ir = parseStyleJson(readFileSync(path.join(fixturesDir, 'style-boundary.json'), 'utf8'));
    const doc = emitDocument(consolidate(ir), ir, { name: 'Boundary', sourceFile: 'style-boundary.json' });
    for (const forbidden of ['source-layer', 'highway', 'filter', 'dataProfile']) {
      expect(doc).not.toContain(forbidden);
    }
  });

  it('package does not depend on renderer libraries', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const forbidden of ['maplibre-gl', 'mapbox-gl', 'leaflet', 'openlayers', 'arcgis-rest-js']) {
      expect(deps).not.toContain(forbidden);
    }
  });
});
