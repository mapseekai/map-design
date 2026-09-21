import { createServer } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { it, expect } from 'vitest';
import { createPinnedTransport, UndiciPinnedDispatcher } from '../../../src/map-design/ingestion/pinned-transport.js';
import { createMapDesignProjectServices } from '../../../src/server-context.js';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';
import { MapDesignProjectService } from '../../../src/map-design/application/project-service.js';
import { testDesignSystem } from '../../fixtures/map-design/test-design-system.js';

it('creates, imports and reopens a real gzip HTTP Style using an isolated local source server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixed-http-map-')); const db = openMapDesignDatabase(root);
  const received: string[] = [];
  const document = { version: 8, sources: {
    terrain: { type: 'raster-dem', url: 'https://tiles.example.com/unavailable.json' },
    shapes: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
  }, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eeeedd' } },
    { id: 'hillshade', type: 'hillshade', source: 'terrain' }], terrain: { source: 'terrain' } };
  const server = createServer((request, response) => {
    received.push(request.url!);
    if (request.url !== '/style.json') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); response.end(gzipSync(JSON.stringify(document)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as AddressInfo).port;
  const dispatcher = new UndiciPinnedDispatcher();
  // Only the test's dispatcher is pointed at loopback. Production network policy is unchanged.
  const transport = createPinnedTransport({ resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    dispatcher: { request: (target, request) => dispatcher.request({ ...target, address: '127.0.0.1' }, request) },
  });
  const services = createMapDesignProjectServices({ db, dataRoot: root, projectRoot: root, designSystem: testDesignSystem(), transport });
  const store = createMapDesignLocalStore(db);
  const projects = new MapDesignProjectService({ store, sourceImportService: services.sourceImportService,
    importJobRunner: services.importJobRunner, queryService: services.queryService, verifyWorkingDirectoryGrant: async () => { throw new Error('No directory grant requested'); } });
  try {
    const input = { projectId: 'local-http-map', title: 'Local HTTP map', source: { url: `http://maps.example.com:${port}/style.json` }, runtime: { agentId: 'api' }, designRequirement: 'Keep terrain', idempotencyKey: 'fixed-source' };
    const created = await projects.create(input); expect(created.project.lifecycle).toBe('importing');
    await expect.poll(async () => (await projects.get(input.projectId)).project.lifecycle).toBe('ready');
    expect((await projects.get(input.projectId)).project.failure).toBeNull(); expect(received).toEqual(['/style.json']);
    expect(await services.queryService.getStyle(input.projectId)).toEqual(document);
    expect(services.repository.getRevision(input.projectId, 0)).not.toBeNull();
    expect((await projects.create(input)).project.projectId).toBe(input.projectId);
    expect(store.listProjects()).toHaveLength(1);
  } finally {
    await services.importJobRunner.shutdown(); services.previewService.shutdown(); await services.outbox.stop(); await services.pinnedTransport.close?.();
    db.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
  }
});
