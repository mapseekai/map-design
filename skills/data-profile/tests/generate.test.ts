import {required} from './required.js';

import {spawn} from 'node:child_process';
import {access, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {create} from '@mapbox/mvt-fixtures';
import {afterEach, describe, expect, it} from 'vitest';

import {generateProfile} from '../src/generate.js';
import {mergeFragments} from '../src/merge.js';
import {stableJson} from '../src/stable-json.js';
import type {ProfileFragment} from '../src/types.js';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryDirectory = resolve(packageDirectory, '../..');
const temporaryDirectories: string[] = [];

function fieldFragment(
  kind: 'tilejson-declared' | 'tile-sampled',
  type: 'number' | 'string',
  input: string,
  observedAt?: string,
): ProfileFragment {
  const evidence = {
    kind,
    input,
    location: '#/fields/score',
    ...(observedAt === undefined ? {} : {observedAt}),
  } as const;
  return {
    inputs: [input],
    sources: {
      ecology: {
        type: 'vector',
        tileTemplates: ['https://tiles.example/{z}/{x}/{y}.pbf'],
        layers: {
          habitat: {
            geometries: kind === 'tile-sampled' ? ['point'] : ['unknown'],
            stableIdObserved: kind === 'tile-sampled',
            fields: {
              score: {
                types: [type],
                categories: type === 'number' ? [2, 9] : ['high'],
                ...(type === 'number' ? {minimum: 2, maximum: 9} : {}),
                missingObserved: false,
                nullObserved: false,
                evidence: [evidence],
              },
            },
            evidence: [evidence],
          },
        },
        evidence: [evidence],
      },
    },
    unresolved: [],
  };
}

function pointTile(score: string | number, kind: string): Uint8Array {
  const scoreValue =
    typeof score === 'string' ? {string_value: score} : {int_value: score};
  return create({
    layers: [
      {
        version: 2,
        name: 'habitat',
        keys: ['score', 'kind'],
        values: [scoreValue, {string_value: kind}],
        extent: 4096,
        features: [{id: 1, tags: [0, 0, 1, 1], type: 1, geometry: [9, 50, 34]}],
      },
    ],
  }).buffer;
}

function sensitivePointTile(): Uint8Array {
  const matrixFields = ['api_key', 'apiKeys', 'APIToken', 'credentials', 'tokens', 'cookies', 'passwords', 'secrets', 'sessions'];
  const matrixValues = matrixFields.map((field, index) => `profile-private-${index}-${field}-value`);
  return create({
    layers: [
      {
        version: 2,
        name: 'accounts',
        keys: [...matrixFields, 'note', 'score'],
        values: [
          ...matrixValues.map((value) => ({string_value: value})),
          {string_value: 'Basic dXNlcjpwYXNzd29yZA=='},
          {int_value: 7},
        ],
        extent: 4096,
        features: [{
          tags: [...matrixFields.flatMap((_, index) => [index, index]), matrixFields.length, matrixFields.length, matrixFields.length + 1, matrixFields.length + 1],
          type: 1,
          geometry: [9, 50, 34],
        }],
      },
    ],
  }).buffer;
}

function manyCategoryTile(): Uint8Array {
  const values = Array.from({length: 257}, (_, index) => ({int_value: index + 1}));
  return create({
    layers: [
      {
        version: 2,
        name: 'many-values',
        keys: ['value'],
        values,
        extent: 4096,
        features: values.map((_, index) => ({
          tags: [0, index],
          type: 1,
          geometry: [9, 50, 34],
        })),
      },
    ],
  }).buffer;
}

function runCli(args: string[], cwd: string): Promise<{code: number | null; stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.resolve('tsx/cli')), join(packageDirectory, 'scripts/generate-profile.ts'), ...args],
      {cwd, env: {...process.env, INIT_CWD: cwd}, stdio: ['ignore', 'pipe', 'pipe']},
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({code, stdout, stderr}));
  });
}

function runPnpmCli(
  args: string[],
  cwd: string,
): Promise<{code: number | null; stdout: string; stderr: string}> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(process.execPath, [required(process.env.npm_execpath), ...args], {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolveProcess({code, stdout, stderr}));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, {recursive: true, force: true})),
  );
});

