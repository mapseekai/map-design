// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useFeatureHighlight } from '../../../src/map-design/comments/feature-highlight';
import type { PickedFeature } from '../../../src/map-design/comments/feature-picking';

const selected: PickedFeature = { id: 7, source: 'roads', sourceLayer: 'road', layer: { id: 'roads' }, properties: {},
  geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } };

function fixture(ready: boolean) {
  const layers = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  const canvas = document.createElement('canvas');
  const map = {
    isStyleLoaded: () => ready,
    getStyle: () => ready ? { sources: { roads: { type: 'vector' } } } : undefined,
    getSource: () => ready ? {} : undefined,
    getCanvas: () => canvas,
    getLayer: (id: string) => layers.get(id),
    addLayer: vi.fn((layer: { id: string }) => { if (!ready) throw new Error('Style is not done loading.'); layers.set(layer.id, layer); }),
    removeLayer: (id: string) => layers.delete(id),
    on: (name: string, fn: () => void) => { const entries = listeners.get(name) ?? new Set(); entries.add(fn); listeners.set(name, entries); },
    off: (name: string, fn: () => void) => listeners.get(name)?.delete(fn),
  };
  const load = () => { ready = true; for (const fn of listeners.get('style.load') ?? []) fn(); };
  return { map, layers, listeners, load };
}

function Highlight({ map }: { map: ReturnType<typeof fixture>['map'] }) {
  useFeatureHighlight(map as never, selected);
  return null;
}
afterEach(cleanup);

it('waits for a replacement map style and cleans up native layers and pending listeners', () => {
  const first = fixture(true);
  const view = render(<Highlight map={first.map} />);
  expect(first.layers.size).toBe(1);
  const next = fixture(false);
  expect(() => view.rerender(<Highlight map={next.map} />)).not.toThrow();
  expect(first.layers.size).toBe(0);
  expect(next.layers.size).toBe(0);
  act(next.load);
  expect(next.layers.size).toBe(1);
  view.unmount();
  expect(next.layers.size).toBe(0);
  expect([...next.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  act(next.load);
  expect(next.layers.size).toBe(0);
});
