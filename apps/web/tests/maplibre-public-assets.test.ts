import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { prepareMapLibrePublicAssets } from '../src/server/maplibre-public-assets';

const files = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'] as const;
let root: string;
let dist: string;
let destination: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mapdesign-public-assets-'));
  dist = join(root, 'dist');
  destination = join(root, 'public');
  mkdirSync(dist);
  for (const file of files) writeFileSync(join(dist, file), `${file}\n`.repeat(100_000));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

it('keeps unchanged assets untouched across startup', () => {
  prepareMapLibrePublicAssets(dist, destination);
  const asset = join(destination, files[0]);
  utimesSync(asset, new Date(0), new Date(0));
  prepareMapLibrePublicAssets(dist, destination);
  expect(statSync(asset).mtimeMs).toBe(0);
});

it('replaces stale assets completely after a dependency update', () => {
  prepareMapLibrePublicAssets(dist, destination);
  writeFileSync(join(dist, files[0]), 'updated worker');
  prepareMapLibrePublicAssets(dist, destination);
  expect(readFileSync(join(destination, files[0]), 'utf8')).toBe('updated worker');
  expect(readdirSync(destination).sort()).toEqual([...files].sort());
});

it.skipIf(process.platform !== 'win32')('starts while Windows readers lock unchanged public assets', async () => {
  prepareMapLibrePublicAssets(dist, destination);
  const reader = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$stream = [System.IO.File]::Open($env:MAPDESIGN_TEST_ASSET, "Open", "Read", "Read"); [Console]::WriteLine("ready"); [Console]::In.ReadLine(); $stream.Dispose()',
  ], { env: { ...process.env, MAPDESIGN_TEST_ASSET: join(destination, files[0]) }, windowsHide: true });
  const closed = once(reader, 'close');
  try {
    const [output] = await once(reader.stdout, 'data');
    expect(String(output).trim()).toBe('ready');
    expect(() => prepareMapLibrePublicAssets(dist, destination)).not.toThrow();
    const previous = readFileSync(join(destination, files[0]));
    writeFileSync(join(dist, files[0]), 'updated worker');
    expect(() => prepareMapLibrePublicAssets(dist, destination)).toThrow();
    expect(readFileSync(join(destination, files[0])).equals(previous)).toBe(true);
    expect(readdirSync(destination).sort()).toEqual([...files].sort());
  } finally {
    reader.stdin.end('\n');
    await closed;
  }
}, 15_000);

it('loads Next config through tsx from the tools-dev workspace directory', () => {
  const workspace = fileURLToPath(new URL('../../../', import.meta.url));
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  const script = `
    const { createRequire } = require('node:module');
    const webRequire = createRequire(process.cwd() + '/apps/web/package.json');
    const loadConfig = webRequire('next/dist/server/config').default;
    loadConfig('phase-development-server', process.cwd() + '/apps/web')
      .then(() => process.stdout.write('loaded'))
      .catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, [tsx, '-e', script], {
    cwd: workspace,
    env: { ...process.env, NODE_ENV: 'development' },
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('loaded');
}, 35_000);

it('publishes complete assets when independent startup processes race', async () => {
  const moduleUrl = new URL('../src/server/maplibre-public-assets.ts', import.meta.url).href;
  const script = `
    import { prepareMapLibrePublicAssets } from ${JSON.stringify(moduleUrl)};
    process.stdout.write('ready');
    process.stdin.once('data', () => {
      for (let i = 0; i < 10; i++) prepareMapLibrePublicAssets(process.argv[1], process.argv[2]);
      process.stdin.destroy();
    });
  `;
  const workers = Array.from({ length: 2 }, () => spawn(process.execPath, ['--input-type=module', '-e', script, dist, destination], { windowsHide: true }));
  const completed = workers.map(async (worker) => {
    let stderr = '';
    worker.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    const [code] = await once(worker, 'close');
    return { code, stderr };
  });
  try {
    await Promise.all(workers.map((worker) => once(worker.stdout, 'data')));
    for (const worker of workers) worker.stdin.end('start');
    expect(await Promise.all(completed)).toEqual([{ code: 0, stderr: '' }, { code: 0, stderr: '' }]);
    for (const file of files) expect(readFileSync(join(destination, file)).equals(readFileSync(join(dist, file)))).toBe(true);
    expect(readdirSync(destination).sort()).toEqual([...files].sort());
  } finally {
    for (const worker of workers) worker.kill();
    await Promise.all(completed);
  }
}, 15_000);
