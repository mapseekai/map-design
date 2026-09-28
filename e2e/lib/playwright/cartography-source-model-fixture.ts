import { once } from 'node:events';
import { createServer } from 'node:http';

export async function createCartographySourceModelFixture(source: string) {
  const requests: string[] = [];
  const toolResults: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const content = Buffer.concat(chunks).toString('utf8');
    requests.push(content);
    const body: unknown = JSON.parse(content);
    if (typeof body === 'object' && body !== null && 'messages' in body && Array.isArray(body.messages)) {
      for (const message of body.messages) {
        if (typeof message === 'object' && message !== null && 'role' in message && message.role === 'tool' && 'content' in message && typeof message.content === 'string') toolResults.push(message.content);
      }
    }
    const base = { id: `source-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'source-model' };
    const delta = requests.length === 1
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'source-read-1', type: 'function', function: { name: 'read_cartography_source', arguments: JSON.stringify({ fileName: 'source/document-1.json' }) } }] }
      : { role: 'assistant', content: JSON.stringify({ message: '已读取原始样式并完善规范。', source }) };
    const events = [
      { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Source model fixture failed to listen.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, toolResults,
    async close() {
      const closed = once(server, 'close');
      server.close(); server.closeAllConnections();
      await closed;
    },
  };
}
