import { describe, expect, it, vi } from 'vitest';

import { runMapDesignToolCli } from '../src/tools-map-design-cli.js';

describe('MapDesign tool CLI', () => {
  it('preserves the authenticated JSON request and successful envelope output', async () => {
    const envelope = {
      ok: true as const,
      data: { layers: [], returned: 0, truncated: false },
      meta: { requestId: 'request-1', projectId: 'project-1', runId: 'run-1' },
    };
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(envelope));
    const output: string[] = [];

    const result = await runMapDesignToolCli(
      ['map_search_layers', '--input', '-', '--json'],
      {
        fetch: request,
        stdin: input('{"query":"road"}'),
        stdout: { write: (value) => output.push(value) },
        env: { MAP_DESIGN_DAEMON_URL: 'http://127.0.0.1:8787', MAP_DESIGN_TOOL_TOKEN: 'run-token' },
      },
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(output).toEqual([`${JSON.stringify(envelope)}\n`]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8787/api/map-design/tools/map_search_layers');
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer run-token' },
      body: JSON.stringify({ query: 'road', limit: 25 }),
    });
  });

  it('preserves authorization exit code 4 without exposing the token', async () => {
    const output: string[] = [];
    const result = await runMapDesignToolCli(
      ['map_get_context', '--input', '-'],
      {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: 'forbidden' }, 403)),
        stdin: input('{}'),
        stdout: { write: (value) => output.push(value) },
        env: { MAP_DESIGN_DAEMON_URL: 'http://127.0.0.1:8787', MAP_DESIGN_TOOL_TOKEN: 'private-run-token' },
      },
    );

    expect(result).toEqual({ exitCode: 4 });
    expect(JSON.parse(output.join(''))).toMatchObject({
      ok: false,
      error: { code: 'RUN_NOT_AUTHORIZED' },
    });
    expect(output.join('')).not.toContain('private-run-token');
  });

  it('preserves daemon error envelopes and exit code 1', async () => {
    const envelope = {
      ok: false as const,
      error: { code: 'REVISION_CONFLICT' as const, message: 'The draft changed.', retryable: true },
      meta: { requestId: 'request-2', projectId: 'project-1', runId: 'run-1', draftRevision: 5 },
    };
    const output: string[] = [];
    const result = await runMapDesignToolCli(
      ['map_validate', '--input', '-'],
      {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(envelope)),
        stdin: input('{"expectedRevision":4}'),
        stdout: { write: (value) => output.push(value) },
        env: { MAP_DESIGN_DAEMON_URL: 'http://127.0.0.1:8787', MAP_DESIGN_TOOL_TOKEN: 'run-token' },
      },
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(output).toEqual([`${JSON.stringify(envelope)}\n`]);
  });

  it('rejects invalid daemon envelopes with the existing safe failure', async () => {
    const output: string[] = [];
    const result = await runMapDesignToolCli(
      ['map_get_context', '--input', '-'],
      {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('not-json')),
        stdin: input('{}'),
        stdout: { write: (value) => output.push(value) },
        env: { MAP_DESIGN_DAEMON_URL: 'http://127.0.0.1:8787', MAP_DESIGN_TOOL_TOKEN: 'run-token' },
      },
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(JSON.parse(output.join(''))).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL', message: 'The daemon returned an invalid MapDesign tool envelope.' },
    });
  });
});

async function* input(value: string): AsyncGenerator<string> {
  yield value;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
