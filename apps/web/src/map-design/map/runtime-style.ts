import { assertMapDesignResourceUrl, assertMapDesignStyleResourceUrls } from '@mapseekai/map-design-contracts';

/** MapLibre validates sprite URLs before transformRequest, including after setStyle. */
export function prepareMapStyleForRuntime<T>(style: T, projectId: string, options: { origin?: string } = {}): T {
  const resourceOptions = { ...options, allowExternal: true };
  assertMapDesignStyleResourceUrls(style, projectId, resourceOptions);
  const result = structuredClone(style);
  const root = result as Record<string, unknown>;
  if (typeof root.sprite === 'string') root.sprite = assertMapDesignResourceUrl(root.sprite, projectId, resourceOptions);
  else if (Array.isArray(root.sprite)) {
    for (const sprite of root.sprite) {
      if (sprite && typeof sprite === 'object' && typeof sprite.url === 'string') {
        sprite.url = assertMapDesignResourceUrl(sprite.url, projectId, resourceOptions);
      }
    }
  }
  if (typeof root.glyphs === 'string') root.glyphs = assertMapDesignResourceUrl(root.glyphs, projectId, resourceOptions);
  return result;
}
