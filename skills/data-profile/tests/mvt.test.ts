import {required} from './required.js';

import {gzipSync} from 'node:zlib';

import {create, get} from '@mapbox/mvt-fixtures';
import {PbfWriter} from 'pbf';
import {describe, expect, it} from 'vitest';

import {decodeMvt, observeValue, TileDecodeError} from '../src/mvt.js';
import type {Evidence} from '../src/types.js';

const evidence: Evidence = {
  kind: 'tile-sampled',
  input: 'https://tiles.example/{z}/{x}/{y}.pbf',
  location: '#/tiles/0/0/0',
};

function point(geometry = [9, 50, 34]): number[] {
  return geometry;
}

function makeTile(layers: unknown[]): Uint8Array {
  return create({layers}).buffer;
}

function makeZeroIntegerTile(): Uint8Array {
  const pbf = new PbfWriter();
  pbf.writeMessage(
    3,
    (_, layer) => {
      layer.writeStringField(1, 'zeroes');
      layer.writeMessage(
        2,
        (_, feature) => {
          feature.writePackedVarint(2, [0, 0]);
          feature.writeVarintField(3, 1);
          feature.writePackedVarint(4, point());
        },
        undefined,
      );
      layer.writeStringField(3, 'score');
      layer.writeMessage(
        4,
        (_, value) => value.writeVarintField(4, 0),
        undefined,
      );
      layer.writeVarintField(5, 4096);
      layer.writeVarintField(15, 2);
    },
    undefined,
  );
  return pbf.finish();
}

function makeMetadataTile(options: {
  name?: string;
  version?: number;
  extent?: number;
}): Uint8Array {
  const pbf = new PbfWriter();
  pbf.writeMessage(
    3,
    (_, layer) => {
      if (options.name !== undefined) layer.writeStringField(1, options.name);
      if (options.extent !== undefined) layer.writeVarintField(5, options.extent);
      if (options.version !== undefined) layer.writeVarintField(15, options.version);
    },
    undefined,
  );
  return pbf.finish();
}

function unsignedVarint(value: bigint): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const low = Number(remaining & 0x7fn);
    remaining >>= 7n;
    bytes.push(remaining === 0n ? low : low | 0x80);
  } while (remaining !== 0n);
  return new Uint8Array(bytes);
}

function exactIntegerValue(field: 4 | 5 | 6, raw: bigint): Uint8Array {
  return new Uint8Array([field << 3, ...unsignedVarint(raw)]);
}

function stringValue(value: string): Uint8Array {
  const pbf = new PbfWriter();
  pbf.writeStringField(1, value);
  return pbf.finish();
}

function makeDuplicatePropertyTile(values: Uint8Array[], tags: number[]): Uint8Array {
  const pbf = new PbfWriter();
  pbf.writeMessage(
    3,
    (_, layer) => {
      layer.writeStringField(1, 'duplicate-values');
      layer.writeMessage(
        2,
        (_, feature) => {
          feature.writePackedVarint(2, tags);
          feature.writeVarintField(3, 1);
          feature.writePackedVarint(4, point());
        },
        undefined,
      );
      layer.writeStringField(3, 'value');
      for (const value of values) layer.writeBytesField(4, value);
      layer.writeVarintField(5, 4096);
      layer.writeVarintField(15, 2);
    },
    undefined,
  );
  return pbf.finish();
}

function makeExactIntegerTile(
  values: Array<{name: string; field: 4 | 5 | 6; raw: bigint}>,
): Uint8Array {
  const pbf = new PbfWriter();
  pbf.writeMessage(
    3,
    (_, layer) => {
      layer.writeStringField(1, 'exact-integers');
      layer.writeMessage(
        2,
        (_, feature) => {
          feature.writePackedVarint(2, values.flatMap((__, index) => [index, index]));
          feature.writeVarintField(3, 1);
          feature.writePackedVarint(4, point());
        },
        undefined,
      );
      for (const value of values) layer.writeStringField(3, value.name);
      for (const value of values) layer.writeBytesField(4, exactIntegerValue(value.field, value.raw));
      layer.writeVarintField(5, 4096);
      layer.writeVarintField(15, 2);
    },
    undefined,
  );
  return pbf.finish();
}

