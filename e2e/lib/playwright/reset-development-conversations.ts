import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { e2eWorkspaceRoot } from '../tools-dev/runtime.js';

const execFileAsync = promisify(execFile);

export async function resetPlaywrightMapDesignConversations(dataDir: string): Promise<void> {
  const daemonRoot = join(e2eWorkspaceRoot(), 'apps', 'daemon');
  const databaseModule = pathToFileURL(join(daemonRoot, 'dist', 'map-design', 'storage', 'database.js')).href;
  const resetModule = pathToFileURL(join(daemonRoot, 'dist', 'map-design', 'storage', 'dev-conversation-reset.js')).href;
  const program = [
    `import { openMapDesignDatabase, closeMapDesignDatabase } from ${JSON.stringify(databaseModule)};`,
    `import { resetMapDesignDevelopmentConversations } from ${JSON.stringify(resetModule)};`,
    `const database = openMapDesignDatabase(${JSON.stringify(dataDir)});`,
    'try { resetMapDesignDevelopmentConversations(database); } finally { closeMapDesignDatabase(database); }',
  ].join('\n');
  await execFileAsync(process.execPath, ['--input-type=module', '--eval', program], { cwd: daemonRoot });
}
