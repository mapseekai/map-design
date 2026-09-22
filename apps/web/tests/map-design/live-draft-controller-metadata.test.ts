import { expect, it } from 'vitest';
import { hashStyle } from 'maplibre-style-tools/maplibre';
import type { StyleDocument } from 'maplibre-style-tools/core';
import { LiveDraftController } from '../../src/map-design/map/live-draft-controller';

it('reloads canonical metadata when MapLibre has no incremental style operations', async () => {
  let rendered: StyleDocument = { version: 8, sources: {}, layers: [] };
  const canonical: StyleDocument = { ...rendered, metadata: { revision: 2 } };
  const listeners = new Set<() => void>();
  const map = {
    getStyle: () => rendered,
    isStyleLoaded: () => true,
    on: (event: string, listener: () => void) => {
      if (event === 'style.load') listeners.add(listener);
    },
    off: (event: string, listener: () => void) => {
      if (event === 'style.load') listeners.delete(listener);
    },
    setStyle: (style: StyleDocument, options: { diff: boolean }) => {
      // MapLibre's incremental diff omits metadata-only changes.
      if (options.diff) return;
      rendered = structuredClone(style);
      for (const listener of listeners) listener();
    },
  };
  const context = { draftRevision: 2, styleHash: await hashStyle(canonical) };
  const controller = new LiveDraftController({
    map,
    projectId: 'metadata-reload',
    initialContext: { draftRevision: 1, styleHash: await hashStyle(rendered) },
    loadCanonical: async () => ({ style: canonical, context }),
    transactionTimeoutMs: 100,
  });

  try {
    await controller.reload('preview-request');
    expect(rendered.metadata).toEqual({ revision: 2 });
    expect(await hashStyle(rendered)).toBe(context.styleHash);
    expect(controller.snapshot()).toMatchObject(context);
  } finally {
    controller.close();
  }
});
