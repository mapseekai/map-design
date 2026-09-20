import { describe, expect, it, vi } from 'vitest';

import {
  createMapDesignResourceServiceFromLookup,
  type MapDesignResolvedResource,
} from '../../../src/map-design/resources/resource-service.js';
import type { PinnedTransport } from '../../../src/map-design/ingestion/pinned-transport.js';

const OWNER_ID = 'preview-1';
const DIGEST = 'a'.repeat(64);

function capturedResource(): MapDesignResolvedResource {
  return {
    ownerId: OWNER_ID,
    resourceId: 'captured',
    kind: 'geojson',
    mode: 'captured',
    mediaType: 'application/geo+json',
    byteLength: 3,
    contentDigest: DIGEST,
    sourceUrl: 'https://maps.example.test/data.geojson',
    etag: null,
  };
}

describe('lookup-backed MapDesign resource service', () => {
  it('serves captured bytes with the existing length and ETag checks', async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const service = createMapDesignResourceServiceFromLookup({
      lookup: {
        find: (_ownerId, resourceId) => resourceId === 'captured' ? capturedResource() : null,
        readCaptured: async () => bytes,
      },
      transport: { fetch: vi.fn() } as unknown as PinnedTransport,
    });

    await expect(service.getResource(
      OWNER_ID,
      'captured',
      ['data.geojson'],
    )).resolves.toEqual({
      bytes,
      mediaType: 'application/geo+json',
      etag: `"${DIGEST}"`,
    });
  });

  it('resolves remote tile templates through the same pinned transport', async () => {
    const fetch = vi.fn(async (request) => ({
      requestedUrl: request.url,
      finalUrl: request.url,
      redirects: [],
      status: 200,
      headers: { etag: '"tile-v1"' },
      body: Uint8Array.of(7, 8),
    }));
    const service = createMapDesignResourceServiceFromLookup({
      lookup: {
        find: (_ownerId, resourceId) => resourceId === 'tile' ? {
          ownerId: OWNER_ID,
          resourceId: 'tile',
          kind: 'tile',
          mode: 'remote',
          mediaType: 'image/png',
          byteLength: null,
          contentDigest: null,
          sourceUrl: 'https://tiles.example.test/{z}/{x}/{y}.png',
          etag: null,
        } : null,
        readCaptured: async () => { throw new Error('unexpected captured read'); },
      },
      transport: { fetch } as PinnedTransport,
    });

    await expect(service.getResource(
      OWNER_ID,
      'tile',
      ['tiles', '1', '1', '0.png'],
    )).resolves.toMatchObject({
      bytes: Uint8Array.of(7, 8),
      mediaType: 'image/png',
      etag: '"tile-v1"',
    });
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({
      url: new URL('https://tiles.example.test/1/1/0.png'),
      purpose: 'tile',
      accept: ['image/png'],
    }));
  });
});
