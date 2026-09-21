import { createMapTextAttachmentRouter } from './map-design/routes/text-attachment-routes.js';
import type { MapTextAttachmentService } from './map-design/application/text-attachment-service.js';
import { createCartographyAuthoringRouter } from './map-design/routes/cartography-authoring-routes.js';
import type { CartographyEditService } from './map-design/application/cartography-edit-service.js';
import express, { type Express, type RequestHandler } from 'express';
import { createToolRequestAuth } from './http/tool-request-auth.js';
import { requireLocalDaemonRequest } from './http/local-daemon-request.js';
import { createMapDesignSystemRouter } from './map-design/routes/system-routes.js';
import { createMapDesignProjectRouter } from './map-design/routes/project-routes.js';
import { createMapDesignImportRouter } from './map-design/routes/import-routes.js';
import {
  createMapDesignResourceGateway,
  createMapDesignSourcePreviewResourceGateway,
} from './map-design/routes/resource-gateway.js';
import { createMapDesignSourcePreviewRouter } from './map-design/routes/source-preview-routes.js';
import { createMapDesignPreviewRouter } from './map-design/routes/preview-routes.js';
import { createMapDesignRevisionUiRouter } from './map-design/routes/revision-ui-routes.js';
import { createMapDesignEventStreamRouter } from './map-design/routes/event-stream.js';
import { createMapDesignRunRouter } from './map-design/routes/run-routes.js';
import { createMapDesignConversationRouter } from './map-design/routes/conversation-routes.js';
import { createMapDesignCommentRouter } from './map-design/routes/comment-routes.js';
import type { MapDesignCommentService } from './map-design/application/comment-service.js';
import { createMapThumbnailRouter } from './map-design/routes/thumbnail-routes.js';
import type { MapThumbnailService } from './map-design/application/thumbnail-service.js';
import { createMapScreenshotRouter } from './map-design/routes/screenshot-routes.js';
import type { MapScreenshotService } from './map-design/application/screenshot-service.js';
import { createMapDesignStyleEditRouter } from './map-design/routes/style-edit-routes.js';
import type { MapDesignStyleEditService } from './map-design/application/style-edit-service.js';
import { registerMapDesignToolRoutes } from './map-design/routes/tool-routes.js';
import type { MapDesignProjectServices } from './server-context.js';
import type { MapDesignProjectService } from './map-design/application/project-service.js';
import type { MapDesignRunService } from './map-design/application/run-service.js';
import type { MapDesignConversationService } from './map-design/application/conversation-service.js';
import type { MapDesignConversationRuntimeService } from './map-design/application/conversation-runtime-service.js';
import type { MapDesignConfigStore } from './map-design/storage/config-store.js';
import type { MapDesignLocalAgentRegistry } from './map-design/application/local-agent-registry.js';
import type { SdkMapToolRuntime } from './map-design/agents/sdk-tool-runtime.js';
import { ToolTokenRegistry } from './tool-tokens.js';

