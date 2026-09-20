import { Popover, PopoverContent } from '@mapseekai/components';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';

export function MapCommentPopover({ map, anchor, open, onClose, initialFocus, finalFocus, label, children }: {
  map: MapLibreMap | null; anchor: [number, number] | null; open: boolean; onClose(): void;
  initialFocus?: RefObject<HTMLTextAreaElement>; finalFocus: RefObject<HTMLButtonElement>; label: string; children: ReactNode;
}) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!map || !open) return;
    const update = () => setRevision((value) => value + 1);
    map.on('move', update); map.on('resize', update);
    return () => { map.off('move', update); map.off('resize', update); };
  }, [map, open]);
  // MapLibre supplies the geographic point; the standard Popover owns all
  // placement, collision avoidance, content sizing and focus management.
  const reference = useMemo(() => map && anchor ? {
    contextElement: map.getCanvas(),
    getBoundingClientRect: () => {
      const canvas = map.getCanvas().getBoundingClientRect();
      const longitude = map.getRenderWorldCopies()
        ? anchor[0] + 360 * Math.round((map.getCenter().lng - anchor[0]) / 360) : anchor[0];
      const point = map.project([longitude, anchor[1]]);
      return new DOMRect(canvas.x + point.x - 14, canvas.y + point.y - 14, 28, 28);
    },
  } : null, [anchor, map, revision]);

  return <Popover open={open && reference !== null} onOpenChange={(next, details) => {
    if (next) return;
    const target = details.event.target;
    if ((details.reason === 'outside-press' || details.reason === 'focus-out') && target instanceof Node && map?.getContainer().contains(target)) {
      details.cancel(); return;
    }
    onClose();
  }}>
    <PopoverContent anchor={reference} collisionBoundary={map?.getCanvas()} collisionPadding={8}
      collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'end' }} side="right" sideOffset={8}
      initialFocus={initialFocus} finalFocus={finalFocus} aria-label={label} data-comment-editor
      className="overflow-hidden" style={{ width: '20rem', maxWidth: 'var(--available-width)', maxHeight: 'var(--available-height)' }}>
      {children}
    </PopoverContent>
  </Popover>;
}