describe('decodeMvt', () => {
  it('observes point-layer field values, missing values, and stable IDs', () => {
    const buffer = makeTile([
      {
        version: 2,
        name: 'habitat',
        keys: ['name', 'score', 'protected'],
        values: [
          {string_value: 'woodland'},
          {int_value: 1},
          {bool_value: true},
          {string_value: 'wetland'},
          {int_value: 80},
          {bool_value: true},
        ],
        extent: 4096,
        features: [
          {id: 1, tags: [0, 0, 1, 1, 2, 2], type: 1, geometry: point()},
          {id: 2, tags: [0, 3, 1, 4, 2, 5], type: 1, geometry: point()},
          {id: 3, tags: [0, 0, 2, 2], type: 1, geometry: point()},
        ],
      },
    ]);

    const observation = decodeMvt(buffer, evidence);

    expect(required(observation.layers.habitat).geometries).toEqual(['point']);
    expect(required(observation.layers.habitat).featureCount).toBe(3);
    expect(required(observation.layers.habitat).fields.name).toMatchObject({
      types: ['string'],
      categories: ['woodland', 'wetland'],
      presentCount: 3,
      missingCount: 0,
      missingObserved: false,
      nullObserved: false,
    });
    expect(required(observation.layers.habitat).fields.score).toMatchObject({
      types: ['integer'],
      minimum: 1,
      maximum: 80,
      categories: [1, 80],
      presentCount: 2,
      missingCount: 1,
      missingObserved: true,
      nullObserved: false,
    });
    expect(required(observation.layers.habitat).fields.protected).toMatchObject({
      types: ['boolean'],
      categories: [true],
    });
    expect(required(observation.layers.habitat).stableIdObserved).toBe(true);
  });

  it('decodes gzip-compressed MVT bytes', () => {
    const buffer = makeTile([
      {
        version: 2,
        name: 'places',
        keys: ['name'],
        values: [{string_value: 'Harbor'}],
        extent: 4096,
        features: [{id: 4, tags: [0, 0], type: 1, geometry: point()}],
      },
    ]);

    expect(required(required(decodeMvt(gzipSync(buffer), evidence).layers.places).fields.name).categories).toEqual([
      'Harbor',
    ]);
  });

  it('bounds gzip decoded output with an explicit byte limit', () => {
    const compressed = gzipSync(new Uint8Array(2 * 1024));
    expect(compressed.byteLength).toBeLessThan(1024);

    try {
      decodeMvt(compressed, evidence, 1024);
      expect.unreachable('decoded output over the explicit limit must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TileDecodeError);
      expect((error as TileDecodeError).code).toBe('tile-decoded-too-large');
    }
  });

  it('uses a safe five-MiB default decoded byte limit', () => {
    const compressed = gzipSync(new Uint8Array(5 * 1024 * 1024 + 1));

    try {
      decodeMvt(compressed, evidence);
      expect.unreachable('decoded output over the default limit must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TileDecodeError);
      expect((error as TileDecodeError).code).toBe('tile-decoded-too-large');
    }
  });

  it('observes the valid integer value zero', () => {
    expect(required(decodeMvt(makeZeroIntegerTile(), evidence).layers.zeroes).fields.score).toMatchObject({
      types: ['integer'],
      categories: [0],
      minimum: 0,
      maximum: 0,
    });
  });

  it('accepts official valid MVT fixture 050 and the ZigZag int32 boundary', () => {
    const observation = decodeMvt(get('050').buffer, evidence);

    expect(observation.layers.hello).toMatchObject({
      geometries: ['line'],
      featureCount: 1,
    });
  });

  it('retains exact signed, unsigned, and ZigZag values at Number safe boundaries', () => {
    const safe = BigInt(Number.MAX_SAFE_INTEGER);
    const two64 = 1n << 64n;
    const observation = decodeMvt(
      makeExactIntegerTile([
        {name: 'int-max', field: 4, raw: safe},
        {name: 'int-min', field: 4, raw: two64 - safe},
        {name: 'uint-max', field: 5, raw: safe},
        {name: 'sint-max', field: 6, raw: safe * 2n},
        {name: 'sint-min', field: 6, raw: safe * 2n - 1n},
      ]),
      evidence,
    );
    const fields = required(observation.layers['exact-integers']).fields;

    expect(required(fields['int-max']).categories).toEqual([Number.MAX_SAFE_INTEGER]);
    expect(required(fields['int-min']).categories).toEqual([-Number.MAX_SAFE_INTEGER]);
    expect(required(fields['uint-max']).categories).toEqual([Number.MAX_SAFE_INTEGER]);
    expect(required(fields['sint-max']).categories).toEqual([Number.MAX_SAFE_INTEGER]);
    expect(required(fields['sint-min']).categories).toEqual([-Number.MAX_SAFE_INTEGER]);
  });

  it('clears an earlier exact-integer override when a duplicate key ends as a string', () => {
    const tile = makeDuplicatePropertyTile(
      [exactIntegerValue(4, 7n), stringValue('last')],
      [0, 0, 0, 1],
    );

    expect(required(decodeMvt(tile, evidence).layers['duplicate-values']).fields.value).toMatchObject({
      types: ['string'],
      categories: ['last'],
      presentCount: 1,
    });
  });

  it('uses a later safe exact integer when a duplicate key starts as a string', () => {
    const tile = makeDuplicatePropertyTile(
      [stringValue('first'), exactIntegerValue(4, 7n)],
      [0, 0, 0, 1],
    );

    expect(required(decodeMvt(tile, evidence).layers['duplicate-values']).fields.value).toMatchObject({
      types: ['integer'],
      categories: [7],
      minimum: 7,
      maximum: 7,
    });
  });

  it('rejects an unsafe duplicate integer even when a later tag would replace it', () => {
    const tile = makeDuplicatePropertyTile(
      [
        exactIntegerValue(5, BigInt(Number.MAX_SAFE_INTEGER) + 1n),
        stringValue('last'),
      ],
      [0, 0, 0, 1],
    );

    try {
      decodeMvt(tile, evidence);
      expect.unreachable('unsafe duplicate integers must not be hidden by a later tag');
    } catch (error) {
      expect(error).toBeInstanceOf(TileDecodeError);
      expect((error as TileDecodeError).code).toBe('tile-unsafe-64-bit-value');
    }
  });

  it.each([
    ['positive int64', 4 as const, BigInt(Number.MAX_SAFE_INTEGER) + 1n],
    ['negative int64', 4 as const, (1n << 64n) - BigInt(Number.MAX_SAFE_INTEGER) - 1n],
    ['uint64', 5 as const, BigInt(Number.MAX_SAFE_INTEGER) + 1n],
    ['positive sint64', 6 as const, (BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 2n],
    ['negative sint64', 6 as const, (BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 2n - 1n],
  ])('rejects exact %s beyond Number safe range without exposing a rounded fact', (_name, field, raw) => {
    try {
      decodeMvt(makeExactIntegerTile([{name: 'unsafe', field, raw}]), evidence);
      expect.unreachable('unsafe 64-bit values must not be decoded into rounded numbers');
    } catch (error) {
      expect(error).toBeInstanceOf(TileDecodeError);
      expect((error as TileDecodeError).code).toBe('tile-unsafe-64-bit-value');
      expect((error as TileDecodeError).evidence).toEqual(evidence);
      expect(String(error)).not.toContain(String(Number(raw)));
    }
  });

  it('deduplicates and orders line and polygon geometries within one layer', () => {
    const buffer = makeTile([
      {
        version: 2,
        name: 'mixed-geometry',
        keys: [],
        values: [],
        extent: 4096,
        features: [
          {type: 3, geometry: [9, 0, 0, 18, 2, 0, 0, 2, 15]},
          {type: 2, geometry: [9, 0, 0, 10, 2, 0]},
          {type: 2, geometry: [9, 2, 0, 10, 2, 0]},
        ],
      },
    ]);

    const layer = required(decodeMvt(buffer, evidence).layers['mixed-geometry']);
    expect(layer.featureCount).toBe(3);
    expect(layer.geometries).toEqual(['line', 'polygon']);
  });

  it('retains mixed MVT scalar types rather than coercing them', () => {
    const buffer = makeTile([
      {
        version: 2,
        name: 'mixed',
        keys: ['value'],
        values: [{string_value: '7'}, {int_value: 7}, {bool_value: true}],
        extent: 4096,
        features: [
          {tags: [0, 0], type: 1, geometry: point()},
          {tags: [0, 1], type: 1, geometry: point()},
          {tags: [0, 2], type: 1, geometry: point()},
        ],
      },
    ]);

    expect(required(decodeMvt(buffer, evidence).layers.mixed).fields.value).toMatchObject({
      types: ['string', 'integer', 'boolean'],
      categories: ['7', 7, true],
      presentCount: 3,
      missingCount: 0,
    });
  });

  it('redacts sensitive field values and obvious credential scalars before category capture', () => {
    const password = 'correct-horse-battery-staple';
    const authorization = 'Bearer header.payload.signature-secret';
    const sensitiveFields = [
      'credential',
      'accessToken',
      'cookie',
      'authorization',
      'password',
      'client_secret',
      'sessionId',
      'api-key',
    ];
    const buffer = makeTile([
      {
        version: 2,
        name: 'accounts',
        keys: [...sensitiveFields, 'description', 'score'],
        values: [
          ...sensitiveFields.map((field) => ({
            string_value: field === 'password' ? password : `${field}-private-value`,
          })),
          {string_value: authorization},
          {int_value: 42},
        ],
        extent: 4096,
        features: [
          {
            tags: [
              0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9,
            ],
            type: 1,
            geometry: point(),
          },
        ],
      },
    ]);

    const fields = required(decodeMvt(buffer, evidence).layers.accounts).fields;

    for (const field of sensitiveFields) {
      expect(fields[field]).toMatchObject({
        types: ['string'],
        categories: [],
        presentCount: 1,
        sensitiveValuesRedacted: true,
      });
    }
    expect(fields.description).toMatchObject({
      types: ['string'],
      categories: [],
      presentCount: 1,
      sensitiveValuesRedacted: true,
    });
    expect(fields.score).toMatchObject({
      categories: [42],
      minimum: 42,
      maximum: 42,
    });
    expect(JSON.stringify(fields)).not.toMatch(
      /correct-horse-battery-staple|header\.payload\.signature-secret/,
    );
  });

  it('redacts singular, plural, acronym, camel, snake, kebab, and dotted sensitive fields', () => {
    const sensitiveFields = [
      'credential',
      'credentials',
      'token',
      'tokens',
      'cookie',
      'cookies',
      'password',
      'passwords',
      'secret',
      'secrets',
      'session',
      'sessions',
      'apiKey',
      'apiKeys',
      'APIKey',
      'APIKeys',
      'APIToken',
      'apiTokens',
      'api_key',
      'api-keys',
      'api.token',
    ];
    const rawValues = sensitiveFields.map((field, index) => `private-${index}-${field}-value`);
    const buffer = makeTile([
      {
        version: 2,
        name: 'sensitive-matrix',
        keys: sensitiveFields,
        values: rawValues.map((value, index) =>
          sensitiveFields[index] === 'apiKeys' ? {int_value: 424_242} : {string_value: value}
        ),
        extent: 4096,
        features: [
          {
            tags: sensitiveFields.flatMap((_, index) => [index, index]),
            type: 1,
            geometry: point(),
          },
        ],
      },
    ]);

    const fields = required(decodeMvt(buffer, evidence).layers['sensitive-matrix']).fields;
    for (const fieldName of sensitiveFields) {
      expect(fields[fieldName]).toMatchObject({
        categories: [],
        sensitiveValuesRedacted: true,
      });
      expect(fields[fieldName]).not.toHaveProperty('minimum');
      expect(fields[fieldName]).not.toHaveProperty('maximum');
    }
    const serialized = JSON.stringify(fields);
    for (const rawValue of rawValues) expect(serialized).not.toContain(rawValue);
    expect(serialized).not.toContain('424242');
  });

  it('caps distinct scalar categories and reports that the observation was truncated', () => {
    const values = Array.from({length: 257}, (_, index) => ({int_value: index + 1}));
    const buffer = makeTile([
      {
        version: 2,
        name: 'many-values',
        keys: ['value'],
        values,
        extent: 4096,
        features: values.map((_, index) => ({
          tags: [0, index],
          type: 1,
          geometry: point(),
        })),
      },
    ]);

    const field = required(required(decodeMvt(buffer, evidence).layers['many-values']).fields.value);
    expect(field.categories).toHaveLength(256);
    expect(field.categories.at(-1)).toBe(256);
    expect(field.categoriesTruncated).toBe(true);
  });

  it('retains prototype-like MVT layer and property names as own facts', () => {
    const buffer = makeTile([
      {
        version: 2,
        name: '__proto__',
        keys: ['__proto__', 'constructor', 'toString'],
        values: [{string_value: 'first'}, {string_value: 'second'}, {string_value: 'third'}],
        extent: 4096,
        features: [{tags: [0, 0, 1, 1, 2, 2], type: 1, geometry: point()}],
      },
    ]);

    const observation = decodeMvt(buffer, evidence);
    const layer = required(observation.layers.__proto__);
    expect(Object.getPrototypeOf(observation.layers)).toBeNull();
    expect(Object.prototype.propertyIsEnumerable.call(observation.layers, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(layer.fields)).toBeNull();
    expect(Object.keys(layer.fields)).toEqual(['__proto__', 'constructor', 'toString']);
  });

  it('uses typed decode errors for damaged PBF bytes', () => {
    expect(() => decodeMvt(new Uint8Array([0xff]), evidence)).toThrow(TileDecodeError);
  });

  it('rejects a PBF message whose declared layer length is truncated', () => {
    expect(() => decodeMvt(new Uint8Array([0x1a, 0x03, 0x0a, 0x0a]), evidence)).toThrow(
      TileDecodeError,
    );
  });

  it('rejects a value string that crosses its own PBF message boundary', () => {
    const corruptValueTile = new Uint8Array([
      0x1a,
      0x0c,
      0x78,
      0x02,
      0x0a,
      0x01,
      0x76,
      0x22,
      0x02,
      0x0a,
      0x05,
      0x28,
      0x80,
      0x20,
    ]);

    expect(() => decodeMvt(corruptValueTile, evidence)).toThrow(TileDecodeError);
  });

  it.each([
    ['missing layer name', makeMetadataTile({version: 2, extent: 4096})],
    ['empty layer name', makeMetadataTile({name: '', version: 2, extent: 4096})],
    ['missing layer version', makeMetadataTile({name: 'places', extent: 4096})],
    ['unsupported layer version', makeMetadataTile({name: 'places', version: 3, extent: 4096})],
    ['zero layer extent', makeMetadataTile({name: 'places', version: 2, extent: 0})],
  ])('rejects semantic-invalid layer metadata: %s', (_caseName, buffer) => {
    expect(() => decodeMvt(buffer, evidence)).toThrow(TileDecodeError);
  });

  it.each([
    [
      'tags that reference empty key/value tables',
      {keys: [], values: [], tags: [0, 0], type: 1, geometry: point()},
    ],
    [
      'an odd tag index list',
      {keys: ['name'], values: [{string_value: 'harbor'}], tags: [0], type: 1, geometry: point()},
    ],
    [
      'an out-of-range key index',
      {keys: ['name'], values: [{string_value: 'harbor'}], tags: [1, 0], type: 1, geometry: point()},
    ],
    [
      'an out-of-range value index',
      {keys: ['name'], values: [{string_value: 'harbor'}], tags: [0, 1], type: 1, geometry: point()},
    ],
    [
      'an unknown feature type',
      {keys: [], values: [], tags: [], type: 0, geometry: point()},
    ],
    [
      'a truncated geometry parameter pair',
      {keys: [], values: [], tags: [], type: 1, geometry: [9, 0]},
    ],
    [
      'a zero-count geometry command',
      {keys: [], values: [], tags: [], type: 1, geometry: [1]},
    ],
    [
      'a point containing a LineTo command',
      {keys: [], values: [], tags: [], type: 1, geometry: [9, 0, 0, 10, 2, 0]},
    ],
    [
      'a line without a LineTo command',
      {keys: [], values: [], tags: [], type: 2, geometry: [9, 0, 0]},
    ],
    [
      'a zero-length LineTo parameter pair',
      {keys: [], values: [], tags: [], type: 2, geometry: [9, 0, 0, 10, 0, 0]},
    ],
    [
      'a polygon without ClosePath',
      {keys: [], values: [], tags: [], type: 3, geometry: [9, 0, 0, 18, 2, 0, 0, 2]},
    ],
    [
      'a geometry parameter outside uint32 bounds',
      {keys: [], values: [], tags: [], type: 1, geometry: [9, 2 ** 32, 0]},
    ],
  ])('rejects semantic-invalid feature data: %s', (_caseName, definition) => {
    const buffer = makeTile([
      {
        version: 2,
        name: 'invalid',
        keys: definition.keys,
        values: definition.values,
        extent: 4096,
        features: [
          {
            tags: definition.tags,
            type: definition.type,
            geometry: definition.geometry,
          },
        ],
      },
    ]);

    expect(() => decodeMvt(buffer, evidence)).toThrow(TileDecodeError);
  });

  it('uses typed decode errors for corrupt gzip bytes', () => {
    expect(() => decodeMvt(new Uint8Array([0x1f, 0x8b, 0x08]), evidence)).toThrow(TileDecodeError);
  });

  it('does not expose secret-like input bytes through typed decode errors', () => {
    const secret = 'Bearer do-not-leak-this-token';

    try {
      decodeMvt(new TextEncoder().encode(secret), evidence);
      expect.unreachable('invalid bytes must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TileDecodeError);
      expect(`${String(error)} ${String((error as TileDecodeError).cause)}`).not.toContain(secret);
    }
  });
});

describe('observeValue', () => {
  it('keeps explicit null distinct from an absent MVT property', () => {
    expect(observeValue(null)).toEqual({
      types: ['null'],
      categories: [null],
      presentCount: 1,
      missingCount: 0,
      missingObserved: false,
      nullObserved: true,
    });
  });

  it('does not treat object values as scalar categories', () => {
    expect(observeValue({status: 'not-a-mvt-scalar'})).toEqual({
      types: ['json'],
      categories: [],
      presentCount: 1,
      missingCount: 0,
      missingObserved: false,
      nullObserved: false,
    });
  });
});
