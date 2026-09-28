import Database from 'better-sqlite3';
import { unzipSync } from 'fflate';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

type SourceDocument = { readonly fileName: string; readonly content: string };
type StylxItem = { readonly NAME: unknown; readonly CATEGORY: unknown; readonly CONTENT: unknown };
const expandedLimit = 16 * 1024 * 1024;

class StyleSourceError extends Error {
  override readonly name = 'StyleSourceError';
}

export function readStyleSource(content: Buffer, fileName: string): SourceDocument[] {
  if (content.length > 4 * 1024 * 1024) throw new StyleSourceError('Style exceeds 4 MiB');
  if (fileName.toLowerCase().endsWith('.stylx')) return readStylx(content, fileName);
  if (!content.subarray(0, 4).equals(Buffer.from('PK\x03\x04'))) {
    return [{ fileName, content: content.toString('utf8') }];
  }

  let expandedBytes = 0;
  unzipSync(content, { filter: (member) => {
    const memberPath = member.name.replaceAll('\\', '/');
    if (memberPath.startsWith('/') || /^[a-z]:/i.test(memberPath) || memberPath.split('/').includes('..') || memberPath.includes('\0')) {
      throw new StyleSourceError('Unsafe archive member path');
    }
    expandedBytes += member.originalSize;
    if (expandedBytes > expandedLimit) throw new StyleSourceError('Expanded archive exceeds 16 MiB');
    return false;
  } });
  const entries = unzipSync(content, { filter: (member) => /\.(qgs|lyrx|json)$/i.test(member.name) });
  const documents = Object.entries(entries).map(([memberName, bytes]) => ({
    fileName: memberName,
    content: Buffer.from(bytes).toString('utf8'),
  }));
  if (documents.length === 0) throw new StyleSourceError('Archive contains no readable style documents');
  return documents;
}

function readStylx(content: Buffer, fileName: string): SourceDocument[] {
  const directory = mkdtempSync(path.join(tmpdir(), 'cartography-source-'));
  let database: Database.Database | undefined;
  try {
    const sourcePath = path.join(directory, 'source.stylx');
    writeFileSync(sourcePath, content);
    database = new Database(sourcePath, { readonly: true, fileMustExist: true });
    const items: string[] = [];
    let totalBytes = 2;
    const rows = database.prepare<[], StylxItem>('SELECT NAME, CATEGORY, CONTENT FROM ITEMS').iterate();
    for (const item of rows) {
      const text = JSON.stringify({
        NAME: Buffer.isBuffer(item.NAME) ? item.NAME.toString('utf8') : item.NAME,
        CATEGORY: Buffer.isBuffer(item.CATEGORY) ? item.CATEGORY.toString('utf8') : item.CATEGORY,
        CONTENT: Buffer.isBuffer(item.CONTENT) ? item.CONTENT.toString('utf8') : item.CONTENT,
      });
      totalBytes += Buffer.byteLength(text, 'utf8') + (items.length > 0 ? 1 : 0);
      if (totalBytes > expandedLimit) throw new StyleSourceError('Expanded style content exceeds 16 MiB');
      items.push(text);
    }
    return [{ fileName: `${fileName}.json`, content: `[${items.join(',')}]` }];
  } finally {
    try {
      database?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
