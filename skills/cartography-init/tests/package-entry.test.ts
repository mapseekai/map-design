import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixturesDir } from './helpers.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const temporaryRoot = join(repositoryRoot, '.tmp');
mkdirSync(temporaryRoot, { recursive: true });

function invokePackage(args: string[]) {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error('Run package-entry tests through pnpm.');
  return spawnSync(process.execPath, [pnpmCli, '--filter', '@cartographymd/init-skill', 'run', 'init', ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

describe('cartography-init package entry', () => {
  it.each([
    { absolute: false, separator: false },
    { absolute: false, separator: true },
    { absolute: true, separator: false },
    { absolute: true, separator: true },
  ])('generates all artifacts with $absolute absolute paths and $separator separator', ({ absolute, separator }) => {
    const directory = mkdtempSync(join(temporaryRoot, 'cartography-package-entry-'));
    try {
      const source = join(directory, 'style.json');
      copyFileSync(join(fixturesDir, 'style-min.json'), source);
      const output = join(directory, 'CARTOGRAPHY.md');
      const report = join(directory, 'INIT_REPORT.md');
      const reportJson = join(directory, 'INIT_REPORT.json');
      const argumentPath = (path: string) => absolute ? path : relative(repositoryRoot, path);

      const result = invokePackage([
        ...(separator ? ['--'] : []),
        '--input', argumentPath(source), '--output', argumentPath(output),
        '--report', argumentPath(report), '--report-json', argumentPath(reportJson),
      ]);

      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(output, 'utf8')).toContain('version: "0.4.0"');
      expect(readFileSync(report, 'utf8').length).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(reportJson, 'utf8')).source.file).toBe('style.json');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([false, true])('checks reports using $0 absolute paths from the invocation directory', (absolute) => {
    const directory = mkdtempSync(join(temporaryRoot, 'cartography-package-check-'));
    try {
      const report = join(directory, 'INIT_REPORT.json');
      writeFileSync(report, JSON.stringify({ bindings: [] }));

      const result = invokePackage(['--', '--check-report', absolute ? report : relative(repositoryRoot, report)]);

      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
