import Database from 'better-sqlite3';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import * as entrypoint from '../src/index.js';

describe('original style source evidence', () => {
  it.each(['style.json', 'project.qgs', 'style.sld', 'style.xml', 'layer.lyrx'])('preserves original text when reading %s', (fileName) => {
    const content = '<original unknown="保持" />\n';
    const result = entrypoint.readStyleSource(Buffer.from(content), fileName);
    expect(result).toEqual([{ fileName, content }]);
  });

  it('preserves unknown fields and Chinese member names when reading QGZ', () => {
    const content = '<qgis><unknown key="保持">custom</unknown></qgis>';
    const archive = Buffer.from(zipSync({ '配图/工程.qgs': strToU8(content), 'ignored.txt': strToU8('ignored') }));
    const result = entrypoint.readStyleSource(archive, 'project.qgz');
    expect(result).toEqual([{ fileName: '配图/工程.qgs', content }]);
  });

  it('returns all original layer documents when reading zipped LYRX', () => {
    const content = '{ "unknown": [1, "自定义"] }';
    const archive = Buffer.from(zipSync({ 'layer.lyrx': strToU8(content), 'extra.json': strToU8(content) }));
    const result = entrypoint.readStyleSource(archive, 'layer.lyrx');
    expect(result).toEqual([{ fileName: 'layer.lyrx', content }, { fileName: 'extra.json', content }]);
  });

  it.each(['../evil.qgs', 'a/../../evil.qgs', 'C:\\evil.qgs', '/evil.qgs', 'a\\..\\evil.qgs'])('rejects unsafe archive member %s', (member) => {
    const archive = Buffer.from(zipSync({ [member]: strToU8('text') }));
    expect(() => entrypoint.readStyleSource(archive, 'project.qgz')).toThrow(/path/i);
  });

  it('rejects aggregate expanded content above the archive bound', () => {
    const archive = Buffer.from(zipSync({ 'a.qgs': new Uint8Array(9 * 1024 * 1024), 'b.bin': new Uint8Array(8 * 1024 * 1024) }));
    expect(() => entrypoint.readStyleSource(archive, 'project.qgz')).toThrow(/16 MiB/);
  });

  it('rejects uploads above the source bound', () => {
    const content = Buffer.alloc(4 * 1024 * 1024 + 1);
    expect(() => entrypoint.readStyleSource(content, 'style.json')).toThrow(/4 MiB/);
  });

  it('retains original SQLite item contents including unsupported categories', () => {
    const database = new Database(':memory:');
    try {
      database.exec('CREATE TABLE ITEMS (NAME TEXT, CATEGORY TEXT, CONTENT BLOB)');
      database.prepare('INSERT INTO ITEMS VALUES (?, ?, ?)').run('自定义符号', 'Unknown', Buffer.from('{"custom":true}'));
      const content = database.serialize();
      const result = entrypoint.readStyleSource(content, 'symbols.stylx');
      expect(result).toEqual([{ fileName: 'symbols.stylx.json', content: '[{"NAME":"自定义符号","CATEGORY":"Unknown","CONTENT":"{\\"custom\\":true}"}]' }]);
    } finally {
      database.close();
    }
  });
});
