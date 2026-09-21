import { it, expect, vi } from 'vitest';
import { rewriteStyleResources } from '../../../src/map-design/ingestion/style-resource-rewriter.js';
import type { PinnedFetchRequest } from '../../../src/map-design/ingestion/pinned-transport.js';

it('cancels a nested TileJSON retry sleep immediately without another request', async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async (request: PinnedFetchRequest) => ({ requestedUrl: request.url, finalUrl: request.url, redirects: [], status: 429, headers: { 'retry-after': '10' }, body: new Uint8Array() }));
  const pending = rewriteStyleResources({ projectId: 'p', approvedFinalUrl: new URL('https://maps.example.com/style.json'), signal: controller.signal,
    style: { version: 8, sources: { map: { type: 'vector', url: 'https://maps.example.com/tiles.json' } }, layers: [] },
    transport: { fetch }, blobStore: { putBytes: vi.fn() },
  });
  const assertion = expect(pending).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 5)); const started = Date.now(); controller.abort();
  await assertion; expect(Date.now() - started).toBeLessThan(250); expect(fetch).toHaveBeenCalledOnce();
});
