import { Router, json } from 'express';
import { LocalModelTestError, LocalModelTestService } from '../application/local-model-test-service.js';
import type { MapDesignLocalAgentRegistry } from '../application/local-agent-registry.js';

export function createLocalRuntimeRouter(agents: MapDesignLocalAgentRegistry, dataRoot?: string): Router {
  const router = Router();
  const tests = dataRoot ? new LocalModelTestService(agents, dataRoot) : null;
  router.post('/api/agents/refresh', async (_req, res) => {
    try {
      await agents.probeNativeMapTools();
      await agents.runtimeCatalog.refresh();
      res.json({ agents: agents.runtimeCatalog.list() });
    } catch { res.status(500).json({ error: { code: 'RUNTIME_REFRESH_FAILED' } }); }
  });
  router.post('/api/agents/:id/test', json({ limit: '4kb', strict: true }), async (req, res) => {
    if (!tests) { res.status(503).json({ error: { code: 'RUNTIME_TEST_UNSUPPORTED' } }); return; }
    if (!req.body || typeof req.body.model !== 'string' || req.body.model.length > 256
      || Object.keys(req.body).some(key => key !== 'model')) {
      res.status(400).json({ error: { code: 'INVALID_INPUT' } }); return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort); res.once('close', abort);
    if (req.aborted || res.destroyed) abort();
    try { res.json(await tests.test(String(req.params.id), req.body.model, controller.signal)); }
    catch (error) { res.status(error instanceof LocalModelTestError ? error.status : 500)
      .json({ error: { code: error instanceof LocalModelTestError ? error.code : 'RUNTIME_TEST_FAILED' } }); }
    finally { req.off('aborted', abort); res.off('close', abort); }
  });
  return router;
}
