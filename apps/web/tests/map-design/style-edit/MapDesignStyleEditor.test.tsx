// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MapDesignStyleEditor } from '../../../src/map-design/style-edit/MapDesignStyleEditor';

const client = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../../../src/map-design/style-edit/client', () => ({ saveMapStyleEdit: client.save }));

function mapMock(features: unknown[]) {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const canvas = document.createElement('canvas');
  const container = document.createElement('div'); container.append(canvas); document.body.append(container); canvas.tabIndex = 0;
  const paint = new Map<string, unknown>([['line-color', '#111111'], ['line-opacity', 0.5], ['line-width', 2]]);
  const layer = { id: 'roads', type: 'line', source: 'transport', 'source-layer': 'road', paint: Object.fromEntries(paint) };
  return {
    paint, canvas, container,
    getRenderWorldCopies: () => false, getContainer: () => container,
    on: vi.fn((name: string, fn: (event: unknown) => void) => { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); }),
    off: vi.fn((name: string, fn: (event: unknown) => void) => listeners.get(name)?.delete(fn)),
    listenerCount: (name: string) => listeners.get(name)?.size ?? 0,
    emit(name: string, event: unknown) { for (const fn of listeners.get(name) ?? []) fn(event); },
    queryRenderedFeatures: vi.fn(() => features),
    getStyle: vi.fn(() => ({ sources: { transport: { type: 'vector' } }, layers: [layer] })),
    getLayer: vi.fn(() => layer), getCanvas: vi.fn(() => canvas), getCanvasContainer: vi.fn(() => container),
    addLayer: vi.fn(), removeLayer: vi.fn(),
    isStyleLoaded: () => true, getSource: () => ({}),
    unproject: vi.fn(([x, y]: [number, number]) => ({ lng: x, lat: y })), project: vi.fn(([x, y]: [number, number]) => ({ x, y })),
    getPaintProperty: vi.fn((_id: string, property: string) => paint.get(property)), getLayoutProperty: vi.fn(),
    setPaintProperty: vi.fn((_id: string, property: string, value: unknown) => paint.set(property, value)), setLayoutProperty: vi.fn(),
  };
}

const road = (id: number, name: string) => ({ id, layer: { id: 'roads', type: 'line' }, source: 'transport', sourceLayer: 'road', properties: { name }, geometry: { type: 'LineString', coordinates: [[10, 20], [11, 21]] } });
const HASH_1 = '1'.repeat(64);
const HASH_2 = '2'.repeat(64);
const success = { draftRevision: 4, styleHash: HASH_2, changedLayers: [], changedSources: [], diff: [], warnings: [], validationSummary: { valid: true, errors: [], warnings: [] } };