describe('mergeFragments', () => {
  it('retains incompatible declaration and observation evidence as an unresolved field conflict', () => {
    const observedAt = '2026-08-29T00:00:00.000Z';
    const declared = fieldFragment('tilejson-declared', 'number', 'metadata.json');
    const sampled = fieldFragment(
      'tile-sampled',
      'string',
      'https://tiles.example/{z}/{x}/{y}.pbf',
      observedAt,
    );

    const merged = mergeFragments([sampled, declared, declared]);
    const field = required(required(required(merged.sources.ecology).layers.habitat).fields.score);

    expect(field.types).toEqual(['number', 'string']);
    expect(field.categories).toEqual([2, 9, 'high']);
    expect(field).toMatchObject({minimum: 2, maximum: 9});
    expect(field.evidence).toEqual([
      {
        kind: 'tile-sampled',
        input: 'https://tiles.example/{z}/{x}/{y}.pbf',
        location: '#/fields/score',
        observedAt,
      },
      {kind: 'tilejson-declared', input: 'metadata.json', location: '#/fields/score'},
    ]);
    expect(merged.unresolved).toEqual([
      expect.objectContaining({
        code: 'field-type-conflict',
        location: '#/sources/ecology/layers/habitat/fields/score',
        evidence: field.evidence,
      }),
    ]);
  });

  it('expands independent source, layer, field, and bounds ranges without selecting a center', () => {
    const first = fieldFragment('tilejson-declared', 'number', 'first.json');
    const second = fieldFragment('tile-sampled', 'number', 'second.pbf', '2026-08-29T00:00:00Z');
    Object.assign(required(first.sources.ecology), {
      bounds: [-10, -5, 10, 5],
      center: [0, 0, 4],
      minzoom: 5,
      maxzoom: 8,
    });
    Object.assign(required(second.sources.ecology), {
      bounds: [-20, -4, 5, 9],
      center: [1, 1, 4],
      minzoom: 3,
      maxzoom: 12,
    });
    Object.assign(required(required(first.sources.ecology).layers.habitat), {minzoom: 6, maxzoom: 9});
    Object.assign(required(required(second.sources.ecology).layers.habitat), {minzoom: 4, maxzoom: 14});
    Object.assign(required(required(required(first.sources.ecology).layers.habitat).fields.score), {minimum: -2, maximum: 8});
    Object.assign(required(required(required(second.sources.ecology).layers.habitat).fields.score), {minimum: 1, maximum: 20});

    const merged = mergeFragments([first, second]);
    const source = merged.sources.ecology;

    expect(source).toMatchObject({
      bounds: [-20, -5, 10, 9],
      minzoom: 3,
      maxzoom: 12,
      layers: {
        habitat: {
          minzoom: 4,
          maxzoom: 14,
          fields: {score: {minimum: -2, maximum: 20}},
        },
      },
    });
    expect(source).not.toHaveProperty('center');
    expect(merged.unresolved).toContainEqual(
      expect.objectContaining({
        code: 'source-center-conflict',
        location: '#/sources/ecology/center',
      }),
    );
  });

  it('deduplicates identical unresolved items while preserving distinct evidence', () => {
    const first = fieldFragment('tilejson-declared', 'number', 'first.json');
    const second = fieldFragment('tile-sampled', 'number', 'second.pbf', '2026-08-29T00:00:00Z');
    const unresolved = {
      code: 'same-gap',
      location: '#/sources/ecology',
      message: 'The same unresolved fact.',
    };
    first.unresolved = [{...unresolved, evidence: required(first.sources.ecology).evidence}];
    second.unresolved = [
      {...unresolved, evidence: required(second.sources.ecology).evidence},
      {...unresolved, evidence: required(second.sources.ecology).evidence},
    ];

    const merged = mergeFragments([first, second]);

    expect(merged.unresolved).toEqual([
      {
        ...unresolved,
        evidence: [
          {
            kind: 'tile-sampled',
            input: 'second.pbf',
            location: '#/fields/score',
            observedAt: '2026-08-29T00:00:00Z',
          },
          {kind: 'tilejson-declared', input: 'first.json', location: '#/fields/score'},
        ],
      },
    ]);
  });

  it('enforces one deterministic 256-category cap across independently capped fragments', () => {
    const first = fieldFragment(
      'tile-sampled',
      'number',
      'a.pbf',
      '2026-08-29T00:00:00.000Z',
    );
    const second = fieldFragment(
      'tile-sampled',
      'number',
      'b.pbf',
      '2026-08-29T00:00:01.000Z',
    );
    required(required(required(first.sources.ecology).layers.habitat).fields.score).categories = Array.from(
      {length: 256},
      (_, index) => index + 1,
    );
    required(required(required(second.sources.ecology).layers.habitat).fields.score).categories = Array.from(
      {length: 256},
      (_, index) => index + 257,
    );

    const merged = mergeFragments([second, first]);
    const reversed = mergeFragments([first, second]);
    const field = required(required(required(merged.sources.ecology).layers.habitat).fields.score);
    const truncation = merged.unresolved.find((item) => item.code === 'categories-truncated');

    expect(field.categories).toHaveLength(256);
    expect(new Set(field.categories).size).toBe(256);
    expect(stableJson(merged)).toBe(stableJson(reversed));
    expect(truncation).toMatchObject({
      location: '#/sources/ecology/layers/habitat/fields/score',
      evidence: [
        expect.objectContaining({input: 'a.pbf'}),
        expect.objectContaining({input: 'b.pbf'}),
      ],
    });
  });
});

