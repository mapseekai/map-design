// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createMapResourceTransform } from '../../src/map-design/map/resource-request';
import { createMapDesignResourceProtocol } from '../../src/map-design/map/resource-protocol';
import { hashMapDesignStyle } from '../../src/map-design/map/map-design-style-hash';

const origin = 'https://studio.example.test';
const external = 'https://tiles.example.test/1/0/0.png';
describe('shared Home and Studio resource requests', () => {
  it('uses identical direct requests without daemon credentials', () => {
    const preview = createMapResourceTransform({ origin, sourceUrl: external });
    const studio = createMapResourceTransform({ origin, projectId: 'p' });
    expect(preview(external)).toEqual(studio(external));
    expect(studio(external)).toEqual({ url: external, credentials: 'same-origin' });
  });
  it('supports same-project gateways only inside a workspace', () => {
    const url = '/api/map-design/projects/p/resources/r/tiles/1/0/0.png';
    expect(createMapResourceTransform({ origin, projectId: 'p' })(url)).toMatchObject({ url: `map-design-resource://${url}` });
    expect(() => createMapResourceTransform({ origin })(url)).toThrow();
    expect(() => createMapResourceTransform({ origin, projectId: 'other' })(url)).toThrow();
  });
  it.each(['http://127.0.0.1/api/config', 'http://10.0.0.1/tiles', 'http://[::1]/tiles', 'http://localhost/tiles', 'file:///secret', 'https://name:password@maps.example/tiles'])('rejects privileged URL %s', (url) => {
    expect(() => createMapResourceTransform({ origin, projectId: 'p' })(url)).toThrow();
  });
  it.each([404, 429, 502])('preserves HTTP %s without exposing unsafe response bodies', async (status) => {
    const protocol = createMapDesignResourceProtocol({ origin, fetch: vi.fn(async () => new Response('private error details', { status, headers: { 'retry-after': '60' } })) });
    await expect(protocol({ url: 'map-design-resource:///api/map-design/projects/p/resources/r/data.geojson', type: 'json' }, new AbortController()))
      .rejects.toMatchObject({ status, retryAfter: '60', message: `MapDesign resource request failed (${status}).` });
  });
  it('hashes unchanged external URL resources consistently between renders', async () => {
    const style = { version: 8, sources: { map: { type: 'vector', tiles: ['https://tiles.example.test/{z}/{x}/{y}.pbf'] } }, layers: [] };
    expect(await hashMapDesignStyle(style as never, 'p', { origin })).toBe(await hashMapDesignStyle(structuredClone(style) as never, 'p', { origin }));
  });
});
