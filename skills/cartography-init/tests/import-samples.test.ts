import { createHash } from 'node:crypto';
import { parseQgis } from '../src/adapters/qgis.js';
import { describe, expect, it } from "vitest";
import { initializeCartography } from "../src/index.js";
import { verifyDocument } from "../src/verify.js";
import { loadFixture } from "./helpers.js";

const samples = [
  { file: "OSM Simple Light.lyrx", elements: 38, colors: 44, skipped: 0,
    evidence: ["#c2eaff", "#cbe7cb"] },
  { file: "style-example.sld", elements: 3, colors: 9, skipped: 3,
    evidence: ["#87CEEB", "#FFFACD", "#F08080"] },
  { file: "OS GeoDataViz Colours & Symbols (ArcPro)_v2.stylx", elements: 0, colors: 125, skipped: 0,
    evidence: ["rag-status-1:", "rag-status-cvd-3:", "#e9002d"] },
  { file: "style-v8.json", elements: 48, colors: 55, skipped: 46,
    evidence: ["hsl(47, 26%, 88%)", "hsl(205, 56%, 73%)"] },
  { file: "selective_masking.qgs", elements: 4, colors: 4, skipped: 13,
    evidence: ["#ffff06", "#377eb8", "1.86mm", "32pt", "Sans"] },
  { file: "network.qgz", elements: 5, colors: 8, skipped: 16,
    evidence: ["#cb8d7b", "#b25cd4", "#7fd95e", "0.86mm", "10pt"] },
] as const;

describe("real style import samples", () => {
  it.each(samples)("converts $file into a valid draft with source evidence", sample => {
    const result = initializeCartography(loadFixture(`import-samples/${sample.file}`), sample.file, sample.file);
    expect(verifyDocument(result.source).ok).toBe(true);
    expect(Buffer.byteLength(result.source)).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.parse(result.reportJson)).toMatchObject({
      statistics: { elements: sample.elements, colors: sample.colors, skipped: sample.skipped },
    });
    for (const evidence of sample.evidence) expect(result.source).toContain(evidence);
    if (sample.file.endsWith('.qgs') || sample.file.endsWith('.qgz')) {
      const ir = parseQgis(loadFixture(`import-samples/${sample.file}`), sample.file);
      expect(JSON.parse(result.reportJson)).toMatchObject({ source: { kind: 'qgis', file: sample.file }, skipped: ir.skipped });
      for (const skipped of ir.skipped) expect(result.reportMarkdown).toContain(skipped.reason);
      for (const binding of ir.bindings) expect(result.reportMarkdown).toContain(binding.expression);
    }
    if (sample.file.endsWith(".sld")) {
      expect(result.reportMarkdown).toContain("Categorize");
      expect(result.reportMarkdown).toContain("TextSymbolizer");
    }
    if (sample.file === "style-v8.json") {
      expect(result.reportJson).toContain("stops");
      expect(result.reportMarkdown).toContain("line-width");
    }
  });
});


