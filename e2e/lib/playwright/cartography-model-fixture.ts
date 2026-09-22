import { once } from 'node:events';
import { createServer } from 'node:http';

export async function createCartographyModelFixture(source: string) {
  const requests: string[] = [];
  let release = () => {};
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(Buffer.concat(chunks).toString('utf8'));
    await ready;
    if (response.destroyed) return;
    const content = JSON.stringify({ message: '已根据设计要求创建步行地图规范。', source });
    const base = { id: `cartography-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'cartography-model' };
    const events = [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Model fixture failed to listen.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, release,
    async close() {
      release();
      const closed = once(server, 'close');
      server.close(); server.closeAllConnections();
      await closed;
    },
  };
}