export function createMapDesignApp(options: {
  mapServices: MapDesignProjectServices;
  projectService: MapDesignProjectService;
  runService: MapDesignRunService;
  commentService?: MapDesignCommentService;
  screenshotService?: MapScreenshotService;
  thumbnailService?: MapThumbnailService;
  attachmentService?: MapTextAttachmentService;
  styleEditService?: MapDesignStyleEditService;
  conversationService?: Pick<MapDesignConversationService, 'list' | 'get' | 'create' | 'delete'>;
  conversationRuntimeService?: Pick<MapDesignConversationRuntimeService, 'get' | 'update'>;
  config: MapDesignConfigStore;
  agents: MapDesignLocalAgentRegistry;
  loadPreviewRun(projectId: string, previewId: string): { runId: string } | null;
  toolTokens: ToolTokenRegistry;
  sdkToolRuntime: SdkMapToolRuntime;
  version?: string;
  staticDir?: string | null;
  cartographyRoots?: { dataRoot: string; projectRoot: string };
  cartographyEditService?: CartographyEditService;
  requireLocalRequest?: RequestHandler;
}): Express {
  const app = express();
  const requireLocal = options.requireLocalRequest ?? requireLocalDaemonRequest;
  app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.once('finish', () => {
      console.info('map-design.request', {
        method: (req.method || 'UNKNOWN').slice(0, 16),
        path: req.path.slice(0, 2_048),
        status: Math.max(0, Math.min(999, res.statusCode)),
        durationMs: Math.min(86_400_000, Math.max(0, Math.round(performance.now() - startedAt))),
        requestId,
      });
    });
    next();
  });
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return requireLocal(req, res, next);
    next();
  });
  app.options('/api/*splat', (_req, res) => res.sendStatus(204));
  app.use(createMapDesignResourceGateway({ resourceService: options.mapServices.resourceService, projectReader: options.mapServices.queryService, requireLocalDaemonRequest: requireLocal }));
  app.use(createMapDesignSourcePreviewResourceGateway({
    resourceService: options.mapServices.sourceImportService,
    requireLocalDaemonRequest: requireLocal,
  }));
  app.use(createMapDesignSourcePreviewRouter({
    sourcePreviewService: options.mapServices.sourceImportService,
    requireLocalDaemonRequest: requireLocal,
  }));
  app.use(createMapDesignSystemRouter({ config: options.config, agents: options.agents, requireLocalDaemonRequest: requireLocal, version: options.version ?? 'dev', ...(options.cartographyRoots ? { dataRoot: options.cartographyRoots.dataRoot } : {}) }));
  app.use(createMapDesignPreviewRouter({ previewFulfillmentService: options.mapServices.previewFulfillmentService, projectReader: options.mapServices.queryService, requireLocalDaemonRequest: requireLocal }));
  app.use(createMapDesignRevisionUiRouter({
    revisionService: options.mapServices.revisionService,
    isProjectRunning: (projectId) => options.runService.isProjectRunning(projectId),
    loadPreviewRun: options.loadPreviewRun,
    projectReader: options.mapServices.queryService,
    requireLocalDaemonRequest: requireLocal,
  }));
  registerMapDesignToolRoutes(app, {
    auth: createToolRequestAuth(options.toolTokens),
    projectReader: options.mapServices.queryService,
    handlers: options.mapServices.toolHandlers,
    sdkToolRuntime: options.sdkToolRuntime,
    noteActivity: (runId) => options.runService.noteActivity(runId),
  });
  if (options.conversationService) {
    if (!options.conversationRuntimeService) {
      throw new Error('MapDesign conversation runtime service is required when conversation routes are enabled.');
    }
    app.use(createMapDesignConversationRouter({
      service: options.conversationService,
      runtimeService: options.conversationRuntimeService,
      requireLocalDaemonRequest: requireLocal,
    }));
  }
  if (options.cartographyRoots) app.use(createCartographyAuthoringRouter({ config: options.config, agents: options.agents, ...options.cartographyRoots, projectService: options.projectService, requireLocal, editService: options.cartographyEditService }));
  if (options.commentService) app.use(createMapDesignCommentRouter({ service: options.commentService, requireLocalDaemonRequest: requireLocal }));
  if (options.attachmentService) app.use(createMapTextAttachmentRouter({ service: options.attachmentService, requireLocalDaemonRequest: requireLocal }));
  if (options.thumbnailService) app.use(createMapThumbnailRouter({ service: options.thumbnailService, requireLocalDaemonRequest: requireLocal }));
  if (options.screenshotService) app.use(createMapScreenshotRouter({ service: options.screenshotService, requireLocalDaemonRequest: requireLocal }));
  if (options.styleEditService) app.use(createMapDesignStyleEditRouter({ service: options.styleEditService, requireLocalDaemonRequest: requireLocal }));
  app.use(express.json({ limit: '64kb', strict: true }));
  app.use(createMapDesignProjectRouter({ projectService: options.projectService, queryService: options.mapServices.queryService, validationService: options.mapServices.validationService, requireLocalDaemonRequest: requireLocal }));
  app.use(createMapDesignImportRouter({ sourceImportService: options.mapServices.sourceImportService, importJobRunner: options.mapServices.importJobRunner, projectReader: options.mapServices.queryService, requireLocalDaemonRequest: requireLocal }));
  app.use(createMapDesignEventStreamRouter({ outbox: options.mapServices.outbox, publisher: options.mapServices.publisher, projectReader: options.mapServices.queryService, requireLocalDaemonRequest: requireLocal }));
  app.use(createMapDesignRunRouter({ runService: options.runService, requireLocalDaemonRequest: requireLocal }));
  if (options.staticDir) app.use(express.static(options.staticDir));
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }));
  app.use((error: unknown, _req: unknown, res: express.Response, _next: unknown) => {
    if (res.headersSent) return;
    const status = typeof error === 'object' && error !== null && 'type' in error
      ? (error as { type?: string }).type === 'entity.too.large' ? 413 : (error as { type?: string }).type === 'entity.parse.failed' ? 400 : 500
      : 500;
    res.status(status).json({ error: { code: status === 400 ? 'INVALID_INPUT' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL', message: status === 400 ? 'The request body is invalid.' : status === 413 ? 'The request body is too large.' : 'The request failed.' } });
  });
  return app;
}
