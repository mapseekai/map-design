import { type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  API_TOKEN_BASIC_CHALLENGE,
  apiTokenAuthorizationMatches,
  isApiAuthDisabled,
  isApiTokenMiddlewareEnabled,
} from '../src/api-token-auth.js';
import { startServer } from '../src/server.js';
import { createMapDesignConfigStore } from '../src/map-design/storage/config-store.js';
import { closeMapDesignDatabase, openMapDesignDatabase } from '../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../src/map-design/storage/local-store.js';

const PREVIOUS_TOKEN = process.env.MAP_DESIGN_API_TOKEN;
const PREVIOUS_DISABLE_API_AUTH = process.env.MAP_DESIGN_DISABLE_API_AUTH;
const PREVIOUS_DATA_DIR = process.env.MAP_DESIGN_DATA_DIR;

let server: Server | undefined;
let shutdown: (() => Promise<void> | void) | undefined;
let dataRoot: string | undefined;
let baseUrl = '';

async function startCleanServer(options: { host?: string } = {}): Promise<void> {
  dataRoot = mkdtempSync(join(tmpdir(), 'map-design-api-token-'));
  process.env.MAP_DESIGN_DATA_DIR = dataRoot;
  const started = await startServer({
    port: 0,
    host: options.host ?? '127.0.0.1',
    returnServer: true,
    localAgentSpawn: createCodexOnlySpawn(),
  });
  server = started.server;
  shutdown = started.shutdown;
  baseUrl = started.url;
}

