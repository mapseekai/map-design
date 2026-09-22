import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function hasContent(path: string, content: Buffer): boolean {
  try {
    return readFileSync(path).equals(content);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export function prepareMapLibrePublicAssets(dist: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
    const content = readFileSync(resolve(dist, file));
    const target = resolve(destination, file);
    if (hasContent(target, content)) continue;

    // Each startup writes privately; readers only see a complete published file.
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, { flag: 'wx' });
      try {
        renameSync(temporary, target);
      } catch (error) {
        // Windows may reject replacement while another startup publishes the same asset.
        if (!(error instanceof Error && 'code' in error
          && ['EBUSY', 'EPERM', 'EACCES', 'EEXIST'].includes(String(error.code))
          && hasContent(target, content))) throw error;
      }
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