describe('official QGIS training projects', () => {
  it.each([
    ['selective_masking.qgs', 'a43f23b25cd0e456bf49c23702aff456a928f8828b8abefa89f4170d2af80e8e'],
    ['network.qgz', '43cbad6404801e95dc2572423f815218c11975270d405ee2aa0a2c35363ca666'],
    ['QGIS-Training-Data.LICENSE.txt', 'dba313854f65a8d41b1777cf9d6cb5ddf692792be04d808b82c86c63909fbdf0'],
  ])('keeps %s byte-identical to the pinned upstream source', (file, hash) => {
    expect(createHash('sha256').update(loadFixture(`import-samples/${file}`)).digest('hex')).toBe(hash);
  });

  it('reads actual RuleRenderer definitions from the original QGZ and reports lost symbol composition', () => {
    const ir = parseQgis(loadFixture('import-samples/network.qgz'), 'network.qgz');
    expect(ir.elements.map(({ name, geometry, style }) => ({ name, geometry, style }))).toEqual([
      ...[['0', '#cb8d7b'], ['1', '#b25cd4'], ['2', '#7fd95e']].map(([name, strokeColor]) => ({
        name, geometry: 'line', style: { strokeColor, strokeWidth: { value: 0.86, unit: 'mm' } },
      })),
      { name: 'network_lines', geometry: 'label', style: {} },
      { name: 'network_points', geometry: 'point', style: { fillColor: '#91522d', strokeColor: '#232323', size: { value: 2, unit: 'mm' } } },
    ]);
    expect(ir.elements.filter(element => element.family === 'network_lines')).toHaveLength(3);
    expect(ir.bindings.filter(binding => binding.kind === 'field-ref')).toEqual([
      { source: 'qgis', layer: 'network_lines', kind: 'field-ref', expression: 'speed' },
    ]);
    expect(ir.typography.map(({ fontFamily, fontSize }) => ({ fontFamily, fontSize })))
      .toEqual([{ fontFamily: ['Sans'], fontSize: { value: 10, unit: 'pt' } }]);
    expect(ir.widths.map(width => width.value)).toEqual([1.06, 0.86, 1.06, 0.86, 1.06, 0.86].map(value => ({ value, unit: 'mm' })));
    expect(ir.skipped.filter(item => item.reason.includes('MarkerLine') && !item.reason.includes('多个符号图层'))).toHaveLength(4);
    expect(ir.skipped).toContainEqual({ source: 'qgis', reason: 'QGZ 附属文件未读取: ctLXeg_styles.db' });
    expect(ir.bindings.filter(binding => binding.kind === 'filter').map(binding => binding.expression))
      .toEqual(['"direction" = 0', '"direction" = 1', '"direction" = 2']);
    expect(ir.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringContaining('多个符号图层') }),
      expect.objectContaining({ reason: expect.stringContaining('MarkerLine') }),
      expect.objectContaining({ layer: 'network_lines', reason: expect.stringContaining('text-buffer') }),
    ]));
  });

  it('keeps categorized SVG bindings and exposes unconverted label and symbol settings', () => {
    const ir = parseQgis(loadFixture('import-samples/selective_masking.qgs'), 'selective_masking.qgs');
    expect(ir.elements.map(({ name, geometry }) => [name, geometry]))
      .toEqual([['lines', 'line'], ['points', 'label'], ['polys', 'polygon'], ['polys', 'label']]);
    expect(ir.elements[0]?.style).toEqual({ strokeColor: '#ffff06', strokeWidth: { value: 1.86, unit: 'mm' } });
    expect(ir.widths.map(width => width.value)).toEqual([3.26, 1.86, 0.26].map(value => ({ value, unit: 'mm' })));
    expect(ir.typography.map(({ fontFamily, fontSize }) => ({ fontFamily, fontSize })))
      .toEqual([10, 32].map(value => ({ fontFamily: ['Sans'], fontSize: { value, unit: 'pt' } })));
    expect(ir.colors.map(color => color.value)).toEqual(['#000000', '#ffff06', '#377eb8', '#265980']);
    expect(ir.skipped.filter(item => item.reason.includes('SvgMarker'))).toHaveLength(3);
    expect(ir.skipped.some(item => item.layer === 'points' && item.reason.includes('labelsEnabled=0'))).toBe(true);
    expect(ir.bindings).toEqual([
      { source: 'qgis', layer: 'points', kind: 'field-ref', expression: 'Class' },
      ...['B52', 'Biplane', 'Jet'].map(value => ({ source: 'qgis', layer: value, family: 'points', kind: 'field-ref', expression: value })),
      { source: 'qgis', layer: 'points', kind: 'field-ref', expression: 'Heading' },
      { source: 'qgis', layer: 'polys', kind: 'field-ref', expression: 'Name' },
    ]);
    expect(ir.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: 'B52', reason: expect.stringContaining('SvgMarker') }),
      expect.objectContaining({ layer: 'lines', reason: expect.stringContaining('多个符号图层') }),
      expect.objectContaining({ layer: 'polys', reason: expect.stringContaining('text-mask') }),
    ]));
  });
});
