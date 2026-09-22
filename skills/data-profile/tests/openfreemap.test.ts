import {required} from './required.js';

import {readFile} from 'node:fs/promises';

import {describe, expect, it} from 'vitest';

import {generateProfile} from '../src/generate.js';
import {stableJson} from '../src/stable-json.js';

const styleInput = 'skills/data-profile/fixtures/openfreemap-bright/style.json';
const styleFile = new URL('../fixtures/openfreemap-bright/style.json', import.meta.url);
const observedAt = '2026-08-29T00:00:00Z';

describe('OpenFreeMap bright fixture', () => {
  it('generates the committed profile from only the local style fixture', async () => {
    const reads: string[] = [];
    let tileFetches = 0;

    const profile = await generateProfile(
      {stylePath: styleInput, observedAt},
      {
        readText: async (path) => {
          reads.push(path);
          if (path !== styleInput) {
            throw new Error(`Unexpected discovery input: ${path}`);
          }
          return readFile(styleFile, 'utf8');
        },
        fetchTile: async () => {
          tileFetches += 1;
          throw new Error('The fixture integration must not access live tiles.');
        },
        now: () => new Date(observedAt),
      },
    );

    expect(reads).toEqual([styleInput]);
    expect(tileFetches).toBe(0);
    expect(profile.generatedAt).toBe(observedAt);

    const source = required(profile.sources.openmaptiles);
    expect(source).toMatchObject({
      type: 'vector',
      tileTemplates: ['https://tiles.openfreemap.org/planet'],
    });
    expect(Object.keys(source.layers)).toEqual(
      expect.arrayContaining(['water', 'transportation', 'place']),
    );
    expect(Object.keys(required(source.layers.water).fields)).toEqual(
      expect.arrayContaining(['brunnel', 'intermittent']),
    );
    expect(Object.keys(required(source.layers.transportation).fields)).toEqual(
      expect.arrayContaining(['class', 'ramp']),
    );
    expect(Object.keys(required(source.layers.place).fields)).toEqual(
      expect.arrayContaining(['class', 'name', 'rank']),
    );

    const discoveredEvidence = Object.values(profile.sources).flatMap((candidateSource) => [
      ...candidateSource.evidence,
      ...Object.values(candidateSource.layers).flatMap((layer) => [
        ...layer.evidence,
        ...Object.values(layer.fields).flatMap((field) => field.evidence),
      ]),
    ]);
    expect(discoveredEvidence.length).toBeGreaterThan(0);
    expect(new Set(discoveredEvidence.map((evidence) => evidence.kind))).toEqual(
      new Set(['style-inferred']),
    );

    expect(profile.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'tile-contents-unobserved',
          location: '#/sources/openmaptiles',
          message: 'No actual tile contents were observed for this source.',
        }),
        expect.objectContaining({
          code: 'field-domain-unobserved',
          location: '#/sources/openmaptiles/layers/transportation/fields/class',
          message:
            'No sampled values were observed for this field, so its data domain remains unresolved.',
        }),
      ]),
    );

    const expected = await readFile(
      new URL('../fixtures/openfreemap-bright/DATA_PROFILE.json', import.meta.url),
      'utf8',
    );
    expect(stableJson(profile)).toBe(expected.replace(/\r\n/g, '\n'));
  });
});
