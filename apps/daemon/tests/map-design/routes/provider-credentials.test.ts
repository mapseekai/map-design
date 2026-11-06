import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { ByokProviderSelection } from '@mapseekai/contracts';

import type { MapDesignLocalAgentRegistry } from '../../../src/map-design/application/local-agent-registry.js';
import { createMapDesignSystemRouter } from '../../../src/map-design/routes/system-routes.js';
import { createMapDesignConfigStore } from '../../../src/map-design/storage/config-store.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

const saved: ByokProviderSelection = { protocol: 'openai', baseUrl: 'https://old.example/v1', apiKey: 'saved-secret', model: 'old-model' };
async function setup(provider: ByokProviderSelection = saved) {
  const root = mkdtempSync(join(tmpdir(), 'map-design-provider-credentials-')); roots.push(root);
  const config = createMapDesignConfigStore(root);
  config.update({ byokProviders: { default: provider }, customInstructions: 'unchanged' });
  const agents: MapDesignLocalAgentRegistry = {
    list: () => [], get: () => null, launchEnv: () => null, probeNativeMapTools: async () => undefined,
    runtimeCatalog: { list: () => [], refresh: async () => undefined, validate: input => input,
      normalizeSaved: input => ({ runtime: input }), resolveChoice: () => { throw new Error('not configured'); } },
  };
  const app = express();
  app.use(createMapDesignSystemRouter({ config, agents, requireLocalDaemonRequest: (_req, _res, next) => next(), version: 'test' }));
  const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  const send = (patch: unknown) => fetch(`http://127.0.0.1:${address.port}/api/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  return { config, send };
}

describe('provider credential changes through the generic configuration route', () => {
  it.each([
    { name: 'host', patch: { baseUrl: 'https://other.example/v1' } },
    { name: 'path', patch: { baseUrl: 'https://old.example/other' } },
    { name: 'port', patch: { baseUrl: 'https://old.example:8443/v1' } },
    { name: 'scheme', patch: { baseUrl: 'http://old.example/v1' } },
    { name: 'protocol', patch: { protocol: 'google' } },
    { name: 'cleared endpoint', patch: { baseUrl: '' } },
    { name: 'whitespace endpoint', patch: { baseUrl: '   ' } },
    { name: 'userinfo', patch: { baseUrl: 'https://user:pass@old.example/v1' } },
    { name: 'query', patch: { baseUrl: 'https://old.example/v1?target=other' } },
    { name: 'fragment', patch: { baseUrl: 'https://old.example/v1#other' } },
  ])('rejects an unconfirmed change to the $name without changing saved state', async ({ patch }) => {
    const { config, send } = await setup(); const before = config.read();
    const response = await send({ byokProviders: { default: patch } });
    expect(response.status).toBe(400);
    expect(config.read()).toEqual(before);
    expect(JSON.stringify(await response.json())).not.toContain(saved.apiKey);
  });

  it.each(['', '   ', '[REDACTED]', ' [REDACTED] '])('rejects an invalid re-entry %j', async apiKey => {
    const { config, send } = await setup();
    const response = await send({ byokProviders: { default: { baseUrl: 'https://other.example/v1', apiKey } } });
    expect(response.status).toBe(400);
    expect(config.read().byokProviders?.default).toEqual(saved);
  });

  it.each(['?target=other', '#other'])('does not normalize trailing slashes in URL suffix %s', async suffix => {
    const { config, send } = await setup({ ...saved, baseUrl: `${saved.baseUrl}${suffix}/` });
    const before = config.read();
    const response = await send({ byokProviders: { default: { baseUrl: `${saved.baseUrl}${suffix}` } } });
    expect(response.status).toBe(400);
    expect(config.read()).toEqual(before);
  });

  it.each(['saved-secret', 'new-secret'])('accepts explicit credential re-entry %j', async apiKey => {
    const { config, send } = await setup();
    const response = await send({ byokProviders: { default: { baseUrl: 'https://other.example/v1', apiKey } } });
    expect(response.status).toBe(200);
    expect(config.read().byokProviders?.default).toMatchObject({ baseUrl: 'https://other.example/v1', apiKey });
    expect(JSON.stringify(await response.json())).not.toContain(apiKey);
  });

  it('clears the inherited credential when switching to a keyless endpoint', async () => {
    const { config, send } = await setup();
    const response = await send({ byokProviders: { default: { baseUrl: 'http://127.0.0.1:12345/v1', requiresApiKey: false } } });
    expect(response.status).toBe(200);
    expect(config.read().byokProviders?.default).toMatchObject({ apiKey: '', requiresApiKey: false });
    expect(await response.json()).toMatchObject({ config: { byokProviders: { default: { apiKey: '' } } } });
  });

  it('retains the key for model, name and equivalent trailing-slash changes', async () => {
    const { config, send } = await setup();
    const response = await send({ byokProviders: { default: { name: 'Renamed', model: 'new-model', baseUrl: 'https://old.example/v1/' } } });
    expect(response.status).toBe(200);
    expect(config.read().byokProviders?.default).toMatchObject({ apiKey: saved.apiKey, name: 'Renamed', model: 'new-model' });
  });

  it('retains an optional credential when only the name changes', async () => {
    const { config, send } = await setup({ ...saved, requiresApiKey: false });
    const response = await send({ byokProviders: { default: { name: 'Renamed optional credential' } } });
    expect(response.status).toBe(200);
    expect(config.read().byokProviders?.default).toMatchObject({ apiKey: saved.apiKey, requiresApiKey: false });
  });

  it('does not forward an optional stored credential to a different endpoint', async () => {
    const { config, send } = await setup({ ...saved, requiresApiKey: false });
    const response = await send({ byokProviders: { default: { baseUrl: 'http://127.0.0.1:12345/v1' } } });
    expect(response.status).toBe(200);
    expect(config.read().byokProviders?.default?.apiKey).toBe('');
  });

  it('protects credentials used by non-API local-agent protocols', async () => {
    const { config, send } = await setup({ ...saved, protocol: 'azure' });
    const response = await send({ byokProviders: { default: { protocol: 'ollama' } } });
    expect(response.status).toBe(400);
    expect(config.read().byokProviders?.default?.protocol).toBe('azure');
  });
});
