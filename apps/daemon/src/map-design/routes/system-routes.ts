import { createApiProfileRouter } from './api-profile-routes.js';
import { Router, json, type RequestHandler } from 'express';
import type { MapDesignAppConfig, UpdateMapDesignAppConfigRequest } from '@mapseekai/contracts';
import { MapDesignConfigValidationError, type MapDesignConfigStore } from '../storage/config-store.js';
import type { MapDesignLocalAgentRegistry } from '../application/local-agent-registry.js';

const REDACTED = '[REDACTED]';

function mergeConfigPatch(current: MapDesignAppConfig, patch: unknown): UpdateMapDesignAppConfigRequest {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch as UpdateMapDesignAppConfigRequest;
  const patchRecord = patch as Record<string, unknown>;
  const next: Record<string, unknown> = { ...patchRecord };
  if (typeof patchRecord.byokProviders === 'object' && patchRecord.byokProviders !== null && !Array.isArray(patchRecord.byokProviders)) {
    const providers: Record<string, unknown> = { ...(current.byokProviders ?? {}) };
    for (const [providerId, provider] of Object.entries(patchRecord.byokProviders)) {
      const providerRecord = typeof provider === 'object' && provider !== null && !Array.isArray(provider)
        ? provider as Record<string, unknown>
        : null;
      if (providerRecord && Object.hasOwn(providerRecord, 'connectionTest')) throw new MapDesignConfigValidationError('Invalid byokProviders');
      if (providerRecord?.apiKey === REDACTED) throw new MapDesignConfigValidationError('Invalid byokProviders');
      if (Object.hasOwn(providerRecord ?? {}, 'apiKey')
        && (typeof providerRecord?.apiKey !== 'string' || providerRecord.apiKey.length === 0)) {
        throw new MapDesignConfigValidationError('Invalid byokProviders');
      }
      const merged: Record<string, unknown> = {
        ...(current.byokProviders?.[providerId] ?? {}),
        ...(providerRecord ?? {}),
      };
      for (const field of ['baseUrl', 'apiVersion', 'model'] as const) {
        if (providerRecord?.[field] === '') delete merged[field];
      }
      if (providerRecord && Object.keys(providerRecord).some((key) => key !== 'name')) delete merged.connectionTest;
      providers[providerId] = providerRecord ? merged : provider;
    }
    next.byokProviders = providers;
  }
  if (Object.hasOwn(patchRecord, 'agentModels')) {
    next.agentModels = patchRecord.agentModels;
  }
  return next as UpdateMapDesignAppConfigRequest;
}

export function createMapDesignSystemRouter(deps: {
  config: MapDesignConfigStore;
  agents: MapDesignLocalAgentRegistry;
  requireLocalDaemonRequest: RequestHandler;
  version: string;
}): Router {
  const router = Router();
  router.use('/api', deps.requireLocalDaemonRequest);
  router.get('/api/health', (_req, res) => res.json({ ok: true }));
  router.get('/api/version', (_req, res) => res.json({ version: deps.version }));
  router.get('/api/agents', (_req, res) => res.json({ agents: deps.agents.runtimeCatalog.list() }));
  router.get('/api/config', (_req, res) => res.json({ config: redactConfig(deps.config.read()) }));
  router.put('/api/config', json({ limit: '64kb', strict: true }), (req, res) => {
    try { res.json({ config: redactConfig(deps.config.update(mergeConfigPatch(deps.config.read(), req.body))) }); }
    catch (error) {
      if (error instanceof MapDesignConfigValidationError) res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'The MapDesign configuration is invalid.' } });
      else res.status(500).json({ error: { code: 'INTERNAL', message: 'The MapDesign configuration could not be saved.' } });
    }
  });
  router.use(createApiProfileRouter(deps.config));
  return router;
}

function redactConfig(config: MapDesignAppConfig): MapDesignAppConfig {
  return {
    ...config,
    ...(config.byokProviders ? { byokProviders: Object.fromEntries(Object.entries(config.byokProviders).map(([id, provider]) => [id, { ...provider, apiKey: provider.apiKey.trim() ? '[REDACTED]' : '' }])) } : {}),
    ...(config.agentCliEnv ? { agentCliEnv: Object.fromEntries(Object.entries(config.agentCliEnv).map(([id, values]) => [id, Object.fromEntries(Object.keys(values).map((key) => [key, '[REDACTED]']))])) } : {}),
  };
}
