// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { hashStyle } from 'maplibre-style-tools/maplibre';
import { prepareMapStyleForRuntime } from '../../src/map-design/map/runtime-style';
import { hashMapDesignStyle } from '../../src/map-design/map/map-design-style-hash';
import { LiveDraftController } from '../../src/map-design/map/live-draft-controller';

const resource = '/api/map-design/projects/p1/resources/' + 'a'.repeat(64);
const style = { version: 8, sources: {}, layers: [], sprite: resource + '/sprite', glyphs: resource + '/fonts/{fontstack}/{range}.pbf' };
it('makes sprites and glyphs absolute without altering canonical data or its hash', async () => {
  const origin = window.location.origin;
  const runtime = prepareMapStyleForRuntime(style, 'p1', { origin });
  expect(runtime.sprite).toBe(origin + style.sprite);
  expect(runtime.glyphs).toBe(origin + style.glyphs);
  expect(style.sprite).toBe(resource + '/sprite');
  expect(await hashMapDesignStyle(runtime as never, 'p1', { origin })).toBe(await hashStyle(style as never));
});
it('normalizes the same resources on canonical reload, not just the first map mount', async () => {
  const styleHash = await hashStyle(style as never);
  const apply = vi.fn(async (_map, runtime, options) => {
    expect(runtime.sprite).toBe(window.location.origin + style.sprite);
    expect(await options.hashStyle(runtime)).toBe(styleHash);
  });
  const controller = new LiveDraftController({ map: {}, projectId: 'p1',
    initialContext: { draftRevision: 0, styleHash: 'b'.repeat(64) },
    loadCanonical: async () => ({ style, context: { draftRevision: 1, styleHash } }), applyCanonicalStyle: apply });
  await controller.reload('preview-request');
  expect(apply).toHaveBeenCalledOnce();
  expect(controller.snapshot()).toMatchObject({ draftRevision: 1, styleHash });
  controller.close();
});
it('keeps cross-project resource rejection intact', () => {
  expect(() => prepareMapStyleForRuntime(style, 'other', { origin: window.location.origin })).toThrow();
});
