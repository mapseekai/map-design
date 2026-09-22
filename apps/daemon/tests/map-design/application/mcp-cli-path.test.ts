import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveMapDesignMcpCliPath } from '../../../src/server.js';

describe('resolveMapDesignMcpCliPath', () => {
  it('accepts an explicit absolute existing private CLI path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'map-design-mcp-cli-path-'));
    const path = join(root, 'app', 'prebundled', 'daemon', 'map-design-mcp-cli.mjs');
    try {
      await mkdir(join(root, 'app', 'prebundled', 'daemon'), { recursive: true });
      await writeFile(path, '', 'utf8');

      await expect(resolveMapDesignMcpCliPath(path)).resolves.toBe(path);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('rejects relative and missing explicit paths', async () => {
    await expect(resolveMapDesignMcpCliPath('app/prebundled/daemon/map-design-mcp-cli.mjs')).rejects.toThrow(
      'MAP_DESIGN_MCP_CLI_PATH must be an absolute path.',
    );
    await expect(resolveMapDesignMcpCliPath('/missing/map-design-mcp-cli.mjs')).rejects.toThrow(
      'MAP_DESIGN_MCP_CLI_PATH must reference an existing file.',
    );
  });

  it('uses the built workspace daemon entry only when no explicit path is provided', async () => {
    await expect(resolveMapDesignMcpCliPath(undefined)).resolves.toMatch(/[\\/]apps[\\/]daemon[\\/]dist[\\/]map-design-mcp-cli\.js$/u);
  });
});
