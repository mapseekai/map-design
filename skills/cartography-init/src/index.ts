import { unzipSync } from 'fflate';
import { parseLyrx, parseStylx } from './adapters/arcgis.js';
import { parseQgis } from './adapters/qgis.js';
import { parseSld } from './adapters/sld.js';
import { parseStyleJson } from './adapters/style-json.js';
import { detectSource } from './detect.js';
import { initializeDocument } from './init.js';

/** Bounded application entrypoint; keeps the original CLI and all format adapters available. */
export function initializeCartography(content: Buffer, fileName: string, name: string) {
  if (content.length > 4 * 1024 * 1024) throw new Error('Style exceeds 4 MiB');
  if (content.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    let total = 0;
    unzipSync(content, { filter: (file) => {
      total += file.originalSize;
      if (total > 16 * 1024 * 1024) throw new Error('Expanded archive exceeds 16 MiB');
      return false;
    } });
  }
  const kind = detectSource(fileName, content);
  const ir = kind === 'style' ? parseStyleJson(content.toString('utf8'), fileName)
    : kind === 'qgis' ? parseQgis(content, fileName)
      : kind === 'lyrx' ? parseLyrx(content, fileName)
        : kind === 'stylx' ? parseStylx(content, fileName)
          : parseSld(content.toString('utf8'), fileName);
  const result = initializeDocument(ir, { name, sourceFile: fileName });
  return { source: result.document, reportMarkdown: result.reportMarkdown, reportJson: result.reportJson };
}
