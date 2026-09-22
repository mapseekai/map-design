import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { afterEach, expect, it, vi } from 'vitest';

import { startServer } from '../../apps/daemon/src/server.js';
import { AGENT_DEFS } from '../../apps/daemon/src/runtimes/registry.js';
import type { RuntimeAgentDef } from '../../apps/daemon/src/runtimes/types.js';
import { createCodexMapAgentAdapter } from '../../apps/daemon/src/map-design/agents/codex-app-server.js';
import { createOhMyPiMapAgentAdapter } from '../../apps/daemon/src/map-design/agents/omp-rpc.js';
import { createPiMapAgentAdapter } from '../../apps/daemon/src/map-design/agents/pi-sdk.js';
import { createOpenCodeMapAgentAdapter } from '../../apps/daemon/src/map-design/agents/opencode-plugin.js';
import { createDeepSeekHarnessMapAgentAdapter } from '../../apps/daemon/src/map-design/agents/deepseek-profile.js';
import type { MapAgentAdapter } from '../../apps/daemon/src/map-design/agents/types.js';
import { nativeMapToolDefinitions } from '../../apps/daemon/src/map-design/tools/model-tool-definitions.js';
import { spawnAgentProcess } from '../../apps/daemon/src/runtimes/spawn.js';
import { collectProcessTreePids, listProcessSnapshots } from '../../packages/platform/src/process.js';
import { createFakeMapAcpRuntime, type FakeMapAgentId } from '../lib/playwright/fake-map-acp-runtime.js';

const roots: string[] = [];
const agentIds = ['codex', 'oh-my-pi', 'pi', 'opencode', 'deepseek-harness'] as const;

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 20,
  })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'map native launch '));
  roots.push(root);
  const fake = await createFakeMapAcpRuntime({ root });
  for (const [key, value] of Object.entries(fake.env)) vi.stubEnv(key, value);
  vi.stubEnv('PATH', [root, dirname(process.execPath), ...(process.env.SystemRoot
    ? [join(process.env.SystemRoot, 'System32')] : ['/usr/bin', '/bin'])].join(delimiter));
  vi.stubEnv('MAP_DESIGN_DATA_DIR', join(root, 'data'));
  vi.stubEnv('MAP_DESIGN_AGENT_HOME', root);
  vi.stubEnv('MAP_DESIGN_DISABLE_API_AUTH', '1');
  return { root, fake };
}

function adapter(agentId: FakeMapAgentId, definition: RuntimeAgentDef, root: string): MapAgentAdapter {
  const common = { definition, probeCwd: process.cwd(), probeTimeoutMs: 5_000 };
  switch (agentId) {
    case 'codex': return createCodexMapAgentAdapter({
      ...common,
      nativeToolRegistry: {
        definitions: nativeMapToolDefinitions,
        call: async () => { throw new Error('A capability probe must not execute a map tool.'); },
      },
    });
    case 'oh-my-pi': return createOhMyPiMapAgentAdapter({ ...common, toolDefinitions: nativeMapToolDefinitions });
    case 'pi': return createPiMapAgentAdapter({ ...common, toolDefinitions: nativeMapToolDefinitions, extensionRoot: root });
    case 'opencode': return createOpenCodeMapAgentAdapter({ ...common, toolDefinitions: nativeMapToolDefinitions, pluginRoot: root });
    case 'deepseek-harness': return createDeepSeekHarnessMapAgentAdapter({ ...common, toolDefinitions: nativeMapToolDefinitions, profileRoot: root });
  }
}

it.each(agentIds)('probes %s through its default launcher with a real executable in a spaced path', async (agentId) => {
  const { fake, root } = await fixture();
  const definition = AGENT_DEFS.find((candidate) => candidate.id === agentId);
  if (!definition) throw new Error(`Missing native agent definition: ${agentId}`);
  const native = adapter(agentId, { ...definition, bin: fake.executables[agentId] }, root);
  await expect(native.probeNativeMapTools?.()).resolves.toBe(true);
}, 30_000);

it('publishes all five native capabilities through the real daemon catalogue', async () => {
  const { fake } = await fixture();
  const daemon = await startServer({ port: 0, host: '127.0.0.1', returnServer: true, mcpCliPath: fake.env.MAP_DESIGN_MCP_CLI_PATH });
  try {
    const response = await fetch(`${daemon.url}/api/agents`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      agents: expect.arrayContaining(agentIds.map((id) => expect.objectContaining({
        id, available: true, mapDesign: expect.objectContaining({ nativeMapTools: true }),
      }))),
    });
  } finally {
    await daemon.shutdown();
    await new Promise<void>((resolve, reject) => daemon.server.close((error) => error ? reject(error) : resolve()));
  }
}, 60_000);

it.runIf(process.platform === 'win32')('cancels a persistent Codex command tree before fixture teardown', async () => {
  const inventoryPath = process.env.PATH;
  const { fake, root } = await fixture();
  const definition = AGENT_DEFS.find((candidate) => candidate.id === 'codex');
  if (!definition) throw new Error('Missing Codex definition.');
  const children: ChildProcessWithoutNullStreams[] = [];
  const native = createCodexMapAgentAdapter({
    definition: { ...definition, bin: fake.executables.codex },
    nativeToolRegistry: {
      definitions: nativeMapToolDefinitions,
      call: async () => { throw new Error('The waiting fixture must not call a tool.'); },
    },
    spawn: (command, args, options) => {
      const child = spawnAgentProcess(command, args, options);
      children.push(child);
      return child;
    },
  });
  const handle = await native.startMapRun({
    runId: 'windows-cancel', projectId: 'fixture-project', conversationId: 'fixture-conversation',
    prompt: 'Improve road hierarchy', resumePrompt: 'Improve road hierarchy', cwd: root,
    model: null, reasoning: null, serviceTier: null,
    toolRuntime: {
      execute: async () => { throw new Error('The waiting fixture must not call a tool.'); },
      closeRun: () => undefined,
    },
    toolCallback: { url: 'http://127.0.0.1:1/unused', token: 'fixture-only', close: () => undefined },
    signal: new AbortController().signal,
  }, [...nativeMapToolDefinitions()], () => undefined);
  try {
    vi.stubEnv('PATH', inventoryPath);
    const pids = collectProcessTreePids(await listProcessSnapshots(), children.map((child) => child.pid));
    expect(pids.length).toBeGreaterThanOrEqual(2);
    await handle.cancel();
    await expect(handle.done).resolves.toEqual({ status: 'canceled' });
    for (const pid of pids) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
    await rm(root, { recursive: true, force: true });
  } finally {
    await handle.cancel();
  }
}, 30_000);
