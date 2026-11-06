import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { requestJsonIpc } from '../src/json-ipc.js';
import { closeServer } from '../src/net.js';

describe('sidecar response boundary', () => {
  const servers: Server[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer));
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  async function reply(frame: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'map-design-ipc-response-'));
    roots.push(root);
    const path = process.platform === 'win32' ? `\\\\.\\pipe\\map-design-response-${randomUUID()}` : join(root, 'ipc.sock');
    const server = createServer(socket => socket.once('data', () => socket.end(frame)));
    servers.push(server);
    server.listen(path);
    await once(server, 'listening');
    return path;
  }

  it.each([
    { name: 'malformed JSON', frame: '{invalid}\n' },
    { name: 'null', frame: 'null\n' },
    { name: 'an array', frame: '[]\n' },
    { name: 'a primitive', frame: 'true\n' },
    { name: 'a missing discriminator', frame: '{}\n' },
    { name: 'a nonboolean discriminator', frame: '{"ok":"true"}\n' },
    { name: 'a null error', frame: '{"ok":false,"error":null}\n' },
    { name: 'an array error', frame: '{"ok":false,"error":[]}\n' },
    { name: 'a nonstring error message', frame: '{"ok":false,"error":{"message":42}}\n' },
  ])('rejects $name through the request promise', async ({ frame }) => {
    const path = await reply(frame);
    await expect(requestJsonIpc(path, { type: 'STATUS' })).rejects.toThrow('Invalid IPC response');
  });

  it('preserves a successful response with no result', async () => {
    const path = await reply('{"ok":true}\n');
    await expect(requestJsonIpc(path, { type: 'STATUS' })).resolves.toBeUndefined();
  });

  it('preserves a valid server error', async () => {
    const path = await reply('{"ok":false,"error":{"message":"Not available"}}\n');
    await expect(requestJsonIpc(path, { type: 'STATUS' })).rejects.toThrow('Not available');
  });
});
