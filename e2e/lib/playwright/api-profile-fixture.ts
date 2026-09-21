import { createServer } from 'node:http';
import { once } from 'node:events';

/** Local-only model fixture. No requests are sent to a commercial provider. */
export async function createApiProfileFixture() {
  const calls: Array<{ path: string; model: string }> = [];
  const streamCalls: Array<{ path: string; model: string; authenticated: boolean }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk); length += bytes.length;
      if (length > 2 * 1024 * 1024) { response.writeHead(413).end(); return; } chunks.push(bytes);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls.push({ path: request.url ?? '', model: String(body.model) });
      if (body.stream === true) {
        const primary = request.url?.startsWith('/first/') ?? false;
        const expectedKey = primary ? 'local-test-value' : 'local-second-value';
        const authenticated = request.headers.authorization === `Bearer ${expectedKey}`;
        streamCalls.push({ path: request.url ?? '', model: String(body.model), authenticated });
        if (!authenticated) { response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"Fixture authentication mismatch"}}'); return; }
        const base = { id: `fixture-${streamCalls.length}`, object: 'chat.completion.chunk', created: 1, model: body.model };
        const content = primary ? 'Primary model answered.' : 'Secondary model answered.';
        const events = [
          { ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ];
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'fixture-response', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    } catch { response.writeHead(400).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture startup failed');
  return { baseUrl: `http://127.0.0.1:${address.port}`, calls, streamCalls,
    close: async () => { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; } };
}