describe('generateProfile', () => {
  it('orchestrates style, TileJSON, and two sampled tiles deterministically', async () => {
    const style = JSON.stringify({
      version: 8,
      sources: {
        ecology: {type: 'vector', tiles: ['https://tiles.example/{z}/{x}/{y}.pbf']},
      },
      layers: [
        {
          id: 'habitat',
          type: 'circle',
          source: 'ecology',
          'source-layer': 'habitat',
          paint: {'circle-radius': ['get', 'score']},
        },
      ],
    });
    const tileJson = JSON.stringify({
      tilejson: '3.0.0',
      tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'],
      bounds: [0, 0, 0, 0],
      minzoom: 0,
      maxzoom: 1,
      vector_layers: [{id: 'habitat', fields: {score: 'Number', kind: 'String'}}],
    });
    const inputs: Record<string, string> = {'style.json': style, 'metadata.json': tileJson};
    const options = {
      stylePath: 'style.json',
      tileJsonPath: 'metadata.json',
      sourceId: 'ecology',
      tileTemplate: 'https://tiles.example/{z}/{x}/{y}.pbf',
      bounds: [0, 0, 0, 0] as [number, number, number, number],
      zooms: [0, 1],
      maxRequests: 2,
      observedAt: '2026-08-29T00:00:00.000Z',
    };
    const dependencies = {
      readText: async (path: string) => inputs[path]!,
      fetchTile: async ({z}: {z: number}) =>
        z === 0 ? pointTile('high', 'woodland') : pointTile(7, 'wetland'),
      now: () => new Date('2099-01-01T00:00:00.000Z'),
    };

    const first = await generateProfile(options, dependencies);
    const second = await generateProfile(options, dependencies);

    expect(first.generatedAt).toBe('2026-08-29T00:00:00.000Z');
    expect(required(first.sources.ecology).layers.habitat).toMatchObject({
      geometries: ['point', 'unknown'],
      stableIdObserved: true,
      fields: {
        score: {types: ['integer', 'number', 'string', 'unknown'], categories: [7, 'high']},
        kind: {types: ['string'], categories: ['wetland', 'woodland']},
      },
    });
    expect(first.sampling).toMatchObject({
      requested: 2,
      decoded: 2,
      empty: 0,
      failed: 0,
      coordinates: [
        {z: 0, x: 0, y: 0},
        {z: 1, x: 1, y: 1},
      ],
      stopReason: 'candidates-exhausted',
    });
    expect(Array.isArray(first.unresolved)).toBe(true);
    expect(first.unresolved.map((item) => item.code)).toContain('field-type-conflict');
    expect(
      required(required(required(first.sources.ecology).layers.habitat).fields.score).evidence
        .filter((item) => item.kind === 'tile-sampled')
        .every((item) => item.observedAt === options.observedAt),
    ).toBe(true);
    expect(stableJson(first)).toBe(stableJson(second));
  });

  it('requires at least one discovery input', async () => {
    await expect(
      generateProfile(
        {observedAt: '2026-08-29T00:00:00.000Z'},
        {readText: async () => '{}', now: () => new Date(0)},
      ),
    ).rejects.toThrow('at least one discovery input');
  });

  it('keeps a good sampled tile when the style cannot be parsed', async () => {
    const secretStyle = 'https://user:password@example.test/style.json?token=top-secret';
    const profile = await generateProfile(
      {
        stylePath: secretStyle,
        tileTemplate: './tiles/{z}/{x}/{y}.pbf',
        bounds: [0, 0, 0, 0],
        zooms: [0],
        maxRequests: 1,
        observedAt: '2026-08-29T00:00:00.000Z',
      },
      {
        readText: async () => '{not-json',
        fetchTile: async () => pointTile(5, 'woodland'),
        now: () => new Date(0),
      },
    );

    expect(required(required(required(profile.sources.default).layers.habitat).fields.score).categories).toEqual([5]);
    expect(profile.unresolved).toContainEqual(expect.objectContaining({
      code: 'style-parse-failed',
      evidence: [expect.objectContaining({
        kind: 'style-inferred',
        input: 'https://example.test/style.json',
      })],
    }));
    expect(stableJson(profile)).not.toMatch(/user|password|token|top-secret/);
  });

  it('keeps a good style when TileJSON cannot be parsed', async () => {
    const secretTileJson = 'https://user:password@example.test/metadata.json?token=top-secret';
    const profile = await generateProfile(
      {
        stylePath: 'style.json',
        tileJsonPath: secretTileJson,
        observedAt: '2026-08-29T00:00:00.000Z',
      },
      {
        readText: async (path) => path === 'style.json'
          ? JSON.stringify({version: 8, sources: {ecology: {type: 'vector'}}, layers: []})
          : '{not-json',
        now: () => new Date(0),
      },
    );

    expect(profile.sources).toHaveProperty('ecology');
    expect(profile.unresolved).toContainEqual(expect.objectContaining({
      code: 'tilejson-parse-failed',
      evidence: [expect.objectContaining({
        kind: 'tilejson-declared',
        input: 'https://example.test/metadata.json',
      })],
    }));
    expect(stableJson(profile)).not.toMatch(/user|password|token|top-secret/);
  });

  it('keeps valid TileJSON when another discovery input cannot be read', async () => {
    const secretStyle = 'https://user:password@example.test/style.json?token=top-secret';
    const profile = await generateProfile(
      {
        stylePath: secretStyle,
        tileJsonPath: 'metadata.json',
        sourceId: 'ecology',
        observedAt: '2026-08-29T00:00:00.000Z',
      },
      {
        readText: async (path) => {
          if (path === secretStyle) throw new Error(`ENOENT ${path}`);
          return JSON.stringify({
            tilejson: '3.0.0',
            vector_layers: [{id: 'habitat', fields: {name: 'String'}}],
          });
        },
        now: () => new Date(0),
      },
    );

    expect(required(required(required(profile.sources.ecology).layers.habitat).fields.name).types).toEqual(['string']);
    expect(profile.unresolved).toContainEqual(expect.objectContaining({
      code: 'style-read-failed',
      evidence: [expect.objectContaining({input: 'https://example.test/style.json'})],
    }));
    expect(stableJson(profile)).not.toMatch(/user|password|token|top-secret/);
  });

  it('rejects only when no supplied input yields usable evidence', async () => {
    await expect(generateProfile(
      {
        stylePath: 'style.json',
        tileJsonPath: 'metadata.json',
        observedAt: '2026-08-29T00:00:00.000Z',
      },
      {
        readText: async (path) => path === 'style.json' ? '{not-json' : 'null',
        now: () => new Date(0),
      },
    )).rejects.toThrow('No supplied input yielded usable profile evidence.');
  });

  it('does not invent default when TileJSON is ambiguous across multiple style sources', async () => {
    const profile = await generateProfile(
      {
        stylePath: 'style.json',
        tileJsonPath: 'metadata.json',
        observedAt: '2026-08-29T00:00:00.000Z',
      },
      {
        readText: async (path) => path === 'style.json'
          ? JSON.stringify({
              version: 8,
              sources: {roads: {type: 'vector'}, places: {type: 'vector'}},
              layers: [],
            })
          : JSON.stringify({
              tilejson: '3.0.0',
              vector_layers: [{id: 'habitat', fields: {name: 'String'}}],
            }),
        now: () => new Date(0),
      },
    );

    expect(Object.keys(profile.sources)).toEqual(['places', 'roads']);
    expect(profile.sources).not.toHaveProperty('default');
    expect(profile.unresolved).toContainEqual(expect.objectContaining({
      code: 'source-id-ambiguous',
      evidence: [expect.objectContaining({
        kind: 'tilejson-declared',
        input: 'metadata.json',
      })],
    }));
  });

  it('skips ambiguous sampling without issuing a tile request or creating default', async () => {
    let fetches = 0;
    const profile = await generateProfile(
      {
        stylePath: 'style.json',
        tileTemplate: './tiles/{z}/{x}/{y}.pbf',
        bounds: [0, 0, 0, 0],
        zooms: [0],
        maxRequests: 1,
        observedAt: '2026-08-29T00:00:00.000Z',
      },
      {
        readText: async () => JSON.stringify({
          version: 8,
          sources: {roads: {type: 'vector'}, places: {type: 'vector'}},
          layers: [],
        }),
        fetchTile: async () => {
          fetches += 1;
          return pointTile(1, 'woodland');
        },
        now: () => new Date(0),
      },
    );

    expect(fetches).toBe(0);
    expect(profile.sources).not.toHaveProperty('default');
    expect(profile.unresolved).toContainEqual(expect.objectContaining({
      code: 'source-id-ambiguous',
      evidence: [expect.objectContaining({kind: 'tile-sampled'})],
    }));
  });

  it('allows synthetic default only when no candidate source exists', async () => {
    const profile = await generateProfile(
      {
        tileJsonPath: 'metadata.json',
        observedAt: '2026-08-29T00:00:00.000Z',
      },
      {
        readText: async () => JSON.stringify({
          tilejson: '3.0.0',
          vector_layers: [{id: 'habitat', fields: {name: 'String'}}],
        }),
        now: () => new Date(0),
      },
    );

    expect(required(required(required(profile.sources.default).layers.habitat).fields.name).types).toEqual(['string']);
    expect(profile.unresolved.map((item) => item.code)).not.toContain('source-id-ambiguous');
  });

  it('redacts credentials from a remote style input before retaining evidence', async () => {
    const secretInput =
      'https://user:password@example.test/style.json?token=top-secret#private';

    const profile = await generateProfile(
      {stylePath: secretInput, observedAt: '2026-08-29T00:00:00.000Z'},
      {
        readText: async () =>
          JSON.stringify({version: 8, sources: {places: {type: 'vector'}}, layers: []}),
        now: () => new Date(0),
      },
    );
    const serialized = stableJson(profile);

    expect(profile.inputs).toEqual(['https://example.test/style.json']);
    expect(serialized).not.toMatch(/user|password|token|top-secret|private/);
  });

  it('does not report credential redaction for harmless URL normalization', async () => {
    const profile = await generateProfile(
      {stylePath: 'https://example.test', observedAt: '2026-08-29T00:00:00.000Z'},
      {
        readText: async () =>
          JSON.stringify({version: 8, sources: {places: {type: 'vector'}}, layers: []}),
        now: () => new Date(0),
      },
    );

    expect(profile.inputs).toEqual(['https://example.test/']);
    expect(profile.unresolved.map((item) => item.code)).not.toContain('credential-redacted');
  });

  it('does not expose a credential-bearing input through read failures', async () => {
    const secretInput =
      'https://user:password@example.test/style.json?token=top-secret#private';

    await expect(
      generateProfile(
        {stylePath: secretInput, observedAt: '2026-08-29T00:00:00.000Z'},
        {
          readText: async (path) => {
            throw new Error(`ENOENT ${path}`);
          },
          now: () => new Date(0),
        },
      ),
    ).rejects.not.toThrow(/user|password|token|top-secret|private/);
  });

  it('marks style-only field domains and tile contents as unobserved', async () => {
    const profile = await generateProfile(
      {stylePath: 'style.json', observedAt: '2026-08-29T00:00:00.000Z'},
      {
        readText: async () =>
          JSON.stringify({
            version: 8,
            sources: {places: {type: 'vector'}},
            layers: [
              {
                id: 'places',
                type: 'circle',
                source: 'places',
                'source-layer': 'places',
                paint: {'circle-radius': ['get', 'rank']},
              },
            ],
          }),
        now: () => new Date(0),
      },
    );

    expect(profile.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'field-domain-unobserved',
          location: '#/sources/places/layers/places/fields/rank',
        }),
        expect.objectContaining({
          code: 'tile-contents-unobserved',
          location: '#/sources/places',
        }),
      ]),
    );
    expect(profile.unresolved.every((item) => item.evidence.length > 0)).toBe(true);
  });

  it('records redaction without retaining secrets from an explicitly sampled template', async () => {
    const profile = await generateProfile(
      {
        tileTemplate:
          'https://user:password@tiles.example/{z}/{x}/{y}.pbf?token=top-secret#private',
        bounds: [0, 0, 0, 0],
        zooms: [0],
        maxRequests: 1,
        observedAt: '2026-08-29T00:00:00.000Z',
      },
      {
        readText: async () => '{}',
        fetchTile: async () => pointTile(1, 'woodland'),
        now: () => new Date(0),
      },
    );
    const serialized = stableJson(profile);

    expect(profile.inputs).toEqual(['https://tiles.example/{z}/{x}/{y}.pbf']);
    expect(profile.unresolved.map((item) => item.code)).toContain('credential-redacted');
    expect(serialized).not.toMatch(/user|password|token|top-secret|private/);
  });

  it('keeps sensitive sampled feature values out of serialized profiles and unresolved evidence', async () => {
    const profile = await generateProfile(
      {
        tileTemplate: './tiles/{z}/{x}/{y}.pbf',
        bounds: [0, 0, 0, 0],
        zooms: [0],
        maxRequests: 1,
        observedAt: '2026-08-29T00:00:00.000Z',
      },
      {
        readText: async () => '{}',
        fetchTile: async () => sensitivePointTile(),
        now: () => new Date(0),
      },
    );
    const serialized = stableJson(profile);

    expect(required(required(profile.sources.default).layers.accounts).fields.api_key).toMatchObject({
      types: ['string'],
      categories: [],
    });
    for (const field of ['apiKeys', 'APIToken', 'credentials', 'tokens', 'cookies', 'passwords', 'secrets', 'sessions']) {
      expect(required(required(profile.sources.default).layers.accounts).fields[field]).toMatchObject({
        types: ['string'],
        categories: [],
      });
    }
    expect(required(required(profile.sources.default).layers.accounts).fields.note).toMatchObject({
      types: ['string'],
      categories: [],
    });
    expect(required(required(profile.sources.default).layers.accounts).fields.score).toMatchObject({
      categories: [7],
      minimum: 7,
      maximum: 7,
    });
    expect(profile.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'sensitive-values-redacted',
          location: '#/sources/default/layers/accounts/fields/api_key',
        }),
        expect.objectContaining({
          code: 'sensitive-values-redacted',
          location: '#/sources/default/layers/accounts/fields/note',
        }),
      ]),
    );
    expect(serialized).not.toMatch(/profile-private-\d+-(?:api_key|apiKeys|APIToken|credentials|tokens|cookies|passwords|secrets|sessions)-value|dXNlcjpwYXNzd29yZA/);
  });

  it('propagates a single-tile category truncation into profile unresolved evidence', async () => {
    const profile = await generateProfile(
      {
        tileTemplate: './tiles/{z}/{x}/{y}.pbf',
        bounds: [0, 0, 0, 0],
        zooms: [0],
        maxRequests: 1,
        observedAt: '2026-08-29T00:00:00.000Z',
      },
      {
        readText: async () => '{}',
        fetchTile: async () => manyCategoryTile(),
        now: () => new Date(0),
      },
    );
    const field = required(required(required(profile.sources.default).layers['many-values']).fields.value);
    const truncation = profile.unresolved.find((item) => item.code === 'categories-truncated');

    expect(field.categories).toHaveLength(256);
    expect(truncation).toMatchObject({
      location: '#/sources/default/layers/many-values/fields/value',
      evidence: [
        expect.objectContaining({
          kind: 'tile-sampled',
          location: '#/tiles/0/0/0',
          observedAt: '2026-08-29T00:00:00.000Z',
        }),
      ],
    });
  });
});

