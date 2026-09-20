// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MapComment } from '@mapseekai/map-design-contracts';
import { useCommentMarkers } from '../../../src/map-design/comments/comment-markers';

function nativeMap(ready = true) {
  const canvas = document.createElement('canvas');
  const sources = new Map<string, { data: unknown; setData(data: unknown): void }>();
  const layers = new Map<string, { id: string; type: string }>();
  const images = new Set<string>();
  const listeners = new Map<string, Set<(event?: unknown) => void>>();
  return {
    sources, layers, images, listeners,
    isStyleLoaded: () => ready, getStyle: () => ready ? {} : undefined, getCanvas: () => canvas,
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, source: { data: unknown }) => sources.set(id, { data: source.data, setData(data) { this.data = data; } }),
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) => layers.get(id), addLayer: (layer: { id: string; type: string }) => layers.set(layer.id, layer),
    removeLayer: (id: string) => layers.delete(id),
    hasImage: (id: string) => images.has(id), addImage: (id: string) => images.add(id), removeImage: (id: string) => images.delete(id),
    on(name: string, layerOrFn: string | ((event?: unknown) => void), fn?: (event?: unknown) => void) {
      const key = typeof layerOrFn === 'string' ? `${name}:${layerOrFn}` : name;
      const set = listeners.get(key) ?? new Set(); set.add(fn ?? layerOrFn as (event?: unknown) => void); listeners.set(key, set);
    },
    off(name: string, layerOrFn: string | ((event?: unknown) => void), fn?: (event?: unknown) => void) {
      listeners.get(typeof layerOrFn === 'string' ? `${name}:${layerOrFn}` : name)?.delete(fn ?? layerOrFn as (event?: unknown) => void);
    },
    load() { ready = true; for (const fn of listeners.get('style.load') ?? []) fn(); },
    click(id: string) { for (const [key, handlers] of listeners) if (key.startsWith('click:')) for (const fn of handlers) fn({ features: [{ properties: { commentId: id } }] }); },
  };
}
const comment = { id: 'comment-1', target: { anchor: [120, 30] } } as MapComment;
function Markers({ map, comments = [comment], enabled = true, onSelect = () => {}, onHover }: { map: ReturnType<typeof nativeMap>; comments?: MapComment[]; enabled?: boolean; onSelect?(comment: MapComment): void; onHover?(comment: MapComment | null): void }) {
  useCommentMarkers(map as never, comments, enabled, onSelect, null, onHover);
  return null;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('renders numbered comments through native point layers, updates source data, and handles marker clicks', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), drawImage: vi.fn(), fillText: vi.fn(), getImageData: () => ({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) }),
  } as never);
  const map = nativeMap(); const select = vi.fn();
  const view = render(<Markers map={map} onSelect={select} />);
  expect([...map.layers.values()].map((layer) => layer.type)).toEqual(['symbol']);
  expect([...map.sources.values()][0]?.data).toMatchObject({ type: 'FeatureCollection', features: [{ id: 'comment-1',
    geometry: { type: 'Point', coordinates: [120, 30] }, properties: { commentId: 'comment-1', number: 1 } }] });
  act(() => map.click('comment-1'));
  expect(select).toHaveBeenCalledWith(comment);
  view.rerender(<Markers map={map} enabled={false} onSelect={select} />);
  act(() => map.click('comment-1'));
  expect(select).toHaveBeenCalledTimes(1);
  view.rerender(<Markers map={map} comments={[]} onSelect={select} />);
  expect([...map.sources.values()][0]?.data).toMatchObject({ features: [] });
  view.unmount();
  expect([map.layers.size, map.sources.size, map.images.size]).toEqual([0, 0, 0]);
  expect([...map.listeners.values()].every((set) => set.size === 0)).toBe(true);
});

it('does not create point sources before the replacement map style has loaded', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), drawImage: vi.fn(), fillText: vi.fn(), getImageData: () => ({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) }) } as never);
  const map = nativeMap(false);
  const view = render(<Markers map={map} />);
  expect(map.sources.size).toBe(0);
  act(map.load);
  expect(map.sources.size).toBe(1);
  view.unmount();
  act(map.load);
  expect(map.sources.size).toBe(0);
});

it('reports hover and clears it on leave, disabling, and cleanup', () => {
  const map = nativeMap(false); const hover = vi.fn();
  const view = render(<Markers map={map} onHover={hover} />);
  const emit = (name: string) => { for (const [key, listeners] of map.listeners) if (key.startsWith(name + ':')) for (const listener of listeners) listener({ features: [{ properties: { commentId: comment.id } }] }); };
  act(() => emit('mouseenter'));
  expect(hover).toHaveBeenLastCalledWith(comment);
  act(() => emit('mouseleave'));
  expect(hover).toHaveBeenLastCalledWith(null);
  act(() => emit('mousemove'));
  expect(hover).toHaveBeenLastCalledWith(comment);
  view.rerender(<Markers map={map} enabled={false} onHover={hover} />);
  expect(hover).toHaveBeenLastCalledWith(null);
  view.unmount();
  expect([...map.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
});
