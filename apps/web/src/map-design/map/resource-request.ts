import { assertExternalMapResourceUrl, assertMapDesignResourceUrl } from '@mapseekai/map-design-contracts';
import type { MapOptions } from 'maplibre-gl';

/** Shared by Home and Studio. Direct public requests never receive daemon authentication headers. */
export function createMapResourceTransform(options: {
  origin: string; projectId?: string; sourceUrl?: string;
}): NonNullable<MapOptions['transformRequest']> {
  return (value) => {
    if (!value.startsWith('pmtiles://') && !value.startsWith('map-design-resource://')) {
      const url = new URL(value, options.sourceUrl ?? options.origin);
      if (url.origin !== options.origin) {
        return { url: assertExternalMapResourceUrl(url.href, options.origin), credentials: 'same-origin' };
      }
    }
    if (!options.projectId) throw new TypeError('Preview cannot request local application resources.');
    const resource = assertMapDesignResourceUrl(value, options.projectId, { origin: options.origin });
    if (resource.startsWith('pmtiles://') || resource.startsWith('map-design-resource://')) return { url: resource };
    return { url: `map-design-resource://${new URL(resource).pathname}` };
  };
}
