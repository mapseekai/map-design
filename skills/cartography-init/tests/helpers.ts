import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

export function loadFixture(rel: string): Buffer {
  return readFileSync(path.join(fixturesDir, rel));
}

export function loadFixtureText(rel: string): string {
  return readFileSync(path.join(fixturesDir, rel), 'utf8');
}

export function makeTempDir(prefix = 'cartography-init-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function makeStylx(items: Array<{ category: string; name: string; content: string }> = [{
  category: 'Symbols',
  name: 'major-road',
  content: JSON.stringify({
    type: 'CIMLineSymbol',
    symbolLayers: [{ type: 'CIMSolidStroke', color: { type: 'CIMRGBColor', values: [51, 136, 255] }, width: 1.5 }],
  }),
}]): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), 'stylx-'));
  const file = path.join(dir, 'test.stylx');
  const database = new Database(file);
  database.exec('CREATE TABLE ITEMS (ID INTEGER PRIMARY KEY, CLASS INTEGER, CATEGORY TEXT, NAME TEXT, TAGS TEXT, CONTENT BLOB, KEY TEXT)');
  const insert = database.prepare('INSERT INTO ITEMS (CLASS, CATEGORY, NAME, CONTENT) VALUES (?, ?, ?, ?)');
  for (const item of items) insert.run(3, item.category, item.name, Buffer.from(item.content, 'utf8'));
  database.close();
  return readFileSync(file);
}
