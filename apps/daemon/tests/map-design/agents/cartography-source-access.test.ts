import { expect, it } from 'vitest';
import { createCartographySourceAccess } from '../../../src/map-design/agents/cartography-source-access.js';
import {
  RUN_TOOL_CALLBACK_AGENT_HEADER, RUN_TOOL_CALLBACK_CONVERSATION_HEADER, RUN_TOOL_CALLBACK_PROJECT_HEADER,
  RUN_TOOL_CALLBACK_RUN_HEADER, RUN_TOOL_CALLBACK_TOOL_USE_HEADER,
} from '../../../src/map-design/agents/tool-callback.js';

const scope = { runId: 'run', projectId: 'project', conversationId: 'conversation', agentId: 'omp',
  sources: [{ fileName: 'source/document-1.json', content: '{"original":true}' }] };

it('serves exact source content through the native runtime and rejects other run authority', async () => {
  const signal = new AbortController().signal;
  const access = await createCartographySourceAccess({ ...scope, signal });
  const call = { ...scope, signal, name: 'read_cartography_source' as const, toolUseId: 'read',
    input: { fileName: 'source/document-1.json' } };
  try {
    const result = await access.toolRuntime.execute(call);
    expect(result).toMatchObject({ ok: true, modelContent: expect.stringContaining('original') });
    expect(await access.toolRuntime.execute({ ...call, runId: 'another' })).toMatchObject({ ok: false, error: { code: 'RUN_NOT_AUTHORIZED' } });
    expect(await access.toolRuntime.execute({ ...call, name: 'map_apply_transaction' })).toMatchObject({ ok: false, error: { code: 'RUN_NOT_AUTHORIZED' } });
  } finally { access.toolCallback.close(); }
});

it('rejects source access after cancellation', async () => {
  const controller = new AbortController();
  const access = await createCartographySourceAccess({ ...scope, signal: controller.signal });
  controller.abort();
  expect(await access.toolRuntime.execute({ ...scope, signal: new AbortController().signal,
    name: 'read_cartography_source', toolUseId: 'late', input: { fileName: 'source/document-1.json' } }))
    .toMatchObject({ ok: false, error: { code: 'CANCELED' } });
  await expect(fetch(access.toolCallback.url)).rejects.toThrow();
});

it('rejects unauthenticated, malformed and oversized source callback requests', async () => {
  const access = await createCartographySourceAccess({ ...scope, signal: new AbortController().signal });
  const url = `${access.toolCallback.url}/read_cartography_source`;
  const headers = { authorization: `Bearer ${access.toolCallback.token}`, 'content-type': 'application/json',
    [RUN_TOOL_CALLBACK_RUN_HEADER]: scope.runId, [RUN_TOOL_CALLBACK_PROJECT_HEADER]: scope.projectId,
    [RUN_TOOL_CALLBACK_CONVERSATION_HEADER]: scope.conversationId, [RUN_TOOL_CALLBACK_AGENT_HEADER]: scope.agentId,
    [RUN_TOOL_CALLBACK_TOOL_USE_HEADER]: 'read' };
  try {
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers, body: '{' })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ fileName: 'x'.repeat(5000) }) })).status).toBe(413);
  } finally { access.toolCallback.close(); }
});
