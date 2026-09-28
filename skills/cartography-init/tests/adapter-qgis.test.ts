import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { parseQgis } from '../src/adapters/qgis.js';
import { initializeCartography } from '../src/index.js';
import { loadFixture } from './helpers.js';

describe('parseQgis', () => {
  it('preserves QGIS 3.40 extended RGB colors and Point units in QGZ drafts', () => {
    const xml = `<qgis><projectlayers><maplayer><layername>管线</layername>
      <renderer-v2 type="singleSymbol"><symbols><symbol type="line" name="0">
        <layer class="SimpleLine"><Option type="Map">
          <Option name="line_color" value="225,89,137,255,rgb:0.88235294117647056,0.34901960784313724,0.53725490196078429,1"/>
          <Option name="line_width" value="0.6"/><Option name="line_width_unit" value="Point"/>
        </Option></layer></symbol></symbols></renderer-v2>
      <labeling><settings><text-style fontFamily="SimSun" fontSize="12" fontSizeUnit="Point"/></settings></labeling>
      </maplayer></projectlayers></qgis>`;
    const archive = Buffer.from(zipSync({ '测试配置编号图.qgs': Buffer.from(xml) }));
    const ir = parseQgis(archive, '测试配置编号图.qgz');
    expect(ir.elements.find(element => element.geometry === 'line')?.style).toEqual({
      strokeColor: '#e15989', strokeWidth: { value: 0.6, unit: 'pt' },
    });
    expect(ir.typography[0]?.fontSize).toEqual({ value: 12, unit: 'pt' });
    const draft = initializeCartography(archive, '测试配置编号图.qgz', 'QGIS 3.40');
    expect(draft.source).toContain('#e15989');
    expect(draft.source).toContain('0.6pt');
    expect(draft.source).toContain('SimSun');
  });

  it('extracts single symbols with unit and color conversion', () => {
    const ir = parseQgis(loadFixture('qgis-min.qgs'), 'qgis-min.qgs');
    expect(ir.source.kind).toBe('qgis');
    const road = ir.elements.find((e) => e.name === 'roads');
    expect(road?.geometry).toBe('line');
    expect(road?.style.strokeColor).toBe('#dd8844');
    expect(road?.style.strokeWidth).toEqual({ value: 0.26, unit: 'mm' });
    expect(ir.datasources.some((d) => d.identity.includes('ogr'))).toBe(true);
  });

  it('skips QGIS units outside the allowed mapping table', () => {
    const cmProject = loadFixture('qgis-min.qgs').toString('utf8').replace('v="MM"', 'v="CM"');
    const ir = parseQgis(Buffer.from(cmProject), 'qgis-cm.qgs');
    expect(ir.elements[0]?.style.strokeWidth).toBeUndefined();
    expect(ir.skipped).toContainEqual(expect.objectContaining({ layer: 'roads', reason: expect.stringContaining('CM') }));
  });

  it('unpacks QGZ archives identified by their ZIP signature', () => {
    const ir = parseQgis(Buffer.from(zipSync({ 'project.qgs': loadFixture('qgis-min.qgs') })), 'project.qgz');
    expect(ir.elements).toHaveLength(1);
    expect(ir.elements[0]?.name).toBe('roads');
  });

  it('imports modern QGZ properties and reports unsupported symbols without emitting empty elements', () => {
    const xml = `<qgis><projectlayers><maplayer><layername>roads</layername>
      <renderer-v2 type="singleSymbol"><symbols><symbol type="line" name="0">
        <layer class="SimpleLine"><Option type="Map">
          <Option name="line_color" value="221,136,68,255"/>
          <Option name="line_width" value="1.06"/>
          <Option name="line_width_unit" value="MM"/>
        </Option><data_defined_properties><Option><Option name="line_color" value="0,0,0,255"/></Option></data_defined_properties></layer>
        <layer class="MarkerLine"><symbol type="marker"><layer class="SimpleMarker">
          <Option><Option name="color" value="0,0,0,255"/></Option>
        </layer></symbol></layer>
      </symbol></symbols></renderer-v2></maplayer>
      <maplayer><layername>texture</layername><renderer-v2 type="singleSymbol"><symbols>
        <symbol type="fill" name="0"><layer class="RasterFill"/></symbol>
      </symbols></renderer-v2></maplayer></projectlayers></qgis>`;
    const archive = Buffer.from(zipSync({ 'project.qgs': Buffer.from(xml) }));
    const ir = parseQgis(archive, 'project.qgz');
    expect(ir.elements).toHaveLength(1);
    expect(ir.elements[0]?.style).toEqual({ strokeColor: '#dd8844', strokeWidth: { value: 1.06, unit: 'mm' } });
    const draft = initializeCartography(archive, 'project.qgz', 'Modern QGIS');
    expect(draft.source).toContain('#dd8844');
    const report = JSON.parse(draft.reportJson);
    expect(report.statistics.elements).toBe(1);
    expect(report.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: 'roads', reason: expect.stringContaining('MarkerLine') }),
      expect.objectContaining({ layer: 'texture', reason: expect.stringContaining('RasterFill') }),
    ]));
  });

  it('keeps rule symbols as one family and routes filter expressions to bindings', () => {
    const ir = parseQgis(loadFixture('qgis-rulebased.qgs'), 'qgis-rulebased.qgs');
    const fam = ir.elements.filter((e) => e.family === 'roads');
    expect(fam.length).toBe(2);
    expect(ir.bindings.some((b) => b.kind === 'filter' && b.expression.includes('highway'))).toBe(true);
    expect(ir.bindings.some((b) => b.kind === 'field-override')).toBe(true);
    for (const e of ir.elements) expect(JSON.stringify(e)).not.toContain('"highway"');
  });
});
