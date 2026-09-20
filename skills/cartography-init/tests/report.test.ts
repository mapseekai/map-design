import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkReportTriage, renderReportJson, renderReportMarkdown } from '../src/report.js';
import { consolidate } from '../src/consolidate.js';
import { emptyExtracted } from '../src/ir.js';

function sampleIr() {
  const ir = emptyExtracted({ kind: 'qgis', name: 'Demo' });
  ir.elements.push({ name: 'roads', geometry: 'line', family: 'roads', roleHint: 'primary', style: { strokeColor: '#dd8844' }, scaleHints: [] });
  ir.colors.push({ value: '#dd8844', nameHint: 'roads', usedBy: ['roads'] });
  ir.bindings.push({ source: 'qgis', layer: 'roads', family: 'roads', kind: 'filter', expression: '"highway" = \'primary\'' });
  ir.datasources.push({ source: 'qgis', layer: 'roads', identity: 'ogr:/data/roads.shp', providerType: 'ogr' });
  ir.unresolved.push({ topic: 'target tile source url/type', detail: 'QGIS 工程不含瓦片源定义' });
  ir.skipped.push({ source: 'qgis', layer: 'roads', reason: '嵌套符号层特效' });
  return ir;
}

describe('report', () => {
  it('json backfills symbolRef from the name map', () => {
    const ir = sampleIr();
    const json = JSON.parse(renderReportJson(ir, consolidate(ir)));
    expect(json.bindings[0].symbolRef).toBe('roads');
    expect(json.datasources[0].identity).toContain('ogr:');
    expect(json.unresolved).toHaveLength(1);
  });

  it('overwrites an existing symbolRef with the consolidated name', () => {
    const ir = sampleIr();
    const [binding] = ir.bindings;
    if (!binding) throw new Error('sample binding missing');
    binding.symbolRef = 'outdated-roads';
    const consolidated = consolidate(ir);
    consolidated.nameMap.set('roads', 'different');

    const json = JSON.parse(renderReportJson(ir, consolidated));
    expect(json.bindings[0].symbolRef).toBe('different');
  });

  it('markdown lists skipped and a next-steps checklist', () => {
    const md = renderReportMarkdown(sampleIr(), consolidate(sampleIr()));
    expect(md).toContain('嵌套符号层特效');
    expect(md).toContain('bindings');
    expect(md).toContain('补写');
  });

  it.each(['prose', 'runtime', 'discard'])('checkReportTriage accepts the %s decision', decision => {
    const dir = mkdtempSync(path.join(tmpdir(), 'report-'));
    const file = path.join(dir, 'INIT_REPORT.json');
    const ir = sampleIr();
    const triaged = JSON.parse(renderReportJson(ir, consolidate(ir)));
    triaged.bindings[0].triage = { decision, note: '已分诊' };
    writeFileSync(file, JSON.stringify(triaged, null, 2));

    expect(checkReportTriage(file)).toEqual({ ok: true, pending: [] });
  });

  it('checkReportTriage keeps bindings with an invalid decision pending', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'report-'));
    const file = path.join(dir, 'INIT_REPORT.json');
    const ir = sampleIr();
    const triaged = JSON.parse(renderReportJson(ir, consolidate(ir)));
    triaged.bindings[0].triage = { decision: 'anything', note: '垃圾值' };
    writeFileSync(file, JSON.stringify(triaged, null, 2));

    expect(checkReportTriage(file)).toEqual({
      ok: false,
      pending: ['roads+"highway" = \'primary\''],
    });
  });
});
