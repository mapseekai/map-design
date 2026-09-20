import { describe, expect, it } from 'vitest';
import { MapCommentInputSchema, MapCommentRefsSchema } from '../src/comments.js';

const input = {
  id: 'comment-1', version: 0, text: 'Make this road red', scope: 'feature',
  draftRevision: 3, styleHash: 'a'.repeat(64),
  target: { layerId: 'roads', sourceId: 'streets', sourceLayer: 'transportation', featureId: 0,
    properties: { class: 'primary', lanes: 2, bridge: false }, anchor: [120, 30], geometryType: 'LineString' },
};

describe('map comment contracts', () => {
  it('preserves zero feature IDs and typed category values', () => {
    expect(MapCommentInputSchema.parse(input).target.featureId).toBe(0);
    for (const [property, value] of Object.entries(input.target.properties)) {
      const parsed = MapCommentInputSchema.parse({ ...input, scope: 'similar', match: { property, value } });
      expect(parsed.match?.value).toBe(value);
    }
  });
  it('requires a concrete scope and a matching property from the picked feature', () => {
    expect(MapCommentInputSchema.safeParse({ ...input, target: { ...input.target, featureId: undefined } }).success).toBe(false);
    expect(MapCommentInputSchema.safeParse({ ...input, scope: 'similar' }).success).toBe(false);
    expect(MapCommentInputSchema.safeParse({ ...input, scope: 'similar', match: { property: 'class', value: 'motorway' } }).success).toBe(false);
    expect(MapCommentInputSchema.safeParse({ ...input, scope: 'layer', match: { property: 'class', value: 'primary' } }).success).toBe(false);
  });
  it('bounds text, snapshots and input fields', () => {
    for (const change of [{ text: ' ' }, { text: 'x'.repeat(4001) }, { version: -1 }, { unexpected: true },
      { target: { ...input.target, anchor: [999, 30] } },
      { target: { ...input.target, properties: { giant: 'x'.repeat(8193) } } }]) {
      expect(MapCommentInputSchema.safeParse({ ...input, ...change }).success).toBe(false);
    }
  });
  it('rejects duplicate, empty and oversized batches', () => {
    const ref = { id: 'comment-1', version: 1 };
    expect(MapCommentRefsSchema.parse([ref])).toEqual([ref]);
    for (const refs of [[], [ref, ref], Array.from({ length: 21 }, (_, i) => ({ id: `c-${i}`, version: 1 }))]) {
      expect(MapCommentRefsSchema.safeParse(refs).success).toBe(false);
    }
  });
});
