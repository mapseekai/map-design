import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { ApiProfileService, resolveApiProfile } from '../../../src/map-design/application/api-profile-service.js';
import { createMapDesignConfigStore } from '../../../src/map-design/storage/config-store.js';
import { createMapDesignRuntimeCatalog } from '../../../src/map-design/application/runtime-catalog.js';
import { apiAgentDef } from '../../../src/runtimes/defs/api.js';
import { apiProfileModelId } from '@mapseekai/contracts';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { force: true, recursive: true })); vi.restoreAllMocks(); });
const input = { name: 'Primary', protocol: 'openai' as const, apiFormat: 'chat-completions' as const,
  baseUrl: 'https://one.example/v1', model: 'same-model', apiKey: 'secret-one', requiresApiKey: true };
const completion = { content: [{ type: 'text' as const, text: 'OK' }], finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
function setup(model = new MockLanguageModelV4({ doGenerate: completion })) {
  const root = mkdtempSync(join(tmpdir(), 'map-api-profiles-')); roots.push(root);
  const config = createMapDesignConfigStore(root);
  const service = new ApiProfileService(config, () => model);
  return { root, config, service, model };
}
describe('saved API model profiles', () => {
  it('retains distinct endpoint/key pairs for identical model names and persists them across reopen', () => {
    const { root, service, config } = setup();
    service.save('a', input);
    service.save('b', { ...input, name: 'Second', baseUrl: 'https://two.example/v1', apiKey: 'secret-two' });
    expect(service.list()).toMatchObject({ activeProfileId: 'a', profiles: [{ id: 'a', hasApiKey: true }, { id: 'b', hasApiKey: true }] });
    expect(JSON.stringify(service.list())).not.toContain('secret-');
    expect(resolveApiProfile(config.read(), apiProfileModelId('a'))).toMatchObject({ baseUrl: input.baseUrl, apiKey: 'secret-one' });
    service.activate('b');
    expect(resolveApiProfile(config.read())).toMatchObject({ baseUrl: 'https://two.example/v1', apiKey: 'secret-two' });
    expect(resolveApiProfile(config.read(), apiProfileModelId('a'))?.apiKey).toBe('secret-one');
    expect(new ApiProfileService(createMapDesignConfigStore(root)).list()).toEqual(service.list());
  });
  it('shows an existing legacy default without rewriting it or requiring key re-entry', () => {
    const { service, config } = setup(); config.update({ byokProviders: { default: input } });
    expect(service.list().activeProfileId).toBe('default');
    const { apiKey: _key, ...change } = input;
    service.save('default', { ...change, name: 'Renamed', model: 'other-model' });
    expect(config.read().byokProviders?.default?.apiKey).toBe('secret-one');
  });
  it('retains an explicitly configured optional key when renaming its unchanged endpoint', () => {
    const { service, config } = setup(); service.save('a', { ...input, requiresApiKey: false });
    const { apiKey: _key, ...change } = input;
    service.save('a', { ...change, name: 'Renamed', requiresApiKey: false });
    expect(config.read().byokProviders?.a?.apiKey).toBe(input.apiKey);
  });
  it('will not send a retained key to a changed host or protocol', () => {
    const { service, config } = setup(); service.save('a', input);
    const { apiKey: _key, ...change } = input;
    expect(() => service.save('a', { ...change, baseUrl: 'https://other.example/v1' }))
      .toThrow('API_KEY_REQUIRED_FOR_ENDPOINT');
    expect(() => service.save('a', { ...change, protocol: 'anthropic' })).toThrow('API_KEY_REQUIRED_FOR_ENDPOINT');
    expect(config.read().byokProviders?.a?.apiKey).toBe('secret-one');
  });
  it.each(['https://user:pass@one.example/v1', 'https://one.example/v1?target=other', 'https://one.example/v1#other'])
    ('does not treat an unsafe endpoint as the retained credential target: %s', baseUrl => {
      const { service, config } = setup(); service.save('a', input);
      const { apiKey: _key, ...change } = input;
      expect(() => service.save('a', { ...change, baseUrl })).toThrow('API_KEY_REQUIRED_FOR_ENDPOINT');
      expect(config.read().byokProviders?.a?.baseUrl).toBe(input.baseUrl);
    });
  it('rejects unsafe IDs, malformed input, and redacted key placeholders', () => {
    const { service } = setup();
    for (const id of ['__proto__', 'constructor', '../a', 'prototype']) expect(() => service.save(id, input)).toThrow();
    for (const patch of [{ model: '' }, { apiKey: '[REDACTED]' }, { baseUrl: 'javascript:alert(1)' }, { baseUrl: 'https://user:pass@example.com' }, { arbitrary: true }]) {
      expect(() => service.save('a', { ...input, ...patch })).toThrow();
    }
    expect(service.list().profiles).toHaveLength(0);
  });
  it('deletes credentials and explicitly clears the default; deleted explicit choices fail closed', () => {
    const { service, config } = setup(); service.save('a', input); service.save('b', { ...input, name: 'Second' });
    service.delete('a');
    expect(service.list().activeProfileId).toBeNull();
    expect(config.read().byokProviders).not.toHaveProperty('a');
    expect(() => resolveApiProfile(config.read(), apiProfileModelId('a'))).toThrow('API_PROFILE_NOT_FOUND');
    expect(resolveApiProfile(config.read())).toBeUndefined();
    service.activate('b'); expect(resolveApiProfile(config.read())?.model).toBe(input.model);
  });
  it('performs no request on save, explicitly probes a saved model, and invalidates results when edited', async () => {
    const { service, model, config } = setup(); service.save('a', input);
    expect(model.doGenerateCalls).toHaveLength(0);
    const result = await service.test('a', new AbortController().signal);
    expect(result.status).toBe('passed'); expect(model.doGenerateCalls).toHaveLength(1);
    expect(config.read().byokProviders?.a?.connectionTest).toEqual(result);
    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(512);
    service.save('a', { ...input, name: 'Renamed only' });
    expect(service.list().profiles[0]?.connectionTest).toEqual(result);
    service.save('a', { ...input, model: 'other-model' });
    expect(service.list().profiles[0]?.connectionTest).toBeUndefined();
  });
  it('sanitizes upstream test errors and rate limits repeated test actions', async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('secret-one at secret endpoint'); } });
    const { service } = setup(model); service.save('a', input);
    const result = await service.test('a', new AbortController().signal);
    expect(result).toMatchObject({ status: 'failed', code: 'API_REQUEST_FAILED' });
    expect(JSON.stringify(result)).not.toContain('secret');
    await expect(service.test('a', new AbortController().signal)).rejects.toThrow('API_TEST_BUSY');
    expect(model.doGenerateCalls).toHaveLength(1);
  });
  it('never resurrects deleted profiles or applies stale connection results', async () => {
    let finish!: (value: typeof completion) => void;
    const pending = new Promise<typeof completion>((resolve) => { finish = resolve; });
    const { service } = setup(new MockLanguageModelV4({ doGenerate: async () => pending }));
    service.save('a', input);
    const check = service.test('a', new AbortController().signal);
    service.delete('a'); finish(completion);
    await expect(check).rejects.toThrow('API_PROFILE_CHANGED');
    expect(service.list().profiles).toHaveLength(0);
  });
  it('projects the live saved catalog and does not normalize deleted accounts to another one', () => {
    const { service, config } = setup();
    const catalog = createMapDesignRuntimeCatalog({ definitions: [apiAgentDef], apiConfig: () => config.read(),
      inspect: (definition) => ({ definition, available: true, environment: {}, mapDesign: { nativeMapTools: true, publicReasoningSummary: true } }) });
    service.save('a', input); service.save('b', { ...input, name: 'Second' });
    expect(catalog.list()[0]).toMatchObject({ modelCatalogSource: 'configured', supportsCustomModel: false, models: [
      { id: 'api-profile:a', label: 'Primary · same-model', default: true }, { id: 'api-profile:b', default: false } ] });
    expect(catalog.resolveChoice('api', { agentId: 'api' }).model).toBe('api-profile:a');
    service.activate('b'); expect(catalog.resolveChoice('api', { agentId: 'api', model: 'default' }).model).toBe('api-profile:b');
    service.delete('a');
    expect(() => catalog.resolveChoice('api', { agentId: 'api', model: 'api-profile:a' })).toThrow();
    expect(catalog.normalizeSaved({ agentId: 'api', model: 'api-profile:a' }).runtime.model).toBe('api-profile:a');
  });
});


