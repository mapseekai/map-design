import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { fixturesDir, makeStylx } from './helpers.js';

describe('runCli end-to-end', () => {
  const inputs: ReadonlyArray<{ name: string; fixture?: string; stylx?: true }> = [
    { name: 'style-min.json', fixture: 'style-min.json' },
    { name: 'sld-min.xml', fixture: 'sld-min.xml' },
    { name: 'qgis-min.qgs', fixture: 'qgis-min.qgs' },
    { name: 'arcgis-min.lyrx', fixture: 'arcgis-min.lyrx' },
    { name: 'arcgis-min.stylx', stylx: true },
  ];

  for (const input of inputs) {
    it(`generates a lint-clean document from ${input.name}`, async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'init-e2e-'));
      const source = input.fixture ? path.join(fixturesDir, input.fixture) : path.join(dir, input.name);
      if (input.stylx) writeFileSync(source, makeStylx());
      const out = path.join(dir, 'CARTOGRAPHY.md');
      const reportJson = path.join(dir, 'INIT_REPORT.json');
      const code = await runCli([
        '--input', source,
        '--output', out,
        '--report-json', reportJson,
      ]);
      expect(code).toBe(0);
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out, 'utf8')).toContain('version: "0.4.0"');
      expect(readFileSync(out, 'utf8')).not.toContain(source);
      expect(readFileSync(out, 'utf8')).not.toContain(input.name);
      expect(JSON.parse(readFileSync(reportJson, 'utf8')).source.file).toBe(path.basename(source));
      if (input.name === 'qgis-min.qgs') {
        const report = JSON.parse(readFileSync(reportJson, 'utf8')) as { unresolved: unknown[] };
        const topics = report.unresolved.map((item) => {
          if (!item || typeof item !== 'object' || !('topic' in item) || typeof item.topic !== 'string') {
            throw new Error('report unresolved item is missing a topic');
          }
          return item.topic;
        });
        expect(topics).toEqual([
          'target tile source url/type',
          'crs/tiling',
          'glyphs',
          'sprites',
        ]);
      }
    });
  }

  it('detects style.json whose "layers" key lies beyond the first 4 KiB', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'init-e2e-'));
    const base = JSON.parse(readFileSync(path.join(fixturesDir, 'style-min.json'), 'utf8')) as {
      version: number;
      name: string;
      sources: unknown;
      layers: unknown;
    };
    const padded = Buffer.from(JSON.stringify({
      version: base.version,
      name: base.name,
      metadata: { pad: 'x'.repeat(8192) },
      sources: base.sources,
      layers: base.layers,
    }));
    expect(padded.indexOf('"layers"')).toBeGreaterThan(4096);
    const source = path.join(dir, 'big.style.json');
    writeFileSync(source, padded);
    const out = path.join(dir, 'CARTOGRAPHY.md');
    const code = await runCli(['--input', source, '--output', out]);
    expect(code).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('version: "0.4.0"');
  });
  it('refuses to write on unrecognised input', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'init-e2e-'));
    const out = path.join(dir, 'CARTOGRAPHY.md');
    const bad = path.join(dir, 'mystery.bin');
    writeFileSync(bad, Buffer.from([0, 1, 2, 3]));
    const code = await runCli(['--input', bad, '--output', out]);
    expect(code).toBe(2);
    expect(existsSync(out)).toBe(false);
  });

  it('--check-report exits 1 until every binding is triaged', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'init-e2e-'));
    const reportJson = path.join(dir, 'INIT_REPORT.json');
    const code1 = await runCli([
      '--input', path.join(fixturesDir, 'style-boundary.json'),
      '--output', path.join(dir, 'CARTOGRAPHY.md'),
      '--report-json', reportJson,
    ]);
    expect(code1).toBe(0);
    expect(await runCli(['--check-report', reportJson])).toBe(1);
  });
});
