import { networkInterfaces } from 'node:os';

import type Database from 'better-sqlite3';
import { mergeProxyAwareEnv, resolveSystemProxyEnv } from '@mapseekai/platform';
import { MapDesignQueryService } from './map-design/application/query-service.js';
import { MapDraftService } from './map-design/application/draft-service.js';
import { MapRevisionService, type MapTrustedRunStore } from './map-design/application/revision-service.js';
import { MapPreviewRequestServiceImpl } from './map-design/application/preview-request-service.js';
import { MapPreviewFulfillmentService } from './map-design/application/preview-fulfillment-service.js';
import { MapDesignValidationService } from './map-design/application/validation-service.js';
import { MapDesignEventOutbox } from './map-design/application/event-outbox.js';
import {
  InMemoryMapStudioEventPublisher,
  MapDesignOutboxEventBus,
  type MapStudioEventPublisher,
} from './map-design/application/event-bus.js';
import { createMapToolHandlers, type MapToolHandlerRegistry } from './map-design/tools/tool-handlers.js';
import { createMapDesignNativeToolRegistry } from './map-design/tools/native-tool-registry.js';
import type { MapDesignNativeToolRegistry } from './map-design/tools/tool-context.js';
import { createPinnedTransport, type PinnedTransport } from './map-design/ingestion/pinned-transport.js';
import { isProxyVirtualAddress } from './map-design/ingestion/network-policy.js';
import { MapSourceImportServiceImpl } from './map-design/ingestion/source-import-service.js';
import { createMapImportJobRunner, type MapImportJobRunner } from './map-design/ingestion/import-job-runner.js';
import {
  createMapDesignResourceService,
  type MapDesignResourceService,
} from './map-design/resources/resource-service.js';
import { createMapDesignBlobStore } from './map-design/storage/blob-store.js';
import { MapDesignSqliteProjectRepository } from './map-design/storage/project-repository.js';
import type { LoadedMapDesignSystem } from './map-design/validation/design-system-loader.js';
import { loadPinnedCartography, migrateLegacyCartographyBindings, pinCartographyDocument, registerBundledCartography } from './map-design/storage/cartography-bindings.js';

export interface MapDesignProjectServices {
  queryService: MapDesignQueryService;
  draftService: MapDraftService;
  validationService: MapDesignValidationService;
  revisionService: MapRevisionService;
  previewService: MapPreviewRequestServiceImpl;
  previewFulfillmentService: MapPreviewFulfillmentService;
  toolHandlers: MapToolHandlerRegistry;
  nativeToolRegistry: MapDesignNativeToolRegistry;
  resourceService: MapDesignResourceService;
  sourceImportService: MapSourceImportServiceImpl;
  importJobRunner: MapImportJobRunner;
  outbox: MapDesignEventOutbox;
  publisher: MapStudioEventPublisher;
  repository: MapDesignSqliteProjectRepository;
  blobStore: ReturnType<typeof createMapDesignBlobStore>;
  pinnedTransport: PinnedTransport;
}

export type MapDesignNetworkInterfaceSnapshot = Record<
  string,
  readonly { address: string; internal: boolean }[] | undefined
>;

