import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron, test as base, expect, type Page } from '@playwright/test';

type ProtocolFixture = { readonly page: Page; readonly origins: readonly (string | undefined)[] };

export const test = base.extend<{ packagedProtocol: ProtocolFixture }>({
  packagedProtocol: async ({}, use) => {
    const origins: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      if (request.url === '/') {
        response.setHeader('content-type', 'text/html');
        response.end('<script type="module">const worker = new Worker("/worker.mjs", {type:"module"}); worker.onmessage = event => document.body.dataset.worker = event.data; worker.onerror = () => document.body.dataset.worker = "error";</script>');
      } else {
        response.setHeader('content-type', 'application/javascript');
        if (request.url === '/shared.mjs') {
          origins.push(request.headers.origin);
          response.end('export const value = "ready";');
        } else {
          response.end('import { value } from "./shared.mjs"; postMessage(value);');
        }
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address == null || typeof address === 'string') throw new Error('Protocol test server has no TCP address.');
    const root = await mkdtemp(join(tmpdir(), 'map-design-protocol-'));
    const requirePackaged = createRequire(new URL('../../../apps/packaged/package.json', import.meta.url));
    const executablePath: unknown = requirePackaged('electron');
    if (typeof executablePath !== 'string') throw new Error('Electron executable is unavailable.');
    const env = Object.fromEntries(Object.entries(process.env).flatMap(([name, value]) => value == null || name.toUpperCase() === 'ELECTRON_RUN_AS_NODE' ? [] : [[name, value]]));
    let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      const entry = join(root, 'main.mjs');
      await promisify(execFile)(process.execPath, [
        '-e',
        'require(process.argv[1]).buildSync({ entryPoints: [process.argv[2]], outfile: process.argv[3], bundle: true, platform: "node", format: "esm", external: ["electron"] })',
        requirePackaged.resolve('esbuild'),
        fileURLToPath(new URL('../../../apps/packaged/tests/fixtures/protocol-main.ts', import.meta.url)),
        entry,
      ]);
      application = await _electron.launch({
        executablePath,
        args: [entry, `--user-data-dir=${root}`],
        env: { ...env, MAP_DESIGN_PROTOCOL_TEST_URL: `http://127.0.0.1:${address.port}` },
        timeout: 20_000,
      });
      await use({ page: await application.firstWindow(), origins });
    } finally {
      try {
        if (application != null) {
          const child = application.process();
          const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
          await application.evaluate(({ app }) => app.exit());
          await exited;
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  },
});

export { expect };
