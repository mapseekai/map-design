import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMapDesignConfigStore } from '../../../src/map-design/storage/config-store.js';

const roots: string[] = [];
function tempRoot(): string { const root = mkdtempSync(join(tmpdir(), 'map-design-config-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('MapDesignConfigStore', () => {
  it('persists only Plan 1 keys and preserves a BYOK secret', () => {
    const store = createMapDesignConfigStore(tempRoot());
    const config = store.update({
      agentId: 'claude',
      byokProviders: { anthropic: { protocol: 'anthropic', apiKey: 'secret-key' } },
    });
    expect(config).toEqual({ agentId: 'claude', byokProviders: { anthropic: { protocol: 'anthropic', apiKey: 'secret-key' } } });
    expect(store.update({ customInstructions: 'be concise' })).toEqual({
      agentId: 'claude', customInstructions: 'be concise', byokProviders: { anthropic: { protocol: 'anthropic', apiKey: 'secret-key' } },
    });
  });

  it('rejects malformed nested BYOK providers', () => {
    const store = createMapDesignConfigStore(tempRoot());
    expect(() => store.update(JSON.parse('{"byokProviders":{"anthropic":{"protocol":"nope","apiKey":12}}}'))).toThrow(/invalid byokproviders/i);
  });

  it('deletes nullable values only when a patch explicitly supplies null', () => {
    const store = createMapDesignConfigStore(tempRoot());
    store.update({ agentId: 'claude', customInstructions: 'Keep it brief' });
    expect(store.update({ customInstructions: null })).toEqual({ agentId: 'claude' });
  });

  it('does not persist empty or default model overrides', () => {
    const store = createMapDesignConfigStore(tempRoot());
    expect(store.update({ agentModels: { claude: { model: 'default' } } })).toEqual({});
    expect(store.update({ agentModels: { claude: { model: '' } } })).toEqual({});
  });

  it('replaces agent model overrides only when the patch supplies agentModels', () => {
    const store = createMapDesignConfigStore(tempRoot());
    store.update({
      agentModels: {
        claude: { model: 'claude-model' },
        opencode: { model: 'opencode-model' },
      },
    });

    expect(store.update({ agentModels: { opencode: { reasoning: 'high' } } })).toEqual({
      agentModels: { opencode: { reasoning: 'high' } },
    });
    expect(store.update({ customInstructions: 'Preserve omitted overrides.' })).toEqual({
      agentModels: { opencode: { reasoning: 'high' } },
      customInstructions: 'Preserve omitted overrides.',
    });
    expect(store.update({ agentModels: {} })).toEqual({
      customInstructions: 'Preserve omitted overrides.',
    });
  });

  it('rejects unknown and inherited config keys without leaking stored secrets', () => {
    const root = tempRoot();
    const store = createMapDesignConfigStore(root);
    store.update({ byokProviders: { anthropic: { protocol: 'anthropic', apiKey: 'secret-key' } } });
    for (const key of ['constructor', 'toString', '__proto__']) {
      expect(() => store.update(JSON.parse(`{"${key}":"retired"}`))).toThrow(/unknown config key/i);
    }
    expect(() => store.update(Object.create({ agentId: 'inherited' }))).toThrow(/invalid mapdesign configuration/i);
    try { store.update(JSON.parse('{"constructor":"retired"}')); } catch (error) { expect(String(error)).not.toContain('secret-key'); }
  });

  it('rejects retired top-level keys when reading persisted configuration', () => {
    const root = tempRoot();
    for (const key of ['constructor', 'toString', '__proto__']) {
      writeFileSync(join(root, 'map-design-config.json'), `{"${key}":"retired"}`);
      expect(() => createMapDesignConfigStore(root).read()).toThrow(/unable to read/i);
    }
  });

  it('hides secrets when a stored configuration cannot be parsed', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'map-design-config.json'), '{"byokProviders":{"anthropic":{"apiKey":"secret-key"');
    expect(() => createMapDesignConfigStore(root).read()).toThrow(/unable to read/i);
    try { createMapDesignConfigStore(root).read(); } catch (error) { expect(String(error)).not.toContain('secret-key'); }
  });

  it('does not inspect a sibling legacy config directory', () => {
    const root = tempRoot();
    const legacy = join(root, 'legacy');
    const fresh = join(root, 'fresh');
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'map-design-config.json'), '{"agentId":"legacy"}');
    expect(createMapDesignConfigStore(fresh).read()).toEqual({});
  });

  it('rejects out-of-bound configuration records', () => {
    const store = createMapDesignConfigStore(tempRoot());
    expect(() => store.update(JSON.parse(`{${Array.from({ length: 65 }, (_, index) => `"unknown${index}":true`).join(',')}}`))).toThrow(/invalid mapdesign configuration/i);
    expect(() => store.update(JSON.parse(`{"agentModels":{"${'a'.repeat(257)}":{"model":"model"}}}`))).toThrow(/invalid agentmodels/i);
    expect(() => store.update(JSON.parse(`{"agentModels":{"claude":{"reasoning":"${'a'.repeat(65)}"}}}`))).toThrow(/invalid agentmodels/i);
    expect(() => store.update(JSON.parse(`{"agentCliEnv":${JSON.stringify(Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`agent${index}`, {}])))}}`))).toThrow(/invalid agentclienv/i);
    expect(() => store.update(JSON.parse(JSON.stringify({ agentCliEnv: { claude: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`VAR_${index}`, 'value'])) } })))).toThrow(/invalid agentclienv/i);
    expect(() => store.update(JSON.parse(`{"agentCliEnv":{"claude":{"${'A'.repeat(129)}":"value"}}}`))).toThrow(/invalid agentclienv/i);
    expect(() => store.update(JSON.parse(`{"agentCliEnv":{"claude":{"bad-key":"value"}}}`))).toThrow(/invalid agentclienv/i);
    expect(() => store.update(JSON.parse(`{"agentCliEnv":{"claude":{"KEY":"${'a'.repeat(16385)}"}}}`))).toThrow(/invalid agentclienv/i);
    expect(() => store.update(JSON.parse('{"agentCliEnvIntent":{"claude":{"apiKeyOverride":"yes"}}}'))).toThrow(/invalid agentclienvintent/i);
    expect(() => store.update(JSON.parse(`{"byokProviders":${JSON.stringify(Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`provider${index}`, { protocol: 'anthropic', apiKey: '' }])))}}`))).toThrow(/invalid byokproviders/i);
    expect(() => store.update(JSON.parse(`{"byokProviders":{"anthropic":{"protocol":"anthropic","apiKey":"${'a'.repeat(16385)}"}}}`))).toThrow(/invalid byokproviders/i);
    expect(() => store.update(JSON.parse(`{"byokProviders":{"anthropic":{"protocol":"anthropic","apiKey":"","baseUrl":"${'a'.repeat(4097)}"}}}`))).toThrow(/invalid byokproviders/i);
    expect(() => store.update(JSON.parse(`{"recentLinkedDirs":${JSON.stringify(Array.from({ length: 33 }, () => '/tmp'))}}`))).toThrow(/invalid recentlinkeddirs/i);
    expect(() => store.update(JSON.parse(`{"recentLinkedDirs":["${'a'.repeat(4097)}"]}`))).toThrow(/invalid recentlinkeddirs/i);
    expect(() => store.update(JSON.parse(`{"customInstructions":"${'a'.repeat(16385)}"}`))).toThrow(/invalid custominstructions/i);
  });

  it('atomically replaces config after writing a temporary sibling file', () => {
    const root = tempRoot();
    const observed: string[] = [];
    const store = createMapDesignConfigStore(root, {
      writeFile: (path, data, options) => { observed.push(`write:${path}`); writeFileSync(path, data, options); },
      rename: (from, to) => { observed.push(`rename:${from}:${to}`); renameSync(from, to); },
    });
    store.update({ agentId: 'new' });
    expect(observed).toHaveLength(2);
    expect(observed[0]).toMatch(new RegExp(`^write:${join(root, 'map-design-config.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));
    expect(observed[1]).toMatch(new RegExp(`^rename:${join(root, 'map-design-config.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));
    expect(JSON.parse(readFileSync(join(root, 'map-design-config.json'), 'utf8'))).toEqual({ agentId: 'new' });
  });

  it('keeps previous bytes and redacts secrets when the final rename fails', () => {
    const root = tempRoot();
    const file = join(root, 'map-design-config.json');
    const store = createMapDesignConfigStore(root);
    store.update({ byokProviders: { anthropic: { protocol: 'anthropic', apiKey: 'secret-key' } } });
    const previous = readFileSync(file, 'utf8');
    const failing = createMapDesignConfigStore(root, {
      rename: () => { throw new Error('rename failure'); },
    });
    expect(() => failing.update({ agentId: 'claude' })).toThrow(/unable to write/i);
    expect(readFileSync(file, 'utf8')).toBe(previous);
    try { failing.update({ agentId: 'claude' }); } catch (error) { expect(String(error)).not.toContain('secret-key'); }
  });
});

it('persists a bounded API response format without altering the saved secret', () => {
  const store = createMapDesignConfigStore(tempRoot());
  const provider = { protocol: 'openai' as const, apiKey: 'private-test-key', model: 'test-model', apiFormat: 'responses' as const };
  expect(store.update({ byokProviders: { default: provider } }).byokProviders?.default).toEqual(provider);
  expect(() => store.update({ byokProviders: { default: { ...provider, apiFormat: 'invalid' as never } } })).toThrow();
  expect(store.read().byokProviders?.default).toEqual(provider);
});
