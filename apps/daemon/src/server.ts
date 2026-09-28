import { createMapRunHistory } from './map-design/storage/run-history.js';
import { DEFAULT_MAP_DESIGN_SYSTEM_ID } from '@mapseekai/map-design-contracts';
import { CartographyEditService } from './map-design/application/cartography-edit-service.js';
import { MapTextAttachmentService } from './map-design/application/text-attachment-service.js';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import 'multer';
import { isLoopbackHostname } from './http/local-daemon-request.js';
import { apiTokenFromEnv, isApiAuthDisabled } from './api-token-auth.js';
import { openMapDesignDatabase, closeMapDesignDatabase } from './map-design/storage/database.js';
import { createMapDesignConfigStore } from './map-design/storage/config-store.js';
import { createMapDesignLocalStore } from './map-design/storage/local-store.js';
import { MapInitialRunService } from './map-design/application/initial-run-service.js';
import { MapThumbnailService } from './map-design/application/thumbnail-service.js';
import { MapScreenshotService } from './map-design/application/screenshot-service.js';
import { MapDesignStyleEditService } from './map-design/application/style-edit-service.js';
import { loadMapDesignSystem } from './map-design/validation/design-system-loader.js';
import { createMapDesignProjectServices, type MapDesignProjectServices } from './server-context.js';
import { MapDesignProjectService } from './map-design/application/project-service.js';
import { createMapDesignRunService, type MapDesignRunService, type SpawnedLocalAgent } from './map-design/application/run-service.js';
import { MapDesignConversationService } from './map-design/application/conversation-service.js';
import { MapDesignCommentService } from './map-design/application/comment-service.js';
import { MapDesignConversationRuntimeService } from './map-design/application/conversation-runtime-service.js';
import { createSdkMapToolRuntime } from './map-design/agents/sdk-tool-runtime.js';
import { createMapAgentSessionBroker } from './map-design/agents/session-broker.js';
import { createLocalAgentRegistry } from './map-design/application/local-agent-registry.js';
import { resolveProjectRoot } from './project-root.js';
import { verifyDesktopWorkingDirectoryGrant } from './desktop-auth.js';
import { ToolTokenRegistry } from './tool-tokens.js';
import { createMapDesignApp } from './map-design-app.js';
import { readCurrentAppVersionInfo } from './app-version.js';
export interface StartServerOptions {
  port?: number; host?: string; returnServer?: boolean; staticDir?: string | null;
  mcpCliPath?: string;
  localAgentSpawn?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean }) => SpawnedLocalAgent;
  desktopPdfExporter?: unknown; desktopSlideRenderer?: unknown; desktopArtifactExporter?: unknown; runtime?: unknown;
}
export interface StartServerResult { server: http.Server; url: string; shutdown: () => Promise<void>; }

export async function resolveMapDesignMcpCliPath(explicitPath: string | undefined): Promise<string> {
  const configured = explicitPath?.trim();
  if (configured && !isAbsolute(configured)) {
    throw new Error('MAP_DESIGN_MCP_CLI_PATH must be an absolute path.');
  }
  const path = configured
    ? resolve(configured)
    : fileURLToPath(new URL('../dist/map-design-mcp-cli.js', import.meta.url));
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error('not a file');
  } catch {
    throw new Error('MAP_DESIGN_MCP_CLI_PATH must reference an existing file.');
  }
  return path;
}

