import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getUiP0Group, listUiP0GroupNames, uiP0Groups } from '../lib/playwright/suites.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(path.resolve(scriptDir, '..'), 'ui');

const commands: Record<string, () => Promise<void>> = {
  clean: cleanArtifacts,
  help: async () => printUsage(),
  'list-ui-groups': listUiGroups,
  'run-ui-group': runUiGroup,
};

const command = commands[process.argv[2] ?? 'help'];
if (command == null) {
  printUsage();
  process.exitCode = 1;
} else {
  await command();
}

async function cleanArtifacts(): Promise<void> {
  await Promise.all([
    rm(path.join(uiDir, '.map-design-data'), { recursive: true, force: true }),
    rm(path.join(uiDir, 'test-results'), { recursive: true, force: true }),
    rm(path.join(uiDir, 'reports'), { recursive: true, force: true }),
  ]);
  await Promise.all([
    mkdir(path.join(uiDir, '.map-design-data'), { recursive: true }),
    mkdir(path.join(uiDir, 'reports', 'test-results'), { recursive: true }),
  ]);
}

async function listUiGroups(): Promise<void> {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(uiP0Groups, null, 2));
    return;
  }
  console.log(listUiP0GroupNames().join('\n'));
}

async function runUiGroup(): Promise<void> {
  const groupName = process.argv[3];
  const group = groupName == null ? undefined : getUiP0Group(groupName);
  if (group == null) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  const args = ['test', '-c', 'playwright.config.ts', ...group.files, '--grep', group.grep];
  if (group.workers != null) args.push(`--workers=${group.workers}`);
  const child = spawn('playwright', args, {
    env: group.fullyParallel ? { ...process.env, MAP_DESIGN_PLAYWRIGHT_FULLY_PARALLEL: '1' } : process.env,
    stdio: 'inherit',
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  process.exitCode = exitCode ?? 1;
}

function printUsage(): void {
  console.log(`Usage: tsx scripts/playwright.ts <command>

Commands:
  clean
  list-ui-groups [--json]
  run-ui-group map-design
`);
}
