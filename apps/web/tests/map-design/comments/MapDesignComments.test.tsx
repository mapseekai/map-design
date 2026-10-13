// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MapComment } from '@mapseekai/map-design-contracts';
import { MapDesignComments } from '../../../src/map-design/comments/MapDesignComments';

const client = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../../src/map-design/comments/client', () => ({
  listMapComments: client.list,
  saveMapComment: client.save,
  deleteMapComment: client.remove,
}));

function comment(overrides: Partial<MapComment> = {}): MapComment {
  return {
    id: 'comment-1', projectId: 'project-1', version: 1, text: 'Use a calmer road color',
    target: { layerId: 'roads', sourceId: 'transport', sourceLayer: 'road', featureId: 0,
      properties: { class: 'primary', lanes: 2 }, anchor: [10, 20], geometryType: 'LineString' },
    scope: 'feature', draftRevision: 3, styleHash: 'hash-1', status: 'draft', runId: null,
    createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z', ...overrides,
  };
}

function mapMock(features: unknown[] = []) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const sources = new Map<string, { data: unknown; setData(data: unknown): void }>();
  const layers = new Map<string, unknown>();
  const images = new Set<string>();
  const canvas = document.createElement('canvas');
  const container = document.createElement('div');
  container.append(canvas); document.body.append(container);
  canvas.tabIndex = 0;
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  return {
    sources, layers,
    on: vi.fn((name: string, layerOrFn: string | ((event: unknown) => void), fn?: (event: unknown) => void) => {
      const key = typeof layerOrFn === 'string' ? `${name}:${layerOrFn}` : name;
      const set = listeners.get(key) ?? new Set(); set.add(fn ?? layerOrFn as (event: unknown) => void); listeners.set(key, set);
    }),
    off: vi.fn((name: string, layerOrFn: string | ((event: unknown) => void), fn?: (event: unknown) => void) => listeners.get(typeof layerOrFn === 'string' ? `${name}:${layerOrFn}` : name)?.delete(fn ?? layerOrFn as (event: unknown) => void)),
    queryRenderedFeatures: vi.fn(() => features),
    getStyle: vi.fn(() => ({ sources: { transport: { type: 'vector' } } })),
    addLayer: vi.fn((layer: { id: string }) => layers.set(layer.id, layer)), getLayer: (id: string) => layers.get(id), removeLayer: (id: string) => layers.delete(id),
    isStyleLoaded: () => true, getSource: (id: string) => sources.get(id) ?? (id === 'transport' ? {} : undefined),
    addSource: (id: string, source: { data: unknown }) => sources.set(id, { data: source.data, setData(data) { this.data = data; } }),
    removeSource: (id: string) => sources.delete(id),
    hasImage: (id: string) => images.has(id), addImage: (id: string) => images.add(id), removeImage: (id: string) => images.delete(id),
    clickMarker(id: string) { for (const [key, handlers] of listeners) if (key.startsWith('click:__map-design-comments:')) for (const fn of handlers) fn({ features: [{ properties: { commentId: id } }] }); },
    getCanvas: vi.fn(() => canvas),
    getRenderWorldCopies: () => false, getCenter: () => ({ lng: 0 }),
    getContainer: vi.fn(() => container),
    getCanvasContainer: vi.fn(() => container),
    unproject: vi.fn(([x, y]: [number, number]) => ({ lng: x, lat: y })),
    project: vi.fn(([lng, lat]: [number, number]) => ({ x: lng, y: lat })),
    flyTo: vi.fn(),
    emit(name: string, event: unknown) { for (const fn of listeners.get(name) ?? []) fn(event); },
  };
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), drawImage: vi.fn(), fillText: vi.fn(), getImageData: () => ({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) }) } as never);
  client.list.mockReset().mockResolvedValue([]);
  client.save.mockReset();
  client.remove.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('MapDesignComments', () => {
  it('edits and deletes a saved draft from its popover using its existing id and version', async () => {
    const saved = comment();
    client.list.mockResolvedValue([saved]);
    client.save.mockResolvedValue({ ...saved, text: 'Updated instruction', version: 2 });
    const map = mapMock();
    render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1" readOnly={false} submissionDisabled={false} onSubmit={vi.fn()} />);
    await screen.findByRole('button', { name: /^1\. roads/ });
    fireEvent.click(screen.getByRole('button', { name: /^1\. roads/ }));
    const editor = await screen.findByRole('dialog');
    const textbox = within(editor).getByRole('textbox', { name: 'Comment' });
    expect(textbox).toBeEnabled();
    fireEvent.change(textbox, { target: { value: 'Updated instruction' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(client.save).toHaveBeenCalledWith('project-1', expect.objectContaining({ id: saved.id, version: 1, text: 'Updated instruction', target: saved.target }), expect.any(AbortSignal)));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^1\. roads/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(client.remove).toHaveBeenCalledWith('project-1', saved.id, 2, expect.any(AbortSignal)));
    expect(screen.queryByRole('button', { name: /^1\. roads/ })).not.toBeInTheDocument();
  });

  it('does not overlap slow comment polls and aborts the pending request on unmount', async () => {
    const interval = vi.spyOn(window, 'setInterval');
    client.list.mockResolvedValue([comment({ status: 'submitted' })]);
    const view = render(<MapDesignComments projectId="project-1" map={null} draftRevision={3} styleHash="hash-1" readOnly={false} submissionDisabled={false} onSubmit={vi.fn()} />);
    await waitFor(() => expect(interval.mock.calls.some(([, ms]) => ms === 1500)).toBe(true));
    const poll = interval.mock.calls.find(([, ms]) => ms === 1500)![0] as () => Promise<void>;
    let finish!: (comments: MapComment[]) => void;
    client.list.mockImplementationOnce(() => new Promise<MapComment[]>(resolve => { finish = resolve; }));
    const pending = poll();
    await poll();
    expect(client.list).toHaveBeenCalledTimes(2);
    const signal = client.list.mock.calls[1]![1] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    finish([]); await pending;
    interval.mockRestore();
  });

  it('clears successful comments from markers, list, count and open popover while keeping retries', async () => {
    const interval = vi.spyOn(window, 'setInterval');
    const submitted = comment({ status: 'submitted' });
    const failed = comment({ id: 'failed', status: 'failed', text: 'Retry failed' });
    const canceled = comment({ id: 'canceled', status: 'canceled', text: 'Retry canceled' });
    client.list.mockResolvedValue([submitted, failed, canceled, comment({ id: 'old-success', status: 'succeeded' })]);
    const count = vi.fn(); const map = mapMock();
    render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1" readOnly={false} submissionDisabled={false} onSubmit={vi.fn()} onCountChange={count} />);
    await waitFor(() => expect(count).toHaveBeenLastCalledWith(3));
    act(() => map.clickMarker(submitted.id));
    client.list.mockResolvedValue([{ ...submitted, status: 'succeeded' }, failed, canceled]);
    const poll = interval.mock.calls.at(-1)![0] as () => void;
    await act(async () => poll());
    await waitFor(() => expect(count).toHaveBeenLastCalledWith(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Retry failed')).toBeInTheDocument();
    expect(screen.getByText('Retry canceled')).toBeInTheDocument();
    expect([...map.sources.values()][0]!.data).toMatchObject({ features: [{ id: 'failed' }, { id: 'canceled' }] });
    expect(client.remove).not.toHaveBeenCalled();
    interval.mockRestore();
  });

  it('starts a fresh comment when repicking after viewing a saved draft', async () => {
    client.list.mockResolvedValue([comment()]);
    const map = mapMock([{ id: 2, layer: { id: 'roads' }, source: 'transport', properties: {}, geometry: { type: 'Point', coordinates: [12, 22] } }]);
    render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1" readOnly={false} submissionDisabled={false} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Annotate' }));
    fireEvent.click(await screen.findByRole('button', { name: /^1\. roads/ }));
    expect(screen.getByRole('textbox', { name: 'Comment' })).toBeEnabled();
    act(() => map.emit('click', { point: { x: 12, y: 22 }, lngLat: { lng: 12, lat: 22 } }));
    expect(screen.getByRole('textbox', { name: 'Comment' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Add comment' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^1\. roads/ })).toHaveTextContent('Use a calmer road color');
  });

  it('reveals the full truncated target when its badge receives keyboard focus', async () => {
    const map = mapMock([{ id: 1, layer: { id: 'a-very-long-layer-name' }, source: 'transport', properties: {}, geometry: { type: 'Point', coordinates: [10, 20] } }]);
    render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1" readOnly={false} submissionDisabled={false} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Annotate' }));
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    const label = await screen.findByText(/^Selected target:/);
    expect(label).toHaveClass('truncate');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Tab' });
    act(() => label.parentElement!.focus());
    expect(label.parentElement).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('a-very-long-layer-name');
  });

  it('places tools in the header and the list in the inspector, opening an editor only after picking', async () => {
    const toolbar = document.createElement('div'); const list = document.createElement('div');
    document.body.append(toolbar, list);
    const map = mapMock([{ id: 1, layer: { id: 'roads' }, source: 'transport', properties: {}, geometry: { type: 'Point', coordinates: [10, 20] } }]);
    render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1"
      readOnly={false} submissionDisabled={false} onSubmit={vi.fn()} toolbarHost={toolbar} listHost={list} />);
    expect(toolbar.querySelector('button')).not.toBeNull();
    expect(list).toHaveTextContent('New comment');
    expect(list.querySelector('h2')).toBeNull();
    fireEvent.click(toolbar.querySelector('button')!);
    expect(screen.queryByRole('textbox', { name: 'Comment' })).not.toBeInTheDocument();
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    expect(await screen.findByRole('textbox', { name: 'Comment' })).toBeInTheDocument();
    expect(list.querySelector('textarea')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Comment' }).closest('[data-slot="popover-content"]')).not.toBeNull();
    expect(screen.getByRole('textbox', { name: 'Comment' }).closest('[data-slot="card"]')).toBeNull();
  });
  it('requires an explicit choice for overlapping rendered features and keeps draft text while repicking', async () => {
    const map = mapMock([
      { id: 1, layer: { id: 'roads' }, source: 'transport', sourceLayer: 'road', properties: { name: 'Main St' }, geometry: { type: 'LineString', coordinates: [[10, 20], [11, 21]] } },
      { id: 2, layer: { id: 'labels' }, source: 'transport', sourceLayer: 'road', properties: { name: 'Main St' }, geometry: { type: 'Point', coordinates: [10, 20] } },
    ]);
    render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1"
      readOnly={false} submissionDisabled={false} onSubmit={vi.fn()} />);
    await screen.findByRole('button', { name: 'Annotate' });
    fireEvent.click(screen.getByRole('button', { name: 'Annotate' }));
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 }, originalEvent: { target: map.getCanvas() } }));
    expect(await screen.findAllByRole('button', { name: /Main St/ })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: /Main St/ })[0]!);
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'Keep this sentence' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entire layer' }));

    act(() => map.emit('click', { point: { x: 12, y: 22 }, lngLat: { lng: 12, lat: 22 }, originalEvent: { target: map.getCanvas() } }));
    expect(screen.queryByRole('textbox', { name: 'Comment' })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /Main St/ })[1]!);
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('Keep this sentence');
    expect(screen.getByRole('button', { name: 'This feature' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not silently expand a missing-id pick to matching properties or the entire layer', async () => {
    const map = mapMock([{ layer: { id: 'roads' }, source: 'transport', sourceLayer: 'road',
      properties: { class: 'primary' }, geometry: { type: 'LineString', coordinates: [[10, 20], [11, 21]] } }]);
    render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1"
      readOnly={false} submissionDisabled={false} onSubmit={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Annotate' }));
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'Only this road' } });
    expect(screen.getByRole('button', { name: 'Add comment' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send now' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Entire layer' }));
    expect(screen.getByRole('button', { name: 'Add comment' })).toBeEnabled();
  });

  it('retains a failed immediate submission and its editable text', async () => {
    const saved = comment({ transient: true });
    const onCountChange = vi.fn();
    client.list.mockResolvedValue([saved]);
    client.save.mockResolvedValue(saved);
    const onSubmit = vi.fn().mockResolvedValue(false);
    const map = mapMock([{ id: 0, layer: { id: 'roads' }, source: 'transport', sourceLayer: 'road',
      properties: { class: 'primary', lanes: 2 }, geometry: { type: 'LineString', coordinates: [[10, 20], [11, 21]] } }]);
    render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1"
      readOnly={false} submissionDisabled={false} onSubmit={onSubmit} onCountChange={onCountChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Annotate' }));
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 }, originalEvent: { target: map.getCanvas() } }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Comment' }), { target: { value: 'Use a calmer road color' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([saved]));
    expect(client.save.mock.calls[0]?.[1]).toMatchObject({ transient: true });
    expect(onCountChange).toHaveBeenLastCalledWith(0);
    expect(JSON.stringify([...map.sources.entries()].filter(([id]) => id.startsWith('__map-design-comments')))).not.toContain('commentId');
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('Use a calmer road color');
    expect(screen.getByRole('alert')).toHaveTextContent('could not be submitted');
    expect(screen.getByRole('button', { name: 'Send now' })).toBeEnabled();
  });

  it('shows persisted markers and prevents mutation in history', async () => {
    client.list.mockResolvedValue([comment()]);
    const map = mapMock();
    render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1"
      readOnly submissionDisabled onSubmit={vi.fn()} />);

    await waitFor(() => expect(map.sources.size).toBe(1));
    act(() => map.clickMarker('comment-1'));
    expect(map.flyTo).toHaveBeenCalledWith(expect.objectContaining({ center: [10, 20] }));
    expect(screen.getByRole('button', { name: 'Annotate' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('keeps generated feature ids unavailable when reopening a saved layer comment', async () => {
    client.list.mockResolvedValue([comment({ scope: 'layer' })]);
    const map = mapMock();
    map.getStyle.mockReturnValue({ sources: { transport: { type: 'geojson', generateId: true } } } as never);
    render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1" readOnly={false} submissionDisabled={false} onSubmit={vi.fn()} />);
    await waitFor(() => expect(map.sources.size).toBe(1));
    act(() => map.clickMarker('comment-1'));
    expect(screen.getByRole('button', { name: 'This feature' })).toBeDisabled();
  });

  it('keeps a picked target stale across map revisions until it is repicked', async () => {
    const map = mapMock([{ id: 1, layer: { id: 'roads' }, source: 'transport', properties: {}, geometry: { type: 'Point', coordinates: [10, 20] } }]);
    const view = render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1" readOnly={false} submissionDisabled={false} onSubmit={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Annotate' }));
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 370, lat: 20 }, originalEvent: { target: map.getCanvas() } }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Comment' }), { target: { value: 'Keep me' } });
    view.rerender(<MapDesignComments projectId="project-1" map={map as never} draftRevision={4} styleHash="hash-2" readOnly={false} submissionDisabled={false} onSubmit={vi.fn()} />);
    expect(screen.getByText(/older map draft/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send now' })).toBeDisabled();
  });

  it('renders native marker points without per-frame DOM projection', async () => {
    client.list.mockResolvedValue([comment()]);
    const map = mapMock();
    render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1" readOnly={false} submissionDisabled={false} onSubmit={vi.fn()} />);
    await waitFor(() => expect(map.sources.size).toBe(1));
    expect([...map.sources.values()][0]?.data).toMatchObject({ features: [{ geometry: { type: 'Point', coordinates: [10, 20] } }] });
    expect(map.project).not.toHaveBeenCalled();
    expect(map.getContainer().querySelector('button')).toBeNull();
  });

  it('releases the mutation lock after an immediate submission and reload', async () => {
    client.save.mockResolvedValueOnce(comment()).mockResolvedValueOnce(comment({ id: 'comment-2' }));
    const onSubmit = vi.fn().mockResolvedValue(true);
    const map = mapMock([{ id: 1, layer: { id: 'roads' }, source: 'transport', properties: {}, geometry: { type: 'Point', coordinates: [10, 20] } }]);
    render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1" readOnly={false} submissionDisabled={false} onSubmit={onSubmit} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Annotate' }));
    for (const value of ['First', 'Second']) {
      act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 }, originalEvent: { target: map.getCanvas() } }));
      fireEvent.change(await screen.findByRole('textbox', { name: 'Comment' }), { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(value === 'First' ? 1 : 2));
    }
    expect(client.save).toHaveBeenCalledTimes(2);
  });

  it('reloads after a rejected batch while keeping every selected comment checked', async () => {
    const saved = [comment(), comment({ id: 'comment-2', text: 'Second' })];
    client.list.mockResolvedValue(saved);
    const onSubmit = vi.fn().mockResolvedValue(false);
    const map = mapMock();
    render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1" readOnly={false} submissionDisabled={false} onSubmit={onSubmit} />);
    await waitFor(() => expect(map.sources.size).toBe(1));
    act(() => map.clickMarker('comment-1'));
    const checks = screen.getAllByRole('checkbox');
    checks.forEach((checkbox) => fireEvent.click(checkbox));
    fireEvent.click(screen.getByRole('button', { name: 'Send selected' }));
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    expect(checks.every((checkbox) => checkbox.getAttribute('aria-checked') === 'true' || checkbox.getAttribute('data-checked') !== null)).toBe(true);
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('could not be submitted'))).toBe(true);
  });

  it('waits for the initial list before saving so existing comments cannot disappear', async () => {
    let resolveList!: (comments: MapComment[]) => void;
    client.list.mockReturnValueOnce(new Promise<MapComment[]>((resolve) => { resolveList = resolve; }));
    client.save.mockResolvedValue(comment());
    const map = mapMock([{ id: 1, layer: { id: 'roads' }, source: 'transport', properties: {}, geometry: { type: 'Point', coordinates: [10, 20] } }]);
    render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1" readOnly={false} submissionDisabled={false} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Annotate' }));
    act(() => map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 }, originalEvent: { target: map.getCanvas() } }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Comment' }), { target: { value: 'Saved while loading' } });
    expect(screen.getByRole('button', { name: 'Add comment' })).toBeDisabled();
    expect(client.save).not.toHaveBeenCalled();
    await act(async () => resolveList([comment({ id: 'existing', text: 'Existing comment' })]));
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    await waitFor(() => expect(screen.getByText('Use a calmer road color')).toBeInTheDocument());
    expect(screen.getByText('Existing comment')).toBeInTheDocument();
    expect(screen.queryByText('Loading comments…')).not.toBeInTheDocument();
  });

  it('removes a deleted id from the 20-item batch selection', async () => {
    const saved = Array.from({ length: 21 }, (_, index) => comment({ id: `comment-${index + 1}`, text: `Comment ${index + 1}` }));
    client.list.mockResolvedValue(saved);
    const map = mapMock();
    render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1" readOnly={false} submissionDisabled={false} onSubmit={vi.fn()} />);
    await waitFor(() => expect(map.sources.size).toBe(1));
    act(() => map.clickMarker('comment-1'));
    for (let index = 1; index <= 20; index += 1) fireEvent.click(screen.getByRole('checkbox', { name: `Select comment ${index}` }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    await waitFor(() => expect(client.remove).toHaveBeenCalledTimes(1));
    const newlyAvailable = screen.getByRole('checkbox', { name: 'Select comment 20' });
    fireEvent.click(newlyAvailable);
    expect(newlyAvailable).toBeChecked();
  });

  it('leaves immutable comment details through an explicit new-comment action', async () => {
    client.list.mockResolvedValue([comment({ status: 'submitted' })]);
    const map = mapMock([{ id: 2, layer: { id: 'labels' }, source: 'transport', properties: {}, geometry: { type: 'Point', coordinates: [12, 22] } }]);
    render(<MapDesignComments projectId="project-1" map={map as never} draftRevision={3} styleHash="hash-1" readOnly={false} submissionDisabled={false} onSubmit={vi.fn()} />);
    await waitFor(() => expect(map.sources.size).toBe(1));
    act(() => map.clickMarker('comment-1'));
    expect(screen.getByRole('textbox', { name: 'Comment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'New comment' }));
    expect(screen.getByRole('button', { name: 'Annotate' })).toHaveAttribute('aria-pressed', 'true');
    act(() => map.emit('click', { point: { x: 12, y: 22 }, lngLat: { lng: 12, lat: 22 }, originalEvent: { target: map.getCanvas() } }));
    expect(await screen.findByRole('textbox', { name: 'Comment' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('');
  });
});