export function shouldAllowMapDesignProxyVirtualAddresses(
  processEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  systemProxyEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = resolveSystemProxyEnv(),
  interfaceSnapshot: MapDesignNetworkInterfaceSnapshot = networkInterfaces(),
): boolean {
  const proxyEnv = mergeProxyAwareEnv(process.platform, systemProxyEnv, processEnv);
  const hasValidProxy = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].some((key) => {
    const value = proxyEnv[key]?.trim();
    if (!value) return false;
    try {
      return ['http:', 'https:', 'socks:', 'socks5:', 'socks5h:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  });
  if (hasValidProxy) return true;
  return Object.values(interfaceSnapshot).some((entries) => entries?.some((entry) => (
    entry.internal === false && isProxyVirtualAddress(entry.address)
  )) === true);
}

export function createMapDesignProjectServices(input: {
  db: Database.Database;
  dataRoot: string;
  projectRoot: string;
  designSystem: LoadedMapDesignSystem;
  transport?: PinnedTransport;
  runStore?: MapTrustedRunStore;
  publisher?: MapStudioEventPublisher;
  onImported?(projectId: string): Promise<void>;
}): MapDesignProjectServices {
  const repository = new MapDesignSqliteProjectRepository(input.db);
  const blobStore = createMapDesignBlobStore(input.dataRoot);
  const pinnedTransport = input.transport ?? createPinnedTransport({
    allowProxyVirtualAddresses: shouldAllowMapDesignProxyVirtualAddresses(),
  });
  if (input.designSystem.format !== 'cartography') throw new TypeError('Startup requires a standard CARTOGRAPHY.md.');
  const defaultDocument = pinCartographyDocument(input.db, input.designSystem.id, input.designSystem.source);
  if (defaultDocument.digest !== input.designSystem.digest) throw new TypeError('Default cartography digest mismatch.');
  registerBundledCartography(input.db, defaultDocument);
  migrateLegacyCartographyBindings(input.db, defaultDocument);
  const loadPinnedDesignSystem = async (binding: { id: string; digest: string }) => loadPinnedCartography(input.db, binding);
  const validationService = new MapDesignValidationService({ repository, blobStore, loadDesignSystem: loadPinnedDesignSystem });
  const queryService = new MapDesignQueryService({
    db: input.db,
    repository,
    blobStore,
    loadDesignSystem: loadPinnedDesignSystem,
    validationService,
  });
  const resourceService = createMapDesignResourceService({
    db: input.db,
    blobStore,
    transport: pinnedTransport,
  });
  const publisher = input.publisher ?? new InMemoryMapStudioEventPublisher();
  const outbox = new MapDesignEventOutbox({
    db: input.db,
    publish: (projectId, sequence, event) => publisher.publish(projectId, sequence, event),
  });
  const eventBus = new MapDesignOutboxEventBus(outbox);
  const runStore = input.runStore ?? { get: () => null };
  const draftService = new MapDraftService({
    db: input.db,
    blobStore,
    loadDesignSystem: loadPinnedDesignSystem,
    eventBus,
  });
  const revisionService = new MapRevisionService({
    db: input.db,
    blobStore,
    repository,
    loadDesignSystem: loadPinnedDesignSystem,
    runStore,
    eventBus,
  });
  const previewService = new MapPreviewRequestServiceImpl({ db: input.db, outbox });
  const previewFulfillmentService = new MapPreviewFulfillmentService({
    db: input.db,
    blobStore,
    validationService,
    eventBus,
    previewService,
  });
  const toolHandlers = createMapToolHandlers({
    query: queryService,
    draft: draftService,
    validation: validationService,
    preview: previewService,
    revision: revisionService,
    runStore,
  });
  const nativeToolRegistry = createMapDesignNativeToolRegistry({
    repository,
    blobStore,
    query: queryService,
    draft: draftService,
    validation: validationService,
    preview: previewService,
    revision: revisionService,
    runStore,
  });
  const sourceImportService = new MapSourceImportServiceImpl({
    db: input.db,
    blobStore,
    transport: pinnedTransport,
    designSystem: { id: defaultDocument.id, digest: defaultDocument.digest },
    loadDesignSystem: loadPinnedDesignSystem,
    outbox,
  });
  const importJobRunner = createMapImportJobRunner({ db: input.db, executor: sourceImportService, outbox, ...(input.onImported ? { onImported: input.onImported } : {}) });
  return {
    queryService,
    draftService,
    validationService,
    revisionService,
    previewService,
    previewFulfillmentService,
    toolHandlers,
    nativeToolRegistry,
    resourceService,
    sourceImportService,
    importJobRunner,
    outbox,
    publisher,
    repository,
    blobStore,
    pinnedTransport,
  };
}