describe('API profile selection lifecycle regressions', () => {
  function catalogFor(config: ReturnType<typeof createMapDesignConfigStore>) {
    return createMapDesignRuntimeCatalog({ definitions: [apiAgentDef], apiConfig: () => config.read(),
      inspect: (definition) => ({ definition, available: true, environment: {},
        mapDesign: { nativeMapTools: true, publicReasoningSummary: true } }) });
  }

  it('pins an implicit default at validation instead of following later global changes', () => {
    const { service, config } = setup(); const catalog = catalogFor(config);
    service.save('a', input); service.save('b', { ...input, name: 'Secondary', model: 'other-model' });
    const selected = catalog.validate({ agentId: 'api' });
    expect(selected).toMatchObject({ model: 'api-profile:a', modelOrigin: 'catalog' });
    service.activate('b');
    expect(catalog.resolveChoice('api', selected).model).toBe('api-profile:a');
  });

  it('does not redirect a legacy saved model name to an unrelated default account', () => {
    const { service, config } = setup(); const catalog = catalogFor(config);
    service.save('a', input); service.save('b', { ...input, name: 'Secondary', model: 'other-model' });
    service.activate('b');
    expect(catalog.resolveChoice('api', { agentId: 'api', model: 'same-model' }).model).toBe('api-profile:a');
    service.delete('a');
    expect(() => catalog.resolveChoice('api', { agentId: 'api', model: 'same-model' })).toThrow();
  });

  it('keeps legacy conversations readable after all defaults are removed', () => {
    const { service, config } = setup(); const catalog = catalogFor(config);
    service.save('a', input); service.delete('a');
    expect(catalog.normalizeSaved({ agentId: 'api' })).toMatchObject({ runtime: { agentId: 'api' }, normalizationNotice: expect.any(String) });
  });

  it('allows explicitly removing the key when moving to a keyless local endpoint', () => {
    const { service, config } = setup(); service.save('a', input);
    const { apiKey: _key, ...change } = input;
    service.save('a', { ...change, baseUrl: 'http://127.0.0.1:12345/v1', requiresApiKey: false });
    expect(config.read().byokProviders?.a?.apiKey).toBe('');
    expect(service.list().profiles[0]?.hasApiKey).toBe(false);
  });
});
