import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FORMAT_VERSION, VERSION, lintCartography } from '@mapseekai/cartography.md';
import { CARTOGRAPHY_MAX_BYTES } from '@mapseekai/map-design-contracts';
import { loadMapDesignSystem, parseCartographyDesignSystem } from '../../../src/map-design/validation/design-system-loader.js';
import { TEST_CARTOGRAPHY_SOURCE } from '../../fixtures/map-design/test-design-system.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(content: string | Uint8Array, name = 'CARTOGRAPHY.md') {
  const root = await mkdtemp(path.join(tmpdir(), 'cartography-loader-'));
  roots.push(root);
  const directory = path.join(root, 'design-systems', 'test-system');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), content);
  return { root, directory };
}

describe('standard CARTOGRAPHY.md loading', () => {
  it('uses official 0.4.1 tooling for the 0.4.0 document format', async () => {
    expect(VERSION).toBe('0.4.1');
    expect(FORMAT_VERSION).toBe('0.4.0');
    const projectRoot = path.resolve(import.meta.dirname, '../../../../..');
    const document = await loadMapDesignSystem({ projectRoot, designSystemId: 'quiet-atlas' });
    expect(document).toMatchObject({ format: 'cartography', id: 'quiet-atlas', name: 'Quiet Atlas', version: '0.4.0' });
    expect(document.source).not.toContain('mapdesign-rules');
    const report = lintCartography(document.source, { strict: true });
    expect(report.valid).toBe(true);
    expect(report.sections).toHaveLength(9);
    expect(report.cartography?.elements?.['road-primary']).toMatchObject({ geometry: 'line' });
    expect('rules' in document).toBe(false);
  });

  it('pins the entire source, including narrative guidance', async () => {
    const {root} = await fixture(TEST_CARTOGRAPHY_SOURCE);
    const document = await loadMapDesignSystem({ projectRoot: root, designSystemId: 'test-system' });
    expect(document.source).toBe(TEST_CARTOGRAPHY_SOURCE);
    expect(parseCartographyDesignSystem('test-system', `${document.source}\nAdditional guidance.\n`).digest).not.toBe(document.digest);
    expect(parseCartographyDesignSystem('test-system', document.source).digest).toBe(document.digest);
  });

  it.each([
    ['legacy rule block', '# Old document\n\n```mapdesign-rules\n{"version":1}\n```'],
    ['older format', TEST_CARTOGRAPHY_SOURCE.replace('"0.4.0"', '"0.3.0"')],
    ['unknown future format', TEST_CARTOGRAPHY_SOURCE.replace('"0.4.0"', '"9.0.0"')],
    ['duplicate YAML key', TEST_CARTOGRAPHY_SOURCE.replace('name: Test Atlas', 'name: Test Atlas\nname: Duplicate')],
    ['unresolved reference', TEST_CARTOGRAPHY_SOURCE.replace('{colors.paper}', '{colors.missing}')],
    ['YAML alias', TEST_CARTOGRAPHY_SOURCE.replace('paper: "#ffffff"', 'paper: &paper "#ffffff"').replace('ink: "#111111"', 'ink: *paper')],
    ['BOM', '\uFEFF' + TEST_CARTOGRAPHY_SOURCE],
  ])('rejects %s without silently upgrading it', async (_name, source) => {
    const {root} = await fixture(source);
    await expect(loadMapDesignSystem({projectRoot: root, designSystemId: 'test-system'})).rejects.toThrow(/Invalid CARTOGRAPHY/);
  });

  it('does not execute private code blocks, runtime fields, or prose as policy', () => {
    const source = TEST_CARTOGRAPHY_SOURCE + '\n```mapdesign-rules\n{"minimumContrastRatio":1}\n```\n';
    const document = parseCartographyDesignSystem('test-system', source);
    expect(document.source).toBe(source);
    expect('rules' in document).toBe(false);
    expect('policy' in document).toBe(false);
  });

  it('rejects traversal and symlink escapes without exposing paths', async () => {
    const {root, directory} = await fixture(TEST_CARTOGRAPHY_SOURCE);
    for (const id of ['', '.', '..', '../quiet-atlas', 'a/b', 'a\\b', '/absolute', 'bad\u0000id']) {
      await expect(loadMapDesignSystem({projectRoot: root, designSystemId: id})).rejects.toThrow('invalid design system id');
    }
    await rm(path.join(directory, 'CARTOGRAPHY.md'));
    await symlink(tmpdir(), path.join(directory, 'CARTOGRAPHY.md'));
    await expect(loadMapDesignSystem({projectRoot: root, designSystemId: 'test-system'})).rejects.toThrow('outside configured root');
  });

  it.each([
    ['oversized source', 'x'.repeat(CARTOGRAPHY_MAX_BYTES + 1)],
    ['oversized UTF-8', '制'.repeat(Math.ceil(CARTOGRAPHY_MAX_BYTES / 3) + 1)],
    ['invalid UTF-8', new Uint8Array([0xff, 0xfe, 0x00])],
  ])('rejects %s at the file boundary', async (_name, content) => {
    const {root} = await fixture(content);
    await expect(loadMapDesignSystem({projectRoot: root, designSystemId: 'test-system'})).rejects.toThrow();
  });

  it('does not fall back to the retired filename', async () => {
    const {root} = await fixture(TEST_CARTOGRAPHY_SOURCE, 'MAP_DESIGN.md');
    await expect(loadMapDesignSystem({projectRoot: root, designSystemId: 'test-system'})).rejects.toThrow('could not read map design system');
  });
});
