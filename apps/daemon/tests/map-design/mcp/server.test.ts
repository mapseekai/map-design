import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MAP_TOOL_NAMES } from '@mapseekai/map-design-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMapDesignMcpServer } from '../../../src/map-design/mcp/server.js';
import { createMapToolHttpClient } from '../../../src/map-design/mcp/map-tool-client.js';

describe('MapDesign MCP server', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
  });

  it('registers the canonical nine MapDesign tools in order', async () => {
    const { client } = await connect(vi.fn());

    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual(MAP_TOOL_NAMES);
  });

  it('forwards one validated call and returns text plus structured content', async () => {
    const envelope = {
      ok: true as const,
      data: { layers: [], returned: 0, truncated: false },
      meta: { requestId: 'request-1', projectId: 'project-1', runId: 'run-1' },
    };
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(envelope));
    const { client } = await connect(request);

    const result = await client.callTool({ name: 'map_search_layers', arguments: { query: 'road' } });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8787/api/map-design/tools/map_search_layers');
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer run-token' },
      body: JSON.stringify({ query: 'road', limit: 25 }),
    });
    expect(result).toMatchObject({
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
      structuredContent: envelope,
    });
    expect(result.isError).not.toBe(true);
  });

  it('rejects invalid input without forwarding it to the daemon', async () => {
    const request = vi.fn<typeof fetch>();
    const { client } = await connect(request);

    const result = await client.callTool({ name: 'map_validate', arguments: { expectedRevision: -1 } });

    expect(request).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it('returns validated daemon error envelopes as safe tool errors', async () => {
    const envelope = {
      ok: false as const,
      error: { code: 'REVISION_CONFLICT' as const, message: 'The draft changed.', retryable: true },
      meta: { requestId: 'request-2', projectId: 'project-1', runId: 'run-1', draftRevision: 5 },
    };
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(envelope));
    const { client } = await connect(request);

    const result = await client.callTool({ name: 'map_validate', arguments: { expectedRevision: 4 } });

    expect(result).toMatchObject({ isError: true, structuredContent: envelope });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(envelope) }]);
  });

  it('keeps the request deadline active while reading the daemon envelope', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
      }),
    ));
    const client = createMapToolHttpClient({
      daemonUrl: 'http://127.0.0.1:8787',
      token: 'run-token',
      fetch: request,
      timeoutMs: 10,
    });

    await expect(client.call('map_get_context', {})).rejects.toMatchObject({ kind: 'transport' });
  }, 250);

  it('rejects oversized validated input before forwarding it to the daemon', async () => {
    const request = vi.fn<typeof fetch>();
    const client = createMapToolHttpClient({
      daemonUrl: 'http://127.0.0.1:8787',
      token: 'run-token',
      fetch: request,
    });

    await expect(client.call('map_apply_transaction', {
      expectedRevision: 4,
      idempotencyKey: 'request-oversized',
      transaction: { payload: 'x'.repeat(1_100_000) },
      intentSummary: 'Exercise the request boundary.',
    })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 120_001])(
    'rejects an unsafe request timeout of %s',
    (timeoutMs) => {
      expect(() => createMapToolHttpClient({
        daemonUrl: 'http://127.0.0.1:8787',
        token: 'run-token',
        timeoutMs,
      })).toThrow(expect.objectContaining({ kind: 'transport' }));
    },
  );

  async function connect(request: typeof fetch) {
    const server = createMapDesignMcpServer({
      daemonUrl: 'http://127.0.0.1:8787',
      token: 'run-token',
      fetch: request,
    });
    const client = new Client({ name: 'map-design-mcp-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => {
      await client.close();
      await server.close();
    });
    return { client };
  }
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
