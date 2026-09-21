import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import express, { type Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createLocalAgentRegistry,
  type MapDesignLocalAgentRegistry,
} from '../../../src/map-design/application/local-agent-registry.js';
import { createMapDesignSystemRouter } from '../../../src/map-design/routes/system-routes.js';
import { createMapDesignConfigStore } from '../../../src/map-design/storage/config-store.js';

const dataDirs: string[] = [];

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true });
});

function setup(agents: MapDesignLocalAgentRegistry = {
  list: () => [],
  get: () => null,
  launchEnv: () => null,
  probeNativeMapTools: async () => undefined,
  runtimeCatalog: {
    refresh: async () => undefined,
    list: () => [],
  validate: (input) => input,
  normalizeSaved: (input) => ({ runtime: input }),
    resolveChoice: () => { throw new Error('not configured'); },
  },
}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'map-design-system-routes-'));
  dataDirs.push(dataDir);
  const config = createMapDesignConfigStore(dataDir);
  const app: Express = express();
  app.use(createMapDesignSystemRouter({
    config,
    agents,
    requireLocalDaemonRequest: (_req, _res, next) => next(),
    version: 'test',
  }));
  return { app, config };
}

async function request(app: Express, method: 'GET' | 'PUT', body?: unknown, path = '/api/config') {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not listen');
  try {
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      ...(body === undefined ? {} : {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
}

describe('MapDesign system config route', () => {
  it('merges per-runtime switches without replacing another runtime or saved credentials', async () => {
    const { app, config } = setup();
    config.update({ runtimePreferences: { first: { enabled: false }, second: { disabledModels: ['old'] } },
      agentCliEnv: { second: { TOKEN: 'private' } } });
    const response = await request(app, 'PUT', { runtimePreferences: { second: { enabled: false } } });
    expect(response.status).toBe(200);
    expect(config.read().runtimePreferences).toEqual({ first: { enabled: false }, second: { enabled: false, disabledModels: ['old'] } });
    expect(config.read().agentCliEnv?.second).toEqual({ TOKEN: 'private' });
    expect(JSON.stringify(await response.json())).not.toContain('private');
  });

  it('distinguishes keyless configurations from saved redacted credentials', async () => {
    const { app, config } = setup();
    config.update({ byokProviders: {
      local: { protocol: 'openai', apiKey: '', requiresApiKey: false, model: 'local-model' },
      remote: { protocol: 'openai', apiKey: 'only-on-server', model: 'remote-model' },
    } });
    const response = await request(app, 'GET');
    const result = await response.json() as { config: { byokProviders: Record<string, { apiKey: string }> } };
    expect(result.config.byokProviders.local!.apiKey).toBe('');
    expect(result.config.byokProviders.remote!.apiKey).toBe('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain('only-on-server');
  });

  it('returns the authoritative safe runtime catalog snapshot without projecting runtime definitions', async () => {
    const { app } = setup({
      list: () => { throw new Error('runtime definitions must not be projected by the route'); },
      get: () => null,
      launchEnv: () => null,
      probeNativeMapTools: async () => undefined,
      runtimeCatalog: {
        refresh: async () => undefined,
      validate: (input) => input,
      normalizeSaved: (input) => ({ runtime: input }),
        resolveChoice: () => { throw new Error('not configured'); },
        list: () => [{
          id: 'codex',
          label: 'Codex',
          available: true,
          version: '2.4.1',
          models: [{
            id: 'openai/gpt-5.6-terra', label: 'GPT 5.6 Terra', enabled: true, default: true,
            reasoningOptions: ['low', 'high'], serviceTierOptions: ['priority'],
          }],
          supportsReasoning: true,
          supportsServiceTier: true,
          modelCatalogSource: 'live',
          mapDesign: {
            nativeMapTools: true,
            publicReasoningSummary: true,
          },
        }],
      },
    });

    const response = await request(app, 'GET', undefined, '/api/agents');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      agents: [{
        id: 'codex',
        label: 'Codex',
        available: true,
        version: '2.4.1',
        models: [{
          id: 'openai/gpt-5.6-terra', label: 'GPT 5.6 Terra', enabled: true, default: true,
          reasoningOptions: ['low', 'high'], serviceTierOptions: ['priority'],
        }],
        supportsReasoning: true,
        supportsServiceTier: true,
        modelCatalogSource: 'live',
        mapDesign: {
          nativeMapTools: true,
          publicReasoningSummary: true,
        },
      }],
    });
  });

  it('preserves fallback source and bounded warning metadata from the catalog', async () => {
    const { app } = setup({
      list: () => [],
      get: () => null,
      launchEnv: () => null,
      probeNativeMapTools: async () => undefined,
      runtimeCatalog: {
        refresh: async () => undefined,
      validate: (input) => input,
      normalizeSaved: (input) => ({ runtime: input }),
        resolveChoice: () => { throw new Error('not configured'); },
        list: () => [{
          id: 'kimi', label: 'Kimi', available: false,
          models: [], modelCatalogSource: 'fallback',
          modelCatalogWarning: 'Live model catalog unavailable; showing static fallback models.',
          mapDesign: {
            nativeMapTools: false,
            publicReasoningSummary: true,
            reason: 'agent-unavailable',
          },
        }],
      },
    });

    const response = await request(app, 'GET', undefined, '/api/agents');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      agents: [{
        id: 'kimi',
        label: 'Kimi',
        available: false,
        models: [],
        modelCatalogSource: 'fallback',
        modelCatalogWarning: 'Live model catalog unavailable; showing static fallback models.',
        mapDesign: {
          nativeMapTools: false,
          publicReasoningSummary: true,
          reason: 'agent-unavailable',
        },
      }],
    });
  });

  it('does not expose an absolute executable path from a local profile', async () => {
    const absoluteBin = process.execPath;
    const agents = createLocalAgentRegistry({
      definitions: [{
        id: 'local-profile',
        name: 'Local Profile',
        bin: absoluteBin,
        versionArgs: ['--version'],
        fallbackModels: [{ id: 'default', label: 'Default' }],
        buildArgs: () => [],
        streamFormat: 'plain',
      }],
      stageSkill: async () => undefined,
    });
    const { app } = setup(agents);

    const response = await request(app, 'GET', undefined, '/api/agents');
    const body = await response.json() as { agents: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ agents: [{ id: 'local-profile' }] });
    expect(body.agents[0]).not.toHaveProperty('executable');
    expect(JSON.stringify(body)).not.toContain(absoluteBin);
  });

  it('preserves agent model overrides when a config update omits agentModels', async () => {
    const { app, config } = setup();
    config.update({
      byokProviders: { default: { protocol: 'anthropic', apiKey: 'real-secret', baseUrl: 'https://old.example' } },
      agentModels: { claude: { model: 'old-model', reasoning: 'high' }, codex: { model: 'untouched-model', serviceTier: 'priority' } },
    });

    const response = await request(app, 'PUT', {
      byokProviders: { default: { protocol: 'anthropic', baseUrl: 'https://new.example' } },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ config: { byokProviders: { default: { apiKey: '[REDACTED]', baseUrl: 'https://new.example' } } } });
    expect(config.read()).toMatchObject({
      byokProviders: { default: { apiKey: 'real-secret', baseUrl: 'https://new.example' } },
      agentModels: { claude: { model: 'old-model', reasoning: 'high' }, codex: { model: 'untouched-model', serviceTier: 'priority' } },
    });
  });

  it('clears persisted agent model overrides when agentModels is an empty map', async () => {
    const { app, config } = setup();
    config.update({ agentModels: { claude: { model: 'old-model' } } });

    const put = await request(app, 'PUT', { agentModels: {} });

    expect(put.status).toBe(200);
    expect(config.read().agentModels).toBeUndefined();
    const get = await request(app, 'GET');
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ config: {} });
  });

  it('replaces agent model overrides instead of retaining absent entries', async () => {
    const { app, config } = setup();
    config.update({
      agentModels: {
        claude: { model: 'old-model', reasoning: 'high' },
        codex: { model: 'untouched-model', serviceTier: 'priority' },
      },
    });

    const response = await request(app, 'PUT', { agentModels: { claude: { model: 'new-model' } } });

    expect(response.status).toBe(200);
    expect(config.read().agentModels).toEqual({ claude: { model: 'new-model' } });
  });

  it('removes explicitly cleared provider metadata while preserving its stored secret', async () => {
    const { app, config } = setup();
    config.update({
      byokProviders: { default: {
        protocol: 'azure',
        apiKey: 'real-secret',
        baseUrl: 'https://old.example',
        apiVersion: '2025-01-01',
        model: 'old-model',
      } },
    });

    const response = await request(app, 'PUT', { byokProviders: { default: {
      protocol: 'azure',
      baseUrl: '',
      apiVersion: '',
      model: '',
    } } });

    expect(response.status).toBe(200);
    expect(config.read().byokProviders?.default).toEqual({
      protocol: 'azure',
      apiKey: 'real-secret',
    });
  });

  it('rejects a new provider without a key', async () => {
    const { app } = setup();
    const response = await request(app, 'PUT', { byokProviders: { newProvider: { protocol: 'openai' } } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'INVALID_INPUT', message: 'The MapDesign configuration is invalid.' } });
  });

  it('never persists the redaction marker as a provider secret', async () => {
    const { app, config } = setup();
    config.update({ byokProviders: { default: { protocol: 'anthropic', apiKey: 'real-secret' } } });
    const response = await request(app, 'PUT', { byokProviders: { default: { protocol: 'anthropic', apiKey: '[REDACTED]' } } });
    expect(response.status).toBe(400);
    expect(config.read().byokProviders?.default?.apiKey).toBe('real-secret');
  });
});