describe('generate-profile CLI', () => {
  it('writes ambiguity evidence without a default source when --source-id is omitted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cartography-profile-cli-'));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, 'style.json'), JSON.stringify({
      version: 8,
      sources: {roads: {type: 'vector'}, places: {type: 'vector'}},
      layers: [],
    }));
    await writeFile(join(directory, 'metadata.json'), JSON.stringify({
      tilejson: '3.0.0',
      vector_layers: [{id: 'habitat', fields: {name: 'String'}}],
    }));

    const result = await runCli([
      '--style',
      'style.json',
      '--tilejson',
      'metadata.json',
      '--observed-at',
      '2026-08-29T00:00:00.000Z',
      '--output',
      'profile.json',
    ], directory);

    expect(result).toMatchObject({code: 0, stderr: ''});
    const profile = JSON.parse(await readFile(join(directory, 'profile.json'), 'utf8'));
    expect(profile.sources).not.toHaveProperty('default');
    expect(profile.unresolved).toContainEqual(expect.objectContaining({
      code: 'source-id-ambiguous',
    }));
  });

  it('executes the documented repo-root command and writes the default output in caller cwd', async () => {
    const callerOutput = join(repositoryDirectory, 'DATA_PROFILE.json');
    const packageOutput = join(packageDirectory, 'DATA_PROFILE.json');
    expect(await exists(callerOutput)).toBe(false);
    expect(await exists(packageOutput)).toBe(false);

    let result: Awaited<ReturnType<typeof runPnpmCli>>;
    let serialized: string | undefined;
    let packageOutputCreated = false;
    try {
      result = await runPnpmCli(
        [
          '--filter',
          '@cartographymd/data-profile-skill',
          'profile',
          '--',
          '--style',
          'skills/data-profile/fixtures/openfreemap-bright/style.json',
          '--observed-at',
          '2026-08-29T00:00:00Z',
        ],
        repositoryDirectory,
      );
      if (await exists(callerOutput)) serialized = await readFile(callerOutput, 'utf8');
      packageOutputCreated = await exists(packageOutput);
    } finally {
      await rm(callerOutput, {force: true});
      await rm(packageOutput, {force: true});
    }

    expect(result!).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(serialized!)).toMatchObject({
      format: 'cartography-data-profile/1',
      generatedAt: '2026-08-29T00:00:00Z',
    });
    expect(packageOutputCreated).toBe(false);
  });

  it('resolves every relative discovery and output path from the pnpm caller cwd', async () => {
    const directory = await mkdtemp(join(repositoryDirectory, '.data-profile-cwd-'));
    temporaryDirectories.push(directory);
    const relativeDirectory = `./${relative(repositoryDirectory, directory)}`;
    const tilesDirectory = join(directory, 'tiles/0/0');
    await mkdir(tilesDirectory, {recursive: true});
    await writeFile(
      join(directory, 'style.json'),
      JSON.stringify({
        version: 8,
        sources: {ecology: {type: 'vector'}},
        layers: [
          {
            id: 'habitat',
            type: 'circle',
            source: 'ecology',
            'source-layer': 'habitat',
            paint: {'circle-radius': ['get', 'name']},
          },
        ],
      }),
    );
    await writeFile(
      join(directory, 'metadata.json'),
      JSON.stringify({
        tilejson: '3.0.0',
        bounds: [0, 0, 0, 0],
        minzoom: 0,
        maxzoom: 0,
        vector_layers: [{id: 'habitat', fields: {name: 'String'}}],
      }),
    );
    await writeFile(join(tilesDirectory, '0.pbf'), pointTile(1, 'woodland'));
    const relativeOutput = `${relativeDirectory}/profile.json`;

    const result = await runPnpmCli(
      [
        '--filter',
        '@cartographymd/data-profile-skill',
        'profile',
        '--',
        '--style',
        `${relativeDirectory}/style.json`,
        '--tilejson',
        `${relativeDirectory}/metadata.json`,
        '--source-id',
        'ecology',
        '--tile-template',
        `${relativeDirectory}/tiles/{z}/{x}/{y}.pbf`,
        '--bbox=0,0,0,0',
        '--zooms=0',
        '--max-requests=1',
        '--observed-at',
        '2026-08-29T00:00:00Z',
        '--output',
        relativeOutput,
      ],
      repositoryDirectory,
    );

    expect(result).toMatchObject({code: 0, stderr: ''});
    const profile = JSON.parse(await readFile(join(directory, 'profile.json'), 'utf8'));
    expect(profile).toMatchObject({
      sources: {ecology: {layers: {habitat: {geometries: ['point', 'unknown']}}}},
      sampling: {requested: 1, decoded: 1, failed: 0},
    });
    expect(profile.inputs).toEqual(
      [
        `${relativeDirectory}/metadata.json`,
        `${relativeDirectory}/style.json`,
        `${relativeDirectory}/tiles/{z}/{x}/{y}.pbf`,
      ].sort(),
    );
    expect(await exists(join(packageDirectory, relativeOutput))).toBe(false);
  });

  it.each([
    ['bbox with an empty token', ['--bbox', '1,,2,3']],
    ['bbox with a whitespace token', ['--bbox', '1, ,2,3']],
    ['bbox with only three coordinates', ['--bbox', '1,2,3']],
    ['zooms with a trailing empty token', ['--zooms', '1,']],
    ['empty zooms', ['--zooms', '']],
    ['a non-finite zoom', ['--zooms', 'Infinity']],
    ['an empty max request count', ['--max-requests', '']],
    ['a whitespace max request count', ['--max-requests', '   ']],
    ['a NaN max request count', ['--max-requests', 'NaN']],
    ['an out-of-range longitude', ['--bbox', '-181,0,1,1']],
    ['an out-of-range latitude', ['--bbox', '0,-91,1,1']],
    ['zoom 25', ['--zooms', '25']],
    ['zero max requests', ['--max-requests', '0']],
  ])('exits 2 without output for %s', async (_caseName, invalidArgs) => {
    const directory = await mkdtemp(join(tmpdir(), 'cartography-profile-cli-'));
    temporaryDirectories.push(directory);

    const result = await runCli(
      [
        '--tile-template',
        './tiles/{z}/{x}/{y}.pbf',
        '--observed-at',
        '2026-08-29T00:00:00.000Z',
        ...invalidArgs,
        '--output',
        'profile.json',
      ],
      directory,
    );

    expect(result).toMatchObject({code: 2, stdout: ''});
    await expect(access(join(directory, 'profile.json'))).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it('writes the default DATA_PROFILE.json destination through the real entrypoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cartography-profile-cli-'));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, 'style.json'),
      JSON.stringify({version: 8, sources: {places: {type: 'vector'}}, layers: []}),
    );

    const result = await runCli(
      [
        '--',
        '--style',
        'style.json',
        '--allow-private-network',
        '--observed-at',
        '2026-08-29T00:00:00.000Z',
      ],
      directory,
    );

    expect(result).toMatchObject({code: 0, stderr: ''});
    const profile = JSON.parse(await readFile(join(directory, 'DATA_PROFILE.json'), 'utf8'));
    expect(profile).toMatchObject({
      format: 'cartography-data-profile/1',
      generatedAt: '2026-08-29T00:00:00.000Z',
    });
    expect(profile.unresolved.map((item: {code: string}) => item.code)).toContain(
      'tile-contents-unobserved',
    );
    expect(await readdir(directory)).toEqual(['DATA_PROFILE.json', 'style.json']);
  });

  it('rejects unknown flags and leaves no destination or sibling temporary file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cartography-profile-cli-'));
    temporaryDirectories.push(directory);

    const result = await runCli(
      [
        '--tile-template',
        'https://user:password@tiles.example/{z}/{x}/{y}.pbf?token=secret',
        '--allow-private-network',
        '--observed-at',
        '2026-08-29T00:00:00.000Z',
        '--unknown-flag',
        '--output',
        'profile.json',
      ],
      directory,
    );

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/password|token|secret/);
    await expect(access(join(directory, 'profile.json'))).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });
});
