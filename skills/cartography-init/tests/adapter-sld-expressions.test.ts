import { describe, expect, it } from 'vitest';
import { parseSld } from '../src/adapters/sld.js';
import { initializeCartography } from '../src/index.js';
import { verifyDocument } from '../src/verify.js';

const categorizedStyle = `<StyledLayerDescriptor xmlns:ogc="http://www.opengis.net/ogc">
  <NamedLayer><UserStyle><FeatureTypeStyle>
    <Rule><Name>Population</Name><PolygonSymbolizer><Fill><CssParameter name="fill">
      <ogc:Function name="Categorize">
        <ogc:Div><ogc:PropertyName>PERSONS</ogc:PropertyName><ogc:PropertyName>LAND_KM</ogc:PropertyName></ogc:Div>
        <ogc:Literal>#87CEEB</ogc:Literal><ogc:Literal>20</ogc:Literal>
        <ogc:Literal>#FFFACD</ogc:Literal><ogc:Literal>100</ogc:Literal><ogc:Literal>#F08080</ogc:Literal>
      </ogc:Function>
    </CssParameter></Fill></PolygonSymbolizer></Rule>
    <Rule><Name>State labels</Name><MaxScaleDenominator>10000000</MaxScaleDenominator>
      <TextSymbolizer><Label><ogc:PropertyName>STATE_NAME</ogc:PropertyName></Label></TextSymbolizer>
    </Rule>
  </FeatureTypeStyle></UserStyle></NamedLayer>
</StyledLayerDescriptor>`;

describe('SLD expression imports', () => {
  it('retains literal palette and reports dynamic parameters when a fill uses Categorize', () => {
    // Given / When
    const ir = parseSld(categorizedStyle, 'categorized.sld');
    // Then
    expect(ir.colors.map((color) => color.value)).toEqual(['#87CEEB', '#FFFACD', '#F08080']);
    expect(ir.bindings).toContainEqual(expect.objectContaining({
      kind: 'field-override', layer: 'Population', expression: expect.stringContaining('Categorize'),
    }));
    expect(ir.skipped.some((item) => item.layer === 'Population')).toBe(true);
    expect(ir.elements).toEqual([]);
    expect(ir.typography).toEqual([]);
    expect(ir.skipped.some((item) => item.layer === 'State labels')).toBe(true);
  });

  it('produces a valid document when expressions and incomplete labels have no static style', () => {
    // Given / When
    const result = initializeCartography(Buffer.from(categorizedStyle), 'categorized.sld', 'Population');
    // Then
    expect(verifyDocument(result.source).ok).toBe(true);
    expect(result.source).toContain('#87CEEB');
    expect(result.source).toContain('#FFFACD');
    expect(result.source).toContain('#F08080');
  });

  it('keeps explicit literal parameters and static style beside unsupported expressions', () => {
    // Given
    const source = `<StyledLayerDescriptor><Rule><Name>Area</Name><PolygonSymbolizer>
      <Fill><SvgParameter name="fill"><Literal>#112233</Literal></SvgParameter></Fill>
      <Stroke><SvgParameter name="stroke"><Function name="env"><Literal>stroke</Literal></Function></SvgParameter>
      <SvgParameter name="stroke-width">2</SvgParameter></Stroke>
    </PolygonSymbolizer></Rule></StyledLayerDescriptor>`;
    // When
    const ir = parseSld(source);
    // Then
    expect(ir.elements[0]?.style).toEqual({ fillColor: '#112233', strokeWidth: { value: 2, unit: 'px' } });
    expect(ir.colors.map((color) => color.value)).toEqual(['#112233']);
    expect(ir.bindings).toHaveLength(1);
  });
});