function createCodexOnlySpawn() {
  return (_command: string, args: string[]) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 43_210,
      stdin,
      stdout,
      stderr,
      kill: () => {
        queueMicrotask(() => child.emit('close', null));
        return true;
      },
    });
    stdin.on('data', (chunk: Buffer | string) => {
      for (const line of String(chunk).split('\n')) {
        if (!line) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.method === 'initialize') {
          stdout.write(`${JSON.stringify({
            id: frame.id,
            result: {
              userAgent: 'codex-app-server/test',
              codexHome: '/safe/codex-home',
              platformFamily: 'unix',
              platformOs: 'macos',
            },
          })}\n`);
        } else if (frame.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ id: frame.id, result: { thread: { id: 'probe-thread' } } })}\n`);
        }
      }
    });
    if (args.length !== 2 || args[0] !== 'app-server' || args[1] !== '--stdio') {
      queueMicrotask(() => child.emit('close', 1));
    }
    return child;
  };
}

function makeConnectionsAppearNonLoopback(target: Server): void {
  target.prependListener('connection', (socket) => {
    Object.defineProperty(socket, 'remoteAddress', { configurable: true, value: '172.18.0.1' });
  });
}

afterEach(async () => {
  if (shutdown) await shutdown();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  shutdown = undefined;
  if (dataRoot) rmSync(dataRoot, { force: true, recursive: true });
  dataRoot = undefined;
  baseUrl = '';
  if (PREVIOUS_TOKEN === undefined) delete process.env.MAP_DESIGN_API_TOKEN;
  else process.env.MAP_DESIGN_API_TOKEN = PREVIOUS_TOKEN;
  if (PREVIOUS_DISABLE_API_AUTH === undefined) delete process.env.MAP_DESIGN_DISABLE_API_AUTH;
  else process.env.MAP_DESIGN_DISABLE_API_AUTH = PREVIOUS_DISABLE_API_AUTH;
  if (PREVIOUS_DATA_DIR === undefined) delete process.env.MAP_DESIGN_DATA_DIR;
  else process.env.MAP_DESIGN_DATA_DIR = PREVIOUS_DATA_DIR;
});

describe('bound API token startup guard', () => {
  it('refuses a public bind without a token', async () => {
    delete process.env.MAP_DESIGN_API_TOKEN;
    await expect(startServer({ port: 0, host: '0.0.0.0', returnServer: true })).rejects.toThrow(/MAP_DESIGN_API_TOKEN/);
  });

  it('allows a public bind when a token is configured', async () => {
    process.env.MAP_DESIGN_API_TOKEN = 'test-token-abc';
    await startCleanServer({ host: '0.0.0.0' });
    expect(baseUrl).toMatch(/^http:\/\/0\.0\.0\.0:/);
  });

  it('allows a public bind only when API auth is explicitly disabled', async () => {
    delete process.env.MAP_DESIGN_API_TOKEN;
    process.env.MAP_DESIGN_DISABLE_API_AUTH = '1';
    await startCleanServer({ host: '0.0.0.0' });
  });

  it('starts a Run on a public wildcard bind through a loopback child callback URL', async () => {
    process.env.MAP_DESIGN_API_TOKEN = 'test-token-abc';
    dataRoot = mkdtempSync(join(tmpdir(), 'map-design-public-run-'));
    process.env.MAP_DESIGN_DATA_DIR = dataRoot;
    createMapDesignConfigStore(dataRoot).update({
      agentCliEnv: { codex: { CODEX_BIN: process.execPath } },
    });
    const database = openMapDesignDatabase(dataRoot);
    try {
      createMapDesignLocalStore(database).createProject({
        project: {
          projectId: 'public-map',
          title: 'Public map',
          runtime: { agentId: 'codex' },
          source: { url: 'https://example.test/style.json' },
          designRequirement: 'Keep the map clear.',
          idempotencyKey: 'public-map-create',
        },
        primaryConversationId: 'conversation-public',
        verifiedWorkingDirectory: null,
      });
    } finally {
      closeMapDesignDatabase(database);
    }

    const spawn = createCodexOnlySpawn();
    const unsupported = spawn(process.execPath, ['debug', 'agent', 'build']);
    await expect(new Promise<number | null>((resolve) => unsupported.once('close', resolve)))
      .resolves.toBe(1);

    const started = await startServer({
      port: 0,
      host: '0.0.0.0',
      returnServer: true,
      localAgentSpawn: spawn,
    });
    server = started.server;
    shutdown = started.shutdown;
    baseUrl = started.url.replace('0.0.0.0', '127.0.0.1');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const catalog = await fetch(`${baseUrl}/api/agents`).then((response) => response.json()) as {
        agents: Array<{ id: string; mapDesign: { nativeMapTools: boolean } }>;
      };
      if (catalog.agents.find((agent) => agent.id === 'codex')?.mapDesign.nativeMapTools) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const response = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'public-map',
        conversationId: 'conversation-public',
        prompt: 'Inspect the map.',
        runtimeRevision: 0,
        clientRequestId: 'public-run-request',
        userMessageId: 'public-user',
        assistantMessageId: 'public-assistant',
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      projectId: 'public-map',
      conversationId: 'conversation-public',
    });
  });
});

describe('retained local API request guard', () => {
  beforeEach(async () => {
    process.env.MAP_DESIGN_API_TOKEN = 'secret-test-token';
    await startCleanServer();
  });

  it('allows loopback callers to reach health, map projects, and runs', async () => {
    expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/map-design/projects`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/runs/missing-run`)).status).toBe(404);
  });

  it('accepts a loopback origin and rejects a non-loopback origin', async () => {
    const localOrigin = 'http://localhost:3000';
    const allowed = await fetch(`${baseUrl}/api/health`, { headers: { origin: localOrigin } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(localOrigin);

    const forbidden = await fetch(`${baseUrl}/api/health`, { headers: { origin: 'https://example.com' } });
    expect(forbidden.status).toBe(403);
  });

  it('rejects non-loopback peers even when they provide bearer or basic credentials', async () => {
    if (!server) throw new Error('Expected started server');
    makeConnectionsAppearNonLoopback(server);
    const basic = Buffer.from('map-design:secret-test-token').toString('base64');

    for (const authorization of [`Bearer secret-test-token`, `Basic ${basic}`]) {
      const response = await fetch(`${baseUrl}/api/map-design/projects`, { headers: { authorization } });
      expect(response.status).toBe(403);
    }
  });
});

describe('API token credentials', () => {
  it('accepts bearer and basic token forms while retaining the basic challenge', () => {
    const token = 'secret-test-token';
    const basic = Buffer.from(`map-design:${token}`).toString('base64');
    expect(apiTokenAuthorizationMatches(`Bearer ${token}`, token)).toBe(true);
    expect(apiTokenAuthorizationMatches(`Basic ${basic}`, token)).toBe(true);
    expect(apiTokenAuthorizationMatches('Bearer wrong-token', token)).toBe(false);
    expect(apiTokenAuthorizationMatches(`Basic ${Buffer.from('admin:secret-test-token').toString('base64')}`, token)).toBe(false);
    expect(API_TOKEN_BASIC_CHALLENGE).toBe('Basic realm="MapDesign", charset="UTF-8"');
  });

  it('recognizes an explicit API-auth opt-out', () => {
    expect(isApiTokenMiddlewareEnabled({ ...process.env, MAP_DESIGN_API_TOKEN: 'secret-test-token', MAP_DESIGN_DISABLE_API_AUTH: '1' })).toBe(false);
    expect(isApiAuthDisabled({ ...process.env, MAP_DESIGN_DISABLE_API_AUTH: '1' })).toBe(true);
  });
});
