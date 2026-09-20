// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { MapCommentPopover } from '../../../src/map-design/comments/MapCommentPopover';

type Anchor = { contextElement: Element; getBoundingClientRect(): DOMRect };
const captured = vi.hoisted(() => ({ anchor: null as Anchor | null }));
vi.mock('@mapseekai/components', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ anchor, children }: { anchor: Anchor | null; children: ReactNode }) => { captured.anchor = anchor; return <>{children}</>; },
}));
afterEach(cleanup);

it('passes the projected marker to the standard positioner and refreshes it as the map moves', () => {
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => new DOMRect(100, 50, 1000, 600);
  let point = { x: 400, y: 300 };
  const listeners = new Map<string, () => void>();
  const map = { getCanvas: () => canvas, project: vi.fn(() => point), getCenter: vi.fn(() => ({ lng: 0 })), getRenderWorldCopies: vi.fn(() => false),
    on: (name: string, fn: () => void) => listeners.set(name, fn), off: (name: string) => listeners.delete(name) };
  const view = render(<MapCommentPopover map={map as never} anchor={[120, 30]} open onClose={vi.fn()} finalFocus={{ current: null }} label="Comment">Editor</MapCommentPopover>);
  const first = captured.anchor!;
  expect(first.contextElement).toBe(canvas);
  expect(first.getBoundingClientRect()).toMatchObject({ x: 486, y: 336, width: 28, height: 28 });
  expect(map.project).toHaveBeenCalledWith([120, 30]);
  point = { x: 460, y: 330 };
  act(() => listeners.get('move')?.());
  expect(captured.anchor).not.toBe(first);
  expect(captured.anchor!.getBoundingClientRect()).toMatchObject({ x: 546, y: 366 });
  map.getRenderWorldCopies.mockReturnValue(true); map.getCenter.mockReturnValue({ lng: 185 });
  view.rerender(<MapCommentPopover map={map as never} anchor={[-175, 30]} open onClose={vi.fn()} finalFocus={{ current: null }} label="Comment">Editor</MapCommentPopover>);
  captured.anchor!.getBoundingClientRect();
  expect(map.project).toHaveBeenLastCalledWith([185, 30]);
  view.unmount();
  expect(listeners.size).toBe(0);
});