beforeEach(() => { client.save.mockReset(); });
afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('MapDesignStyleEditor', () => {
  it('previews and saves picker alpha as HEX without changing color on open', async () => {
    const map = mapMock([road(1, 'Main Street')]);
    client.save.mockResolvedValue(success);
    render(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active disabled={false} onSaved={vi.fn()} />);
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    fireEvent.click(await screen.findByRole('button', { name: /Edit style: Color/ }));
    const alpha = await screen.findByRole('slider', { name: 'α' });
    expect(map.paint.get('line-color')).toBe('#111111');
    fireEvent.keyDown(alpha, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Color', hidden: true })).toHaveValue('#111111fc'));
    fireEvent.keyDown(alpha, { key: 'Escape' });
    fireEvent.click(await screen.findByRole('button', { name: 'Save style' }));
    await waitFor(() => expect(client.save).toHaveBeenCalled());
    expect(JSON.stringify(client.save.mock.calls[0])).toContain('#111111fc');
  });

  it('edits line layout and dash arrays in the correct sections', async () => {
    const map = mapMock([road(1, 'Main Street')]);
    client.save.mockResolvedValue(success);
    render(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active disabled={false} onSaved={vi.fn()} />);
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    expect(await screen.findByLabelText('Dash pattern')).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Line join' }), { key: 'ArrowDown' });
    fireEvent.keyDown(await screen.findByRole('option', { name: 'round' }), { key: 'Enter' });
    await waitFor(() => expect(map.setLayoutProperty).toHaveBeenCalledWith('roads', 'line-join', ['case', ['==', ['id'], 1], 'round', 'miter']));
    fireEvent.click(screen.getByRole('button', { name: 'Entire layer' }));
    fireEvent.change(screen.getByLabelText('Dash pattern'), { target: { value: '2, 4' } });
    await waitFor(() => expect(map.paint.get('line-dasharray')).toEqual([2, 4]));
    fireEvent.click(screen.getByRole('button', { name: 'Save style' }));
    await waitFor(() => expect(client.save).toHaveBeenCalled());
    expect(client.save.mock.calls[0]?.[1].changes).toMatchObject({ 'line-join': 'round', 'line-dasharray': [2, 4] });
  });

  it('waits for a feature pick before displaying the editor', () => {
    const map = mapMock([]);
    render(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active disabled={false} onSaved={vi.fn()} />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(map.listenerCount('click')).toBe(1);
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    map.queryRenderedFeatures.mockReturnValue([road(1, 'Main Street')]);
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    expect(screen.getByRole('heading')).toBeInTheDocument();
  });

  it('returns to overlapping candidates and restores the preview before choosing another', async () => {
    const map = mapMock([road(1, 'Main Street'), road(2, 'Broadway')]);
    const view = render(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active disabled={false} onSaved={vi.fn()} />);
    expect(map.canvas.style.cursor).toContain('data:image/svg+xml');
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    fireEvent.click(await screen.findByRole('button', { name: /Main Street/ }));
    fireEvent.change(await screen.findByLabelText('Color'), { target: { value: '#ff0000' } });
    fireEvent.click(screen.getByRole('button', { name: /Choose/ }));
    expect(map.paint.get('line-color')).toBe('#111111');
    fireEvent.click(screen.getByRole('button', { name: /Broadway/ }));
    fireEvent.change(await screen.findByLabelText('Color'), { target: { value: '#00ff00' } });
    expect(map.paint.get('line-color')).toEqual(['case', ['==', ['id'], 2], '#00ff00', '#111111']);
    fireEvent.click(screen.getByRole('button', { name: 'Close style editor' }));
    expect(map.paint.get('line-color')).toBe('#111111');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(map.canvas.style.cursor).toContain('data:image/svg+xml');
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    expect(screen.getByRole('button', { name: /Broadway/ })).toBeInTheDocument();
    view.unmount();
    expect(map.canvas.style.cursor).toBe('');
  });

  it('rejects out-of-range and empty numeric input without applying a preview', async () => {
    const map = mapMock([road(1, 'Main Street')]);
    render(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active disabled={false} onSaved={vi.fn()} />);
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    const opacity = await screen.findByLabelText('Opacity');
    fireEvent.change(opacity, { target: { value: '2' } });
    expect(opacity).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save style' })).toBeDisabled();
    expect(map.paint.get('line-opacity')).toBe(0.5);
    fireEvent.change(opacity, { target: { value: '' } });
    expect(opacity).toHaveValue(null);
    expect(screen.getByRole('button', { name: 'Save style' })).toBeDisabled();
    fireEvent.change(opacity, { target: { value: '0.25' } });
    expect(opacity).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByRole('button', { name: 'Save style' })).toBeEnabled();
    expect(map.paint.get('line-opacity')).toEqual(['case', ['==', ['id'], 1], 0.25, 0.5]);
  });

  it('keeps unsupported scoped expressions out of the preview and allows an entire-layer fallback', async () => {
    const map = mapMock([road(1, 'Main Street')]);
    map.getStyle.mockReturnValue({ sources: { transport: { type: 'vector' } }, layers: [{ id: 'roads', type: 'line', source: 'transport', 'source-layer': 'road', paint: { 'line-width': ['let', 'factor', 2, ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 4]] } }] } as never);
    render(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active disabled={false} onSaved={vi.fn()} />);
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    fireEvent.change(await screen.findByLabelText('Width'), { target: { value: '6' } });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save style' })).toBeDisabled();
    expect(map.paint.get('line-width')).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Entire layer' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save style' })).toBeEnabled();
    expect(map.paint.get('line-width')).toBe(6);
  });

  it('requires a choice for overlapping hits and previews the pinned selection', async () => {
    const map = mapMock([road(1, 'Main Street'), road(2, 'Broadway')]);
    render(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active disabled={false} onSaved={vi.fn()} />);
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    expect(await screen.findByRole('button', { name: /Main Street/ })).toBeInTheDocument();
    expect(map.listenerCount('click')).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: /Main Street/ }));
    const color = await screen.findByLabelText('Color');
    fireEvent.change(color, { target: { value: '#ff0000' } });
    await waitFor(() => expect(map.paint.get('line-color')).toEqual(['case', ['==', ['id'], 1], '#ff0000', '#111111']));
    expect(screen.getByText(/Main Street/)).toBeInTheDocument();
    expect(map.listenerCount('click')).toBe(1);
  });

  it('resets a new pick to feature scope instead of retaining an entire-layer edit', async () => {
    const map = mapMock([road(1, 'Main Street')]);
    render(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active disabled={false} onSaved={vi.fn()} />);
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    fireEvent.click(screen.getByRole('button', { name: 'Entire layer' }));
    map.queryRenderedFeatures.mockReturnValue([road(2, 'Broadway')]);
    act(() => map.emit('click', { point: { x: 12, y: 22 }, lngLat: { lng: 12, lat: 22 } }));
    fireEvent.change(await screen.findByLabelText('Color'), { target: { value: '#ff0000' } });
    await waitFor(() => expect(map.paint.get('line-color')).toEqual(['case', ['==', ['id'], 2], '#ff0000', '#111111']));
  });

  it('restores on cancel but never restores an older preview after a canonical version change', async () => {
    const map = mapMock([road(1, 'Main Street')]);
    const view = render(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active disabled={false} onSaved={vi.fn()} />);
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    fireEvent.change(await screen.findByLabelText('Color'), { target: { value: '#ff0000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(map.paint.get('line-color')).toBe('#111111');

    view.rerender(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active disabled={false} onSaved={vi.fn()} />);
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    fireEvent.change(await screen.findByLabelText('Color'), { target: { value: '#00ff00' } });
    map.paint.set('line-color', '#0000ff');
    view.rerender(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={4} styleHash={HASH_2} active disabled={false} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.queryByLabelText('Color')).not.toBeInTheDocument());
    expect(map.paint.get('line-color')).toBe('#0000ff');
  });

  it('removes the previous feature predicate when switching preview scope', async () => {
    const map = mapMock([road(1, 'Main Street')]);
    render(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active disabled={false} onSaved={vi.fn()} />);
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    fireEvent.change(await screen.findByLabelText('Color'), { target: { value: '#ff0000' } });
    await waitFor(() => expect(map.paint.get('line-color')).toEqual(['case', ['==', ['id'], 1], '#ff0000', '#111111']));
    fireEvent.click(screen.getByRole('button', { name: 'Entire layer' }));
    await waitFor(() => expect(map.paint.get('line-color')).toBe('#ff0000'));
  });

  it('shows MapLibre defaults for absent properties and leaves expressions blank', async () => {
    const map = mapMock([road(1, 'Main Street')]);
    map.paint.delete('line-opacity');
    map.paint.set('line-width', ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 4]);
    render(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active disabled={false} onSaved={vi.fn()} />);
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    expect(await screen.findByLabelText('Opacity')).toHaveValue(1);
    expect(screen.getByLabelText('Width')).toHaveValue(null);
    expect(screen.getByLabelText('Width')).toHaveAttribute('placeholder', '—');
    expect(screen.getByRole('button', { name: 'Save style' })).toBeDisabled();
  });

  it('retains failed edits, completes successful saves, and supports map keyboard picking', async () => {
    client.save.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(success);
    const map = mapMock([road(1, 'Main Street')]);
    Object.defineProperty(map.canvas, 'getBoundingClientRect', { value: () => ({ width: 200, height: 100 }) });
    const onSaved = vi.fn();
    render(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active disabled={false} onSaved={onSaved} />);
    fireEvent.keyDown(map.canvas, { key: 'Enter' });
    fireEvent.change(await screen.findByLabelText('Width'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save style' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved');
    expect(screen.getByLabelText('Width')).toHaveValue(6);
    fireEvent.click(screen.getByRole('button', { name: 'Save style' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(client.save).toHaveBeenLastCalledWith('p1', expect.objectContaining({ expectedRevision: 3, styleHash: HASH_1, changes: expect.objectContaining({ 'line-width': 6 }) }), expect.any(AbortSignal));
    expect(client.save.mock.calls[0]![1].idempotencyKey).toBe(client.save.mock.calls[1]![1].idempotencyKey);
  });

  it('blocks close paths during save and ignores completion after parent deactivation', async () => {
    let resolveSave!: (value: typeof success) => void;
    client.save.mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));
    const map = mapMock([road(1, 'Main Street')]);
    const onSaved = vi.fn();
    const view = render(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active disabled={false} onSaved={onSaved} />);
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    fireEvent.change(await screen.findByLabelText('Color'), { target: { value: '#abcd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save style' }));
    expect(screen.getByRole('button', { name: 'Close style editor' })).toBeDisabled();
    fireEvent.keyDown(map.canvas, { key: 'Escape' });
    const signal = client.save.mock.calls[0]![2] as AbortSignal;
    view.rerender(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active={false} disabled={false} onSaved={onSaved} />);
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await act(async () => resolveSave(success));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

it('blank map click must expose the existing empty-hit feedback', () => {
  const map = mapMock([]);
  render(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active disabled={false} onSaved={vi.fn()} />);
  act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
  expect(screen.queryByRole('alert')).not.toBeNull();
});
it('picking another feature during save must preserve the pending editor', async () => {
  const map = mapMock([road(1, 'Main Street')]);
  let resolveSave!: (value: unknown) => void;
  client.save.mockImplementation(() => new Promise(resolve => { resolveSave = resolve; }));
  render(<MapDesignStyleEditor projectId="p1" map={map as never} draftRevision={3} styleHash={HASH_1} active disabled={false} onSaved={vi.fn()} />);
  act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
  fireEvent.change(await screen.findByLabelText('Color'), { target: { value: '#ff0000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save style' }));
  expect(client.save).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/Main Street/)).not.toBeNull();
  map.queryRenderedFeatures.mockReturnValue([road(2, 'Broadway')]);
  act(() => map.emit('click', { point: { x: 11, y: 21 }, lngLat: { lng: 11, lat: 21 } }));
  const switchedWhileSaving = screen.queryByText(/Broadway/) !== null;
  await act(async () => resolveSave(success));
  expect(switchedWhileSaving).toBe(false);
});

it('reuses feature eligibility during input and restores focus to the edit trigger', async () => {
  const map = mapMock([road(1, 'Main Street')]);
  const trigger = document.createElement('button'); document.body.append(trigger);
  const props = { projectId: 'p1', map: map as never, draftRevision: 3, styleHash: HASH_1, active: true, disabled: false, onSaved: vi.fn(), finalFocus: { current: trigger } };
  const view = render(<MapDesignStyleEditor {...props} />);
  act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
  await screen.findByLabelText('Width');
  map.getStyle.mockClear();
  fireEvent.change(screen.getByLabelText('Width'), { target: { value: '6' } });
  fireEvent.change(screen.getByLabelText('Width'), { target: { value: '7' } });
  expect(map.getStyle).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(trigger).toHaveFocus());
  view.unmount();
});
