import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createLocalAgentRegistry } from '../../../src/map-design/application/local-agent-registry.js';
import type { MapRunInput } from '../../../src/map-design/agents/types.js';
import type { MapDesignNativeToolRegistry } from '../../../src/map-design/tools/tool-context.js';
import { AGENT_DEFS } from '../../../src/runtimes/registry.js';

describe('local MapDesign agent registry', () => {
  it('projects every canonical runtime definition in canonical order', () => {
    const registry = createLocalAgentRegistry({ stageSkill: async () => undefined });

    expect(registry.list().map((agent) => agent.id)).toEqual(AGENT_DEFS.map((agent) => agent.id));
    expect(registry.list().every((agent) => typeof agent.mapDesign.nativeMapTools === 'boolean')).toBe(true);
    expect(registry.list().every((agent) => typeof agent.mapDesign.publicReasoningSummary === 'boolean')).toBe(true);
    expect(registry.get('amr')).toBeNull();
  });

  it('keeps a canonical local profile visible as unsupported without a concrete native adapter', () => {
    const registry = createLocalAgentRegistry({
      definitions: [{
        id: 'local-profile',
        name: 'Local Profile',
        bin: 'node',
        versionArgs: ['--version'],
        fallbackModels: [],
        streamFormat: 'plain',
        buildArgs: () => [],
      }],
      stageSkill: async () => undefined,
    });

    expect(registry.list()).toMatchObject([{
      id: 'local-profile',
      available: true,
      mapDesign: {
        nativeMapTools: false,
        publicReasoningSummary: false,
        reason: 'native-tools-unavailable',
      },
    }]);
    expect(registry.get('local-profile')).toMatchObject({ id: 'local-profile' });
    expect(registry.getMapAgent?.('local-profile')).toBeNull();
  });
  it('marks a retained runtime unavailable when its executable cannot be resolved', () => {
    const registry = createLocalAgentRegistry({
      definitions: [{
        id: 'claude',
        name: 'Claude',
        bin: '__map_design_missing_claude__',
        versionArgs: ['--version'],
        fallbackModels: [],
        streamFormat: 'plain',
        buildArgs: () => [],
      }],
      stageSkill: async () => undefined,
    });

    expect(registry.list()).toMatchObject([{
      id: 'claude',
      available: false,
      mapDesign: {
        nativeMapTools: false,
        publicReasoningSummary: false,
        reason: 'agent-unavailable',
      },
    }]);
    expect(registry.get('claude')).toBeNull();
  });

  it('advertises Codex native Map tools only after a successful app-server protocol probe', async () => {
    const definition = {
      id: 'codex',
      name: 'Codex',
      bin: process.execPath,
      versionArgs: ['--version'],
      fallbackModels: [],
      streamFormat: 'json-event-stream',
      eventParser: 'codex',
      buildArgs: () => ['exec'],
      mapDesign: {
        nativeToolAdapter: 'codex-app-server' as const,
        publicReasoningSummary: true,
      },
    };
    const nativeToolRegistry: MapDesignNativeToolRegistry = {
      definitions: () => [{
        name: 'map_inspect',
        description: 'Inspect the map.',
        inputSchema: { type: 'object' },
      }],
      call: async () => ({
        ok: false,
        toolUseId: 'call-1',
        error: { code: 'UNKNOWN_TOOL', message: 'The map tool is not registered.', retryable: false },
      }),
    };
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit('close', null));
        return true;
      }),
    });
    let input = '';
    const probeThreadStarts: Array<Record<string, unknown>> = [];
    stdin.on('data', (chunk: Buffer | string) => {
      input += String(chunk);
      while (input.includes('\n')) {
        const newline = input.indexOf('\n');
        const frame = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
        input = input.slice(newline + 1);
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
          probeThreadStarts.push(frame);
          stdout.write(`${JSON.stringify({ id: frame.id, result: { thread: { id: 'thread-1' } } })}\n`);
        } else if (frame.method === 'turn/start') {
          stdout.write(`${JSON.stringify({ id: frame.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })}\n`);
          queueMicrotask(() => stdout.write(`${JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
          })}\n`));
        }
      }
    });
    const spawn = vi.fn(() => child);
    const supported = createLocalAgentRegistry({
      definitions: [definition],
      nativeToolRegistry,
      config: { read: () => ({ agentCliEnv: { codex: { CODEX_BIN: process.execPath } } }) },
      spawn,
      stageSkill: async () => undefined,
    });
    const unsupported = createLocalAgentRegistry({
      definitions: [definition],
      config: { read: () => ({ agentCliEnv: { codex: { CODEX_BIN: process.execPath } } }) },
      stageSkill: async () => undefined,
    });

    expect(supported.list()).toMatchObject([{
      id: 'codex',
      available: true,
      mapDesign: {
        nativeMapTools: false,
        publicReasoningSummary: true,
        reason: 'native-tools-unavailable',
      },
    }]);
    await (supported as unknown as { probeNativeMapTools(): Promise<void> }).probeNativeMapTools();
    expect(probeThreadStarts).toMatchObject([{
      method: 'thread/start',
      params: {
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        dynamicTools: [{
          type: 'namespace',
          name: 'map-design',
          tools: [{ type: 'function', name: 'map_inspect' }],
        }],
      },
    }]);
    expect(supported.list()).toMatchObject([{
      id: 'codex',
      available: true,
      mapDesign: {
        nativeMapTools: true,
        publicReasoningSummary: true,
      },
    }]);
    const adapter = supported.getMapAgent?.('codex');
    expect(adapter).toMatchObject({
      id: 'codex',
      capabilities: { nativeMapTools: true, publicReasoningSummary: true },
    });
    expect(unsupported.list()).toMatchObject([{
      id: 'codex',
      available: true,
      mapDesign: {
        nativeMapTools: false,
        publicReasoningSummary: true,
        reason: 'native-tools-unavailable',
      },
    }]);
    expect(unsupported.getMapAgent?.('codex')).toBeNull();

    const events: Array<{ kind: string }> = [];
    const handle = await adapter!.startMapRun({
      runId: 'run-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      prompt: 'Inspect the map.',
      resumePrompt: 'Inspect the map.',
      cwd: '/safe/project',
      model: null,
      reasoning: null,
      serviceTier: null,
      toolRuntime: {
        execute: async (call) => ({
          ok: false,
          toolUseId: call.toolUseId,
          error: { code: 'UNKNOWN_TOOL', message: 'The map tool call is not registered.', retryable: false },
        }),
        closeRun: () => undefined,
      },
      toolCallback: {
        url: 'http://127.0.0.1:8787/api/map-design/tools',
        token: 'test-only-token',
        close: () => undefined,
      },
      signal: new AbortController().signal,
    }, [], (event) => events.push(event));
    await expect(handle.done).resolves.toEqual({ status: 'succeeded' });
    expect(spawn).toHaveBeenCalledWith(process.execPath, ['app-server', '--stdio'], expect.objectContaining({ cwd: '/safe/project' }));
    expect(events).toEqual([
      { kind: 'status', label: 'analyzing' },
      { kind: 'run_finished', status: 'succeeded' },
    ]);
  });

  it('shares Codex session history across recreated production adapter instances', async () => {
    const definition = {
      id: 'codex',
      name: 'Codex',
      bin: process.execPath,
      versionArgs: ['--version'],
      fallbackModels: [],
      streamFormat: 'json-event-stream',
      eventParser: 'codex',
      buildArgs: () => ['exec'],
      mapDesign: { nativeToolAdapter: 'codex-app-server' as const, publicReasoningSummary: true },
    };
    const makeChild = (threadId: string) => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const methods: string[] = [];
      const turnInputs: unknown[] = [];
      const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr,
        kill: vi.fn(() => {
          queueMicrotask(() => child.emit('close', null));
          return true;
        }),
      });
      let buffer = '';
      stdin.on('data', (chunk: Buffer | string) => {
        buffer += String(chunk);
        while (buffer.includes('\n')) {
          const newline = buffer.indexOf('\n');
          const frame = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
          buffer = buffer.slice(newline + 1);
          methods.push(String(frame.method));
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
          } else if (frame.method === 'thread/start' || frame.method === 'thread/resume') {
            stdout.write(`${JSON.stringify({ id: frame.id, result: { thread: { id: threadId } } })}\n`);
          } else if (frame.method === 'turn/start') {
            const params = frame.params as { input?: unknown; threadId?: string };
            turnInputs.push(params.input);
            stdout.write(`${JSON.stringify({ id: frame.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })}\n`);
            queueMicrotask(() => stdout.write(`${JSON.stringify({
              method: 'turn/completed',
              params: { threadId: params.threadId, turn: { id: 'turn-1', status: 'completed' } },
            })}\n`));
          }
        }
      });
      return { child, methods, turnInputs };
    };
    const probe = makeChild('probe-thread');
    const first = makeChild('codex-session-1');
    const second = makeChild('codex-session-1');
    const children = [probe, first, second];
    const registry = createLocalAgentRegistry({
      definitions: [definition],
      nativeToolRegistry: {
        definitions: () => [],
        call: vi.fn(),
      },
      config: { read: () => ({ agentCliEnv: { codex: { CODEX_BIN: process.execPath } } }) },
      spawn: () => children.shift()!.child,
      stageSkill: async () => undefined,
    });
    await registry.probeNativeMapTools();
    const input = (runId: string, prompt: string, resumePrompt: string): MapRunInput => ({
      runId,
      projectId: 'project-1',
      conversationId: 'conversation-1',
      prompt,
      resumePrompt,
      cwd: '/safe/project',
      model: null,
      reasoning: null,
      serviceTier: null,
      toolRuntime: { execute: vi.fn(), closeRun: vi.fn() },
      toolCallback: {
        url: 'http://127.0.0.1:8787/api/map-design/tools',
        token: 'test-only-token',
        close: vi.fn(),
      },
      signal: new AbortController().signal,
    } as MapRunInput);

    const firstAdapter = registry.getMapAgent?.('codex');
    const firstHandle = await firstAdapter!.startMapRun(
      input('run-1', 'FULL FIRST TRANSCRIPT', 'first latest'),
      [],
      () => undefined,
    );
    await firstHandle.done;
    const secondAdapter = registry.getMapAgent?.('codex');
    expect(secondAdapter).not.toBe(firstAdapter);
    const secondHandle = await secondAdapter!.startMapRun(
      input('run-2', 'FULL SECOND TRANSCRIPT', 'second latest only'),
      [],
      () => undefined,
    );
    await secondHandle.done;

    expect(first.methods).toContain('thread/start');
    expect(second.methods).toContain('thread/resume');
    expect(second.methods).not.toContain('thread/start');
    expect(second.turnInputs).toEqual([[{ type: 'text', text: 'second latest only' }]]);
  });

  it('caches a failed Codex app-server probe as unsupported', async () => {
    const definition = {
      id: 'codex',
      name: 'Codex',
      bin: process.execPath,
      versionArgs: ['--version'],
      fallbackModels: [],
      streamFormat: 'json-event-stream',
      eventParser: 'codex',
      buildArgs: () => ['exec'],
      mapDesign: { nativeToolAdapter: 'codex-app-server' as const, publicReasoningSummary: true },
    };
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit('close', null));
        return true;
      }),
    });
    stdin.once('data', (chunk: Buffer | string) => {
      const frame = JSON.parse(String(chunk)) as Record<string, unknown>;
      stdout.write(`${JSON.stringify({ id: frame.id, result: { userAgent: 'not-an-app-server' } })}\n`);
    });
    const spawn = vi.fn(() => child);
    const registry = createLocalAgentRegistry({
      definitions: [definition],
      nativeToolRegistry: {
        definitions: () => [],
        call: async () => ({
          ok: false,
          toolUseId: 'call-1',
          error: { code: 'UNKNOWN_TOOL', message: 'The map tool is not registered.', retryable: false },
        }),
      },
      config: { read: () => ({ agentCliEnv: { codex: { CODEX_BIN: process.execPath } } }) },
      spawn,
      nativeToolProbeTimeoutMs: 5,
      stageSkill: async () => undefined,
    });

    await registry.probeNativeMapTools();
    await registry.probeNativeMapTools();

    expect(registry.list()).toMatchObject([{
      id: 'codex',
      available: true,
      mapDesign: {
        nativeMapTools: false,
        publicReasoningSummary: true,
        reason: 'native-tools-unavailable',
      },
    }]);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('caches an unsupported verdict when app-server rejects the offered dynamic tools after initialize', async () => {
    const definition = {
      id: 'codex',
      name: 'Codex',
      bin: process.execPath,
      versionArgs: ['--version'],
      fallbackModels: [],
      streamFormat: 'json-event-stream',
      eventParser: 'codex',
      buildArgs: () => ['exec'],
      mapDesign: { nativeToolAdapter: 'codex-app-server' as const, publicReasoningSummary: true },
    };
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit('close', null));
        return true;
      }),
    });
    let input = '';
    const methods: string[] = [];
    stdin.on('data', (chunk: Buffer | string) => {
      input += String(chunk);
      while (input.includes('\n')) {
        const newline = input.indexOf('\n');
        const frame = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
        input = input.slice(newline + 1);
        methods.push(String(frame.method));
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
          stdout.write(`${JSON.stringify({
            id: frame.id,
            error: { code: -32_000, message: 'dynamic tools unavailable' },
          })}\n`);
        }
      }
    });
    const spawn = vi.fn(() => child);
    const registry = createLocalAgentRegistry({
      definitions: [definition],
      nativeToolRegistry: {
        definitions: () => [{ name: 'map_inspect', description: 'Inspect the map.', inputSchema: { type: 'object' } }],
        call: vi.fn(),
      },
      config: { read: () => ({ agentCliEnv: { codex: { CODEX_BIN: process.execPath } } }) },
      spawn,
      stageSkill: async () => undefined,
    });

    await registry.probeNativeMapTools();
    await registry.probeNativeMapTools();

    expect(methods).toContain('thread/start');
    expect(registry.list()).toMatchObject([{
      id: 'codex',
      available: true,
      mapDesign: {
        nativeMapTools: false,
        reason: 'native-tools-unavailable',
      },
    }]);
    expect(registry.getMapAgent?.('codex')).toBeNull();
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('binds Codex native support to the currently resolved executable path', async () => {
    const definition = {
      id: 'codex',
      name: 'Codex',
      bin: process.execPath,
      versionArgs: ['--version'],
      fallbackModels: [],
      streamFormat: 'json-event-stream',
      eventParser: 'codex',
      buildArgs: () => ['exec'],
      mapDesign: { nativeToolAdapter: 'codex-app-server' as const, publicReasoningSummary: true },
    };
    const makeProbeChild = () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        kill: vi.fn(() => {
          queueMicrotask(() => child.emit('close', null));
          return true;
        }),
      });
      let input = '';
      stdin.on('data', (chunk: Buffer | string) => {
        input += String(chunk);
        while (input.includes('\n')) {
          const newline = input.indexOf('\n');
          const frame = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
          input = input.slice(newline + 1);
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
      return child;
    };
    let configuredBin = process.execPath;
    const alternateBin = process.platform === 'win32'
      ? process.env.COMSPEC ?? process.execPath
      : '/bin/sh';
    const spawn = vi.fn(() => makeProbeChild());
    const registry = createLocalAgentRegistry({
      definitions: [definition],
      nativeToolRegistry: {
        definitions: () => [{ name: 'map_inspect', description: 'Inspect the map.', inputSchema: { type: 'object' } }],
        call: vi.fn(),
      },
      config: { read: () => ({ agentCliEnv: { codex: { CODEX_BIN: configuredBin } } }) },
      spawn,
      stageSkill: async () => undefined,
    });

    await registry.probeNativeMapTools();
    expect(registry.list()).toMatchObject([{ id: 'codex', mapDesign: { nativeMapTools: true } }]);
    expect(registry.getMapAgent?.('codex')).not.toBeNull();

    configuredBin = alternateBin;
    expect(registry.list()).toMatchObject([{
      id: 'codex',
      available: true,
      mapDesign: { nativeMapTools: false, reason: 'native-tools-unavailable' },
    }]);
    expect(registry.getMapAgent?.('codex')).toBeNull();

    await registry.probeNativeMapTools();
    expect(registry.list()).toMatchObject([{ id: 'codex', mapDesign: { nativeMapTools: true } }]);
    expect(registry.getMapAgent?.('codex')).not.toBeNull();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('retains ACP MCP env and turn-end compatibility fields at the MapDesign boundary', () => {
    const registry = createLocalAgentRegistry({
      definitions: [{
        id: 'kiro',
        name: 'Kiro',
        bin: 'node',
        versionArgs: ['--version'],
        fallbackModels: [],
        streamFormat: 'acp-json-rpc',
        acpMcpEnvFormat: 'map',
        acpTurnEndCompletesPrompt: true,
        buildArgs: () => ['acp'],
      }],
      stageSkill: async () => undefined,
    });

    expect(registry.get('kiro')).toMatchObject({
      acpMcpEnvFormat: 'map',
      acpTurnEndCompletesPrompt: true,
    });
    expect(registry.list()).toMatchObject([{
      acpMcpEnvFormat: 'map',
      acpTurnEndCompletesPrompt: true,
      available: true,
    }]);
  });

  it('uses the request provider over persisted BYOK config and keeps its effective model consistent', () => {
    const persisted = { protocol: 'anthropic' as const, apiKey: 'persisted-secret', model: 'persisted-model' };
    const request = { protocol: 'openai' as const, apiKey: 'request-secret', model: 'request-provider-model' };
    const registry = createLocalAgentRegistry({
      definitions: [{ id: 'byok-opencode', name: 'BYOK OpenCode', bin: process.execPath, versionArgs: ['--version'], fallbackModels: [], streamFormat: 'json-event-stream', buildArgs: () => [] }],
      config: { read: () => ({ agentCliEnv: { opencode: { OPENCODE_BIN: process.execPath } }, byokProviders: { persisted } }) },
      stageSkill: async () => undefined,
    });

    const requestEnv = registry.launchEnv('byok-opencode', { byokProvider: request, model: 'requested-model' });
    const persistedEnv = registry.launchEnv('byok-opencode', { model: 'persisted-model' });

    expect(requestEnv?.MAP_DESIGN_BYOK_API_KEY).toBe('request-secret');
    expect(requestEnv?.OPENCODE_CONFIG_CONTENT).toContain('requested-model');
    expect(requestEnv?.OPENCODE_CONFIG_CONTENT).not.toContain('persisted-secret');
    expect(persistedEnv?.MAP_DESIGN_BYOK_API_KEY).toBe('persisted-secret');
    expect(persistedEnv?.OPENCODE_CONFIG_CONTENT).toContain('persisted-model');
  });

  it('does not launch BYOK OpenCode without a selected provider', () => {
    const registry = createLocalAgentRegistry({
      definitions: [{ id: 'byok-opencode', name: 'BYOK OpenCode', bin: process.execPath, versionArgs: ['--version'], fallbackModels: [], streamFormat: 'json-event-stream', buildArgs: () => [] }],
      config: { read: () => ({ agentCliEnv: { opencode: { OPENCODE_BIN: process.execPath } } }) },
      stageSkill: async () => undefined,
    });

    expect(registry.launchEnv('byok-opencode', { model: 'requested-model' })).toBeNull();
  });

  it('sanitizes daemon-private values after Agent config merges while retaining provider credentials', () => {
    vi.stubEnv('PATH', '/safe/bin');
    vi.stubEnv('HOME', '/safe/home');
    vi.stubEnv('TMPDIR', '/safe/tmp');
    vi.stubEnv('LANG', 'en_US.UTF-8');
    vi.stubEnv('OPENAI_API_KEY', 'ambient-provider-secret');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'ambient-aws-secret');
    vi.stubEnv('DATABASE_URL', 'postgres://ambient-secret');
    vi.stubEnv('ARBITRARY_CUSTOM_SECRET', 'ambient-custom-secret');
    try {
      const registry = createLocalAgentRegistry({
        definitions: [{
          id: 'opencode',
          name: 'OpenCode',
          bin: process.execPath,
          fallbackBins: [],
          versionArgs: ['--version'],
          fallbackModels: [{ id: 'provider/model', label: 'Model', default: true }],
          buildArgs: () => ['run'],
          streamFormat: 'opencode-json',
          inheritedEnvKeys: ['OPENAI_API_KEY'],
          mapDesign: { nativeToolAdapter: 'opencode-plugin', publicReasoningSummary: false },
        }],
        config: {
          read: () => ({
            agentCliEnv: {
              opencode: {
                OPENCODE_BIN: process.execPath,
                EXPLICIT_AGENT_CREDENTIAL: 'configured-secret',
                MAP_DESIGN_API_TOKEN: 'daemon-api-secret',
                MAP_DESIGN_DATA_DIR: '/private/daemon-data',
                MAP_DESIGN_TOOL_CALLBACK_TOKEN: 'stale-callback-token',
                MAP_DESIGN_TOOL_TOKEN: 'stale-tool-token',
                MAP_DESIGN_RUN_ID: 'stale-run',
                MAP_DESIGN_PROJECT_ID: 'stale-project',
                MAP_DESIGN_CONVERSATION_ID: 'stale-conversation',
                MAP_DESIGN_AGENT_ID: 'stale-agent',
                MAP_DESIGN_PLUGIN_PROBE_PATH: '/private/stale-probe',
                MAP_DESIGN_PROFILE_PROBE_TOOLS: 'stale-tools',
                DSH_HOME: '/private/stale-profile-home',
              },
            },
          }),
        },
        stageSkill: async () => undefined,
      });

      const environment = registry.launchEnv('opencode', { model: 'provider/model' });

      expect(environment).toMatchObject({
        HOME: '/safe/home',
        TMPDIR: '/safe/tmp',
        LANG: 'en_US.UTF-8',
        OPENAI_API_KEY: 'ambient-provider-secret',
        EXPLICIT_AGENT_CREDENTIAL: 'configured-secret',
      });
      expect(environment?.PATH).toContain('/safe/bin');
      expect(environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
      expect(environment).not.toHaveProperty('DATABASE_URL');
      expect(environment).not.toHaveProperty('ARBITRARY_CUSTOM_SECRET');
      expect(Object.keys(environment ?? {}).filter((key) => key.startsWith('MAP_DESIGN_'))).toEqual([]);
      expect(environment).not.toHaveProperty('DSH_HOME');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

it('makes the API runtime available without any CLI probe or subprocess', async () => {
  const { apiAgentDef } = await import('../../../src/runtimes/defs/api.js');
  const registry = createLocalAgentRegistry({ definitions: [apiAgentDef], nativeToolRegistry: { definitions: () => [], call: vi.fn() } });
  await registry.probeNativeMapTools();
  await registry.runtimeCatalog.refresh();
  expect(registry.get('api')?.id).toBe('api');
  expect(registry.getMapAgent?.('api')?.capabilities.nativeMapTools).toBe(true);
  expect(registry.runtimeCatalog.list()).toMatchObject([{ id: 'api', available: true, version: 'AI SDK', mapDesign: { nativeMapTools: true } }]);
  expect(registry.runtimeCatalog.resolveChoice('api', { agentId: 'api' }).adapter).toBe('ai-sdk');
});
