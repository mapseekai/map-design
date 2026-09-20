import express from 'express';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MapDraftError } from '../../../src/map-design/application/errors.js';
import {
  createMapDesignSourcePreviewResourceGateway,
} from '../../../src/map-design/routes/resource-gateway.js';
import {
  createMapDesignSourcePreviewRouter,
} from '../../../src/map-design/routes/source-preview-routes.js';
import type { MapSourcePreviewService } from '../../../src/map-design/ingestion/source-import-service.js';

const STYLE = { version: 8 as const, sources: {}, layers: [] };

function previewService(overrides: Partial<MapSourcePreviewService> = {}): MapSourcePreviewService {
  return {
    getPreviewStyle: vi.fn(() => STYLE),
    deletePreview: vi.fn(),
    getResource: vi.fn(async () => ({
      bytes: new TextEncoder().encode('{"ok":true}'),
      mediaType: 'application/geo+json',
      etag: '"resource-v1"',
    })),
    getPmtilesArchiveRange: vi.fn(async () => ({
      bytes: Uint8Array.of(1, 2, 3),
      mediaType: 'application/vnd.pmtiles',
      etag: '"pm-v1"',
      start: 0,
      end: 2,
      total: 10,
    })),
    ...overrides,
  };
}

describe('MapDesign source preview routes', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })));
  });

  it('runs the local request gate before preview lookup', async () => {
    const service = previewService();
    const { url } = await listen([
      createMapDesignSourcePreviewResourceGateway({
        resourceService: service,
        requireLocalDaemonRequest: (_request, response) => {
          response.status(403).json({ error: 'local only' });
        },
      }),
      createMapDesignSourcePreviewRouter({
        sourcePreviewService: service,
        requireLocalDaemonRequest: (_request, response) => {
          response.status(403).json({ error: 'local only' });
        },
      }),
    ], servers);

    const response = await fetch(`${url}/api/map-design/source-previews/preview-1/style`);

    expect(response.status).toBe(403);
    expect(service.getPreviewStyle).not.toHaveBeenCalled();
  });

  it('serves a no-store same-origin MapLibre Style and deletes the session', async () => {
    const service = previewService();
    const { url } = await listen([
      createMapDesignSourcePreviewRouter({
        sourcePreviewService: service,
        requireLocalDaemonRequest: (_request, _response, next) => next(),
      }),
    ], servers);

    const styleResponse = await fetch(`${url}/api/map-design/source-previews/preview-1/style`);
    expect(styleResponse.status).toBe(200);
    expect(styleResponse.headers.get('cache-control')).toBe('no-store');
    expect(styleResponse.headers.get('content-type')).toMatch(/^application\/json/u);
    expect(styleResponse.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(styleResponse.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await styleResponse.json()).toEqual(STYLE);
    expect(service.getPreviewStyle).toHaveBeenCalledWith('preview-1');

    const deleteResponse = await fetch(`${url}/api/map-design/source-previews/preview-1`, {
      method: 'DELETE',
    });
    expect(deleteResponse.status).toBe(204);
    expect(service.deletePreview).toHaveBeenCalledWith('preview-1');
  });

  it('serves normal resources and bounded PMTiles ranges through the shared gateway', async () => {
    const service = previewService();
    const { url } = await listen([
      createMapDesignSourcePreviewResourceGateway({
        resourceService: service,
        requireLocalDaemonRequest: (_request, _response, next) => next(),
      }),
    ], servers);

    const resource = await fetch(
      `${url}/api/map-design/source-previews/preview-1/resources/resource-1/data.geojson`,
    );
    expect(resource.status).toBe(200);
    expect(resource.headers.get('etag')).toBe('"resource-v1"');
    expect(await resource.json()).toEqual({ ok: true });
    expect(service.getResource).toHaveBeenCalledWith(
      'preview-1',
      'resource-1',
      ['data.geojson'],
      expect.any(AbortSignal),
    );

    const archive = await fetch(
      `${url}/api/map-design/source-previews/preview-1/resources/archive/archive.pmtiles`,
      { headers: { Range: 'bytes=0-2' } },
    );
    expect(archive.status).toBe(206);
    expect(archive.headers.get('content-range')).toBe('bytes 0-2/10');
    expect(new Uint8Array(await archive.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
    expect(service.getPmtilesArchiveRange).toHaveBeenCalledWith(
      'preview-1',
      'archive',
      { start: 0, endInclusive: 2 },
      undefined,
      expect.any(AbortSignal),
    );
  });

  it('returns a safe 404 for a missing or expired preview', async () => {
    const service = previewService({
      getPreviewStyle: vi.fn(() => {
        throw new MapDraftError('NOT_FOUND', 'The source preview was not found.');
      }),
    });
    const { url } = await listen([
      createMapDesignSourcePreviewRouter({
        sourcePreviewService: service,
        requireLocalDaemonRequest: (_request, _response, next) => next(),
      }),
    ], servers);

    const response = await fetch(`${url}/api/map-design/source-previews/missing/style`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'The source preview was not found.',
        retryable: false,
      },
    });
  });
});

async function listen(routers: express.Router[], servers: Server[]): Promise<{ url: string }> {
  const app = express();
  for (const router of routers) app.use(router);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  return { url: `http://127.0.0.1:${address.port}` };
}