export async function startServer(options: StartServerOptions = {}): Promise<StartServerResult> {
  const port = options.port ?? Number(process.env.MAP_DESIGN_PORT ?? 7456);
  const host = options.host ?? process.env.MAP_DESIGN_BIND_HOST ?? '127.0.0.1';
  const token = apiTokenFromEnv();
  if (!isLoopbackHostname(host) && !token && !isApiAuthDisabled()) {
    throw new Error(`MAP_DESIGN_BIND_HOST=${host} requires MAP_DESIGN_API_TOKEN to be set.`);
  }
  const mcpCliPath = await resolveMapDesignMcpCliPath(
    options.mcpCliPath ?? process.env.MAP_DESIGN_MCP_CLI_PATH,
  );
  const dataDir = process.env.MAP_DESIGN_DATA_DIR ?? join(process.cwd(), '.map-design');
  const db = openMapDesignDatabase(dataDir);
  let mapServices: MapDesignProjectServices | null = null;
  let activeRunService: MapDesignRunService | null = null;
  let cartographyEdits: CartographyEditService | null = null;
  let server: http.Server | null = null;
  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    let failure: unknown;
    const stop = async (operation: (() => Promise<void>) | undefined) => {
      try {
        await operation?.();
      } catch (error) {
        failure ??= error;
      }
    };
    const runService = activeRunService;
    const services = mapServices;
    await stop(cartographyEdits ? () => cartographyEdits!.shutdown() : undefined);
    await stop(runService ? () => runService.shutdown() : undefined);
    await stop(services ? () => services.importJobRunner.shutdown() : undefined);
    await stop(services ? () => services.outbox.stop() : undefined);
    await stop(services?.pinnedTransport.close ? () => services!.pinnedTransport.close!() : undefined);
    try {
      closeMapDesignDatabase(db);
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  };
  try {
    const config = createMapDesignConfigStore(dataDir);
    const projectRoot = resolveProjectRoot(fileURLToPath(new URL('.', import.meta.url)));
    const store = createMapDesignLocalStore(db);
    const runHistory = createMapRunHistory(db);
    runHistory.recoverInterrupted();
    const designSystem = await loadMapDesignSystem({ projectRoot, designSystemId: DEFAULT_MAP_DESIGN_SYSTEM_ID });
    let runService: MapDesignRunService | null = null;
    let initialRuns: MapInitialRunService | null = null;
    mapServices = createMapDesignProjectServices({
      db,
      dataRoot: dataDir,
      projectRoot,
      designSystem,
      runStore: { get: (runId) => runService?.getTrustedRun(runId) ?? null },
      onImported: async (id) => { await initialRuns?.start(id); },
    });
    const projectService = new MapDesignProjectService({
      store, sourceImportService: mapServices.sourceImportService, importJobRunner: mapServices.importJobRunner,
      queryService: mapServices.queryService, verifyWorkingDirectoryGrant: verifyDesktopWorkingDirectoryGrant,
      ensureInitialRun: async (id) => { await initialRuns?.start(id); },
    });
    const toolTokens = new ToolTokenRegistry();
    const sdkToolRuntime = createSdkMapToolRuntime(mapServices.nativeToolRegistry);
    const sessionBroker = createMapAgentSessionBroker(store);
    let url = '';
    let callbackUrl = '';
    const agents = createLocalAgentRegistry({
      projectRoot,
      config,
      nativeToolRegistry: mapServices.nativeToolRegistry,
      sessionBroker,
      ...(options.localAgentSpawn ? { spawn: options.localAgentSpawn } : {}),
    });
    await agents.probeNativeMapTools();
    void agents.runtimeCatalog.refresh();
    cartographyEdits = new CartographyEditService({ dataRoot: dataDir, projectRoot, config, agents, store,
      readSourceFile: (id) => projectService.getCartography(id).sourceFile,
      canOverwriteDocument: (id) => projectService.canOverwriteCartography(id),
      documentHistoryIds: (id) => projectService.cartographyHistoryIds(id),
      saveEditedDocument: (input) => projectService.saveCartographyEdit(input),
      saveDocument: (input) => projectService.importCartography(input),
    });
    const conversationRuntimeService = new MapDesignConversationRuntimeService({
      store,
      policy: agents.runtimeCatalog,
      isProjectRunning: (projectId) => activeRunService?.isProjectRunning(projectId) === true || cartographyEdits?.isProjectRunning(projectId) === true,
      now: () => new Date().toISOString(),
    });
    const commentService = new MapDesignCommentService({ db, getStyle: (id) => mapServices!.queryService.getStyle(id) });
    commentService.recoverAbandoned();
    const attachmentService = new MapTextAttachmentService({ blobStore: mapServices.blobStore, projectReader: mapServices.queryService });
    const thumbnailService = new MapThumbnailService(db);
    const screenshotService = new MapScreenshotService({ blobStore: mapServices.blobStore, projectReader: mapServices.queryService });
    activeRunService = createMapDesignRunService({
      runHistory,
      store,
      comments: commentService,
      screenshots: screenshotService,
      attachments: attachmentService,
      agents,
      toolTokens,
      dataDir,
      projectRoot,
      mcpCliPath,
      daemonUrl: () => callbackUrl,
      config,
      mapContext: mapServices.queryService,
      nativeToolRegistry: mapServices.nativeToolRegistry,
      sdkToolRuntime,
      runtimeChoices: conversationRuntimeService,
      runtimeCatalog: agents.runtimeCatalog,
    });
    runService = activeRunService;
    const styleEditService = new MapDesignStyleEditService({
      db, getStyle: (id) => mapServices!.queryService.getStyle(id),
      applyTransaction: (context, input) => mapServices!.draftService.applyTransaction(context, input),
      replaceStyle: (context, input) => mapServices!.draftService.replaceStyle(context, input),
      isProjectRunning: (id) => activeRunService!.isProjectRunning(id),
    });
    const conversationService = new MapDesignConversationService({
      store,
      isConversationRunning: (conversationId) => activeRunService!.isConversationRunning(conversationId) || cartographyEdits!.isConversationRunning(conversationId),
      randomId: randomUUID,
      now: () => new Date().toISOString(),
    });
    initialRuns = new MapInitialRunService({ db, store, runs: activeRunService });
    const version = await readCurrentAppVersionInfo();
    const app = createMapDesignApp({ cartographyEditService: cartographyEdits, cartographyRoots: { dataRoot: dataDir, projectRoot }, mapServices, projectService, runService: activeRunService, commentService, screenshotService, thumbnailService, attachmentService, styleEditService, conversationService, conversationRuntimeService, config, agents, toolTokens, sdkToolRuntime, version: version.version, staticDir: options.staticDir ?? null, loadPreviewRun: (projectId, previewId) => {
      const row = db.prepare('SELECT run_id AS runId FROM map_design_previews WHERE project_id = ? AND id = ?').get(projectId, previewId) as { runId?: unknown } | undefined;
      return typeof row?.runId === 'string' ? { runId: row.runId } : null;
    } });
    server = http.createServer(app);
    mapServices.outbox.start();
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(port, host, () => { server!.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('MapDesign server did not bind to a TCP port.');
    callbackUrl = loopbackCallbackUrl(address);
    url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
    await mapServices.importJobRunner.recoverAbandoned();
    await initialRuns.recover();
    return { server, url, shutdown };
  } catch (error) {
    await shutdown().catch(() => undefined);
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    throw error;
  }
}

function loopbackCallbackUrl(address: AddressInfo): string {
  return address.family === 'IPv6'
    ? `http://[::1]:${address.port}`
    : `http://127.0.0.1:${address.port}`;
}
