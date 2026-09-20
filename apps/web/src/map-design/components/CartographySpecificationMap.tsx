import { useEffect, useMemo, useRef, useState } from 'react';
import { Map, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import type { CartographyMapElement, CartographySampleBindings } from '@mapseekai/map-design-contracts';
import { Alert, AlertDescription } from '@mapseekai/components';
import { useI18n } from '../../i18n';
import { cartographyPreviewCopy } from '../../i18n/locales/cartography-preview';
import { cartographyCopy } from '../../i18n/locales/cartography';
import { buildCartographySampleStyle } from '../map/cartography-sample-style';

export default function CartographySpecificationMap({ elements, sampleBindings }: { elements: CartographyMapElement[]; sampleBindings?: CartographySampleBindings }) {
  const { locale } = useI18n();
  const copy = cartographyPreviewCopy[locale];
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const result = useMemo(() => buildCartographySampleStyle(elements, locale, sampleBindings), [elements, locale, sampleBindings]);
  useEffect(() => {
    if (!container.current) return;
    let map: Map | undefined;
    let observer: ResizeObserver | undefined;
    setFailed(false);
    try {
      setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');
      map = new Map({ container: container.current, style: result.style, bounds: [[0, 0], [0.02156, 0.01437]], fitBoundsOptions: { padding: 24 }, localIdeographFontFamily: false, attributionControl: false, maplibreLogo: false });
      map.addControl(new NavigationControl(), 'top-right');
      map.on('error', () => setFailed(true));
      observer = new ResizeObserver(() => map?.resize());
      observer.observe(container.current);
    } catch { setFailed(true); }
    return () => { observer?.disconnect(); map?.remove(); };
  }, [result]);
  const matched = result.bindings.filter((binding) => binding.element).length;
  return <section className="flex min-w-0 flex-col gap-4" aria-label={copy.mapTitle}>
    <p className="text-xs text-muted-foreground">{copy.mapHint}</p>
    {failed ? <Alert variant="destructive"><AlertDescription>{cartographyCopy[locale].error}</AlertDescription></Alert> : null}
    <div ref={container} className="overflow-hidden rounded-lg border border-border" style={{ height: 320 }} />
    <details className="rounded-lg border border-border p-3">
      <summary className="cursor-pointer text-sm">{copy.mapping} · {copy.matched} {matched}/{result.bindings.length}</summary>
      <ul className="mt-3 flex list-none flex-col gap-2 p-0 text-xs">
        {result.bindings.map((binding) => <li key={binding.key} className="flex flex-wrap justify-between gap-2 border-b border-border py-2">
          <span className="break-all font-mono">{binding.key}</span>
          <span className="break-all text-muted-foreground">{binding.element ? `${binding.element} · ` : ''}{binding.viaAgent ? 'Agent · ' : ''}{copy[binding.status]}{binding.unsupported.length ? ` (${binding.unsupported.join(', ')})` : ''}</span>
        </li>)}
      </ul>
    </details>
  </section>;
}
