import { describe, expect, it, vi } from 'vitest';

import { createStylePreviewSession } from '../../../src/map-design/style-edit/preview';

function mapMock() {
  const layer = { id: 'land' };
  const values = new Map<string, unknown>([['fill-color', '#111111'], ['fill-opacity', 0.4]]);
  return {
    values,
    getLayer: vi.fn((): { id: string } | undefined => layer),
    getPaintProperty: vi.fn((_layer: string, property: string) => values.get(property)),
    getLayoutProperty: vi.fn(),
    setPaintProperty: vi.fn((_layer: string, property: string, value: unknown) => { values.set(property, value); }),
    setLayoutProperty: vi.fn(),
  };
}

describe('style preview session', () => {
  it('updates consecutive values without a baseline reset or transition delay', () => {
    const map = mapMock();
    map.values.set('fill-color-transition', { duration: 800, delay: 100 });
    const preview = createStylePreviewSession(map as never, 'land', [{ property: 'fill-color' }]);
    preview.apply({ paint: { 'fill-color': '#ff0000' }, layout: {} });
    expect(map.values.get('fill-color-transition')).toEqual({ duration: 0, delay: 0 });
    map.setPaintProperty.mockClear();
    preview.apply({ paint: { 'fill-color': '#00ff00' }, layout: {} });
    expect(map.setPaintProperty).toHaveBeenCalledExactlyOnceWith('land', 'fill-color', '#00ff00');
    preview.apply({ paint: { 'fill-color': '#00ff00' }, layout: {} });
    expect(map.setPaintProperty).toHaveBeenCalledTimes(1);
    preview.discard();
    expect(map.values.get('fill-color')).toBe('#00ff00');
    expect(map.values.get('fill-color-transition')).toEqual({ duration: 800, delay: 100 });
  });

  it('keeps one paint expression during continuous feature color updates and cleans up on save', () => {
    const map = { ...mapMock(), getSource: vi.fn(() => ({})), setFeatureState: vi.fn(), removeFeatureState: vi.fn() };
    const feature = { source: 'countries', sourceLayer: 'country', id: 9 };
    const preview = createStylePreviewSession(map as never, 'land', [{ property: 'fill-color' }], feature);
    const patch = (color: string) => ({ paint: { 'fill-color': ['case', ['==', ['id'], 9], color, '#111111'] }, layout: {} });
    for (const color of ['#ff0000', '#00ff00', '#0000ff']) preview.apply(patch(color));
    expect(map.setPaintProperty.mock.calls.filter(([, property]) => property === 'fill-color')).toHaveLength(1);
    expect(map.setFeatureState).toHaveBeenCalledTimes(3);
    const stateKey = Object.keys(map.setFeatureState.mock.calls[0]![1])[0]!;
    expect(map.setFeatureState).toHaveBeenLastCalledWith(feature, { [stateKey]: '#0000ff' });
    preview.apply(patch('#0000ff'));
    expect(map.setFeatureState).toHaveBeenCalledTimes(3);
    preview.discard();
    expect(map.values.get('fill-color')).toEqual(patch('#0000ff').paint['fill-color']);
    expect(map.removeFeatureState).toHaveBeenCalledWith(feature, stateKey);
  });

  it('restores the original color and removes only its own feature state on cancel', () => {
    const map = { ...mapMock(), getSource: vi.fn(() => ({})), setFeatureState: vi.fn(), removeFeatureState: vi.fn() };
    const feature = { source: 'countries', id: 9 };
    const preview = createStylePreviewSession(map as never, 'land', [{ property: 'fill-color' }], feature);
    preview.apply({ paint: { 'fill-color': ['case', ['==', ['id'], 9], '#ff0000', '#111111'] }, layout: {} });
    preview.restore();
    expect(map.values.get('fill-color')).toBe('#111111');
    expect(map.removeFeatureState).toHaveBeenCalledWith(feature, expect.stringContaining('mapdesign-preview-'));
  });

  it('does not access removed map style properties during cleanup or later apply', () => {
    const map = mapMock();
    const preview = createStylePreviewSession(map as never, 'land', [{ property: 'fill-color' }]);
    preview.apply({ paint: { 'fill-color': '#ff0000' }, layout: {} });
    map.getLayer.mockReturnValue(undefined);
    map.getPaintProperty.mockImplementation(() => { throw new TypeError('Map style has been removed.'); });
    map.getLayoutProperty.mockImplementation(() => { throw new TypeError('Map style has been removed.'); });
    map.setPaintProperty.mockClear();
    expect(() => preview.restore()).not.toThrow();
    expect(() => preview.apply({ paint: { 'fill-color': '#00ff00' }, layout: {} })).not.toThrow();
    expect(map.setPaintProperty).not.toHaveBeenCalled();
  });

  it('does not restore a deleted layer into a new layer with the same id', () => {
    const map = mapMock();
    const preview = createStylePreviewSession(map as never, 'land', [{ property: 'fill-color' }]);
    preview.apply({ paint: { 'fill-color': '#ff0000' }, layout: {} });
    map.getLayer.mockReturnValue({ id: 'land' });
    map.setPaintProperty.mockClear();
    preview.restore();
    expect(map.values.get('fill-color')).toBe('#ff0000');
    expect(map.setPaintProperty).not.toHaveBeenCalled();
  });

  it('does not apply to a layer removed before the next preview', () => {
    const map = mapMock();
    const preview = createStylePreviewSession(map as never, 'land', [{ property: 'fill-color' }]);
    map.getLayer.mockReturnValue(undefined);
    map.getPaintProperty.mockImplementation(() => { throw new TypeError('Map style has been removed.'); });
    preview.apply({ paint: { 'fill-color': '#00ff00' }, layout: {} });
    expect(map.setPaintProperty).not.toHaveBeenCalled();
  });

  it('makes a session for an already missing layer inert without reading its properties', () => {
    const map = mapMock();
    map.getLayer.mockReturnValue(undefined);
    map.getPaintProperty.mockImplementation(() => { throw new TypeError('Map style has been removed.'); });
    const preview = createStylePreviewSession(map as never, 'land', [{ property: 'fill-color' }]);
    preview.apply({ paint: { 'fill-color': '#00ff00' }, layout: {} });
    preview.restore();
    expect(map.getPaintProperty).not.toHaveBeenCalled();
    expect(map.setPaintProperty).not.toHaveBeenCalled();
  });

  it('starts each scope preview from the original style', () => {
    const map = mapMock();
    const preview = createStylePreviewSession(map as never, 'land', [{ property: 'fill-color' }, { property: 'fill-opacity' }]);
    preview.apply({ paint: { 'fill-color': ['case', true, '#f00', '#111111'] }, layout: {} });
    preview.apply({ paint: { 'fill-opacity': 0.8 }, layout: {} });
    expect(map.values.get('fill-color')).toBe('#111111');
    expect(map.values.get('fill-opacity')).toBe(0.8);
  });

  it('restores originals on cancel but can discard a stale session', () => {
    const map = mapMock();
    const preview = createStylePreviewSession(map as never, 'land', [{ property: 'fill-color' }]);
    preview.apply({ paint: { 'fill-color': '#f00' }, layout: {} });
    preview.restore();
    expect(map.values.get('fill-color')).toBe('#111111');

    const stale = createStylePreviewSession(map as never, 'land', [{ property: 'fill-color' }]);
    stale.apply({ paint: { 'fill-color': '#0f0' }, layout: {} });
    map.values.set('fill-color', '#00f');
    stale.discard();
    stale.restore();
    expect(map.values.get('fill-color')).toBe('#00f');
  });

  it('does not overwrite a canonical style applied before revision props arrive', () => {
    const map = mapMock();
    const preview = createStylePreviewSession(map as never, 'land', [{ property: 'fill-color' }]);
    preview.apply({ paint: { 'fill-color': '#ff0000' }, layout: {} });
    map.values.set('fill-color', '#0000ff');
    preview.restore();
    expect(map.values.get('fill-color')).toBe('#0000ff');
  });

  it('never restores an untouched property over a concurrent canonical update', () => {
    const map = mapMock();
    const preview = createStylePreviewSession(map as never, 'land', [{ property: 'fill-color' }, { property: 'fill-opacity' }]);
    preview.apply({ paint: { 'fill-color': '#ff0000' }, layout: {} });
    map.values.set('fill-opacity', 0.9);
    preview.restore();
    expect(map.values.get('fill-color')).toBe('#111111');
    expect(map.values.get('fill-opacity')).toBe(0.9);
  });
});

it('does not install unsupported transition properties for boolean paint controls', () => {
  const map = mapMock();
  const preview = createStylePreviewSession(map as never, 'land', [{ property: 'fill-antialias', section: 'paint', transition: false }]);
  preview.apply({ paint: { 'fill-antialias': false }, layout: {} });
  expect(map.values.get('fill-antialias')).toBe(false);
  expect(map.values.has('fill-antialias-transition')).toBe(false);
  preview.restore();
  expect(map.values.get('fill-antialias')).toBeNull();
});
