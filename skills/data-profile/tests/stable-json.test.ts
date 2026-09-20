import {describe, expect, it} from 'vitest';

import {stableJson} from '../src/stable-json.js';

describe('stableJson', () => {
  it('sorts object keys and observed categories deterministically', () => {
    const profile = {
      sources: {z: {layers: {}}, a: {layers: {}}},
      categories: ['z', 2, 'a', null],
    };

    expect(stableJson(profile)).toBe(
      '{\n  "categories": [\n    null,\n    2,\n    "a",\n    "z"\n  ],\n  "sources": {\n    "a": {\n      "layers": {}\n    },\n    "z": {\n      "layers": {}\n    }\n  }\n}\n',
    );
  });

  it('preserves evidence and unresolved array order', () => {
    const profile = {
      unresolved: [{location: 'second'}, {location: 'first'}],
      evidence: [{location: 'second'}, {location: 'first'}],
      categories: ['z', 'a'],
    };

    expect(JSON.parse(stableJson(profile))).toEqual({
      categories: ['a', 'z'],
      evidence: [{location: 'second'}, {location: 'first'}],
      unresolved: [{location: 'second'}, {location: 'first'}],
    });
  });

  it('uses code-unit lexicographic ordering for object keys', () => {
    expect(stableJson({a: 2, Z: 1})).toBe('{\n  "Z": 1,\n  "a": 2\n}\n');
  });
});
