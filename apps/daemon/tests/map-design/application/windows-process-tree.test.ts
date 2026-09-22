import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { stopMapDesignProcessTree } from '../../../src/map-design/application/run-service.js';
import { spawnAgentProcess } from '../../../src/runtimes/spawn.js';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

it.runIf(process.platform === 'win32')('awaits termination of a real command shim and its persistent Node child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'map process tree '));
  const script = join(root, 'persistent.cjs');
  const command = join(root, 'persistent.cmd');
  const ownedPids: number[] = [];
  try {
    await writeFile(script, 'console.log(process.pid); setInterval(() => {}, 1000);');
    await writeFile(command, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const child = spawnAgentProcess(command, [], { cwd: process.cwd(), env: process.env, detached: false });
    if (!child.pid) throw new Error('The command shim did not start.');
    ownedPids.push(child.pid);
    const [chunk] = await once(child.stdout, 'data');
    const descendantPid = Number(String(chunk).trim());
    expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
    ownedPids.unshift(descendantPid);

    await stopMapDesignProcessTree(child, 250);

    expect(ownedPids.map(isAlive)).toEqual([false, false]);
  } finally {
    for (const pid of ownedPids.filter(isAlive)) {
      const cleanup = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      await once(cleanup, 'close');
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 20_000);
