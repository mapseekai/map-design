import { createMapResourceTransform } from '../map/resource-request';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, Button, Empty, EmptyDescription, EmptyHeader, MapLoading } from '@mapseekai/components';

import { useT } from '../../i18n';
import { MapLibreCanvas, type MapLibreCanvasProps } from '../map/MapLibreCanvas';
import { parseMapSourceUrl } from '../map/source-url';

export const SOURCE_PREVIEW_DEBOUNCE_MS = 400;
export const SOURCE_PREVIEW_TIMEOUT_MS = 30_000;
type PreviewProps = Pick<MapLibreCanvasProps, 'maplibre' | 'createMap'> & { sourceUrl: string };

/** Read-only browser preview; project imports still use the daemon. */
export function MapSourcePreview({ sourceUrl, ...mapProps }: PreviewProps) {
  const t = useT();
  const url = parseMapSourceUrl(sourceUrl);
  const [settledUrl, setSettledUrl] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledUrl(url), SOURCE_PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [url]);
  // Remove the old map immediately when the input changes.
  const activeUrl = url && url === settledUrl ? url : null;

  return (
    <section className="relative isolate min-h-96 w-full overflow-hidden rounded-xl border border-border bg-muted md:min-h-[480px]"
      role="region" aria-label={t('mapDesign.preview.title')}>
      {activeUrl ? <DirectStylePreview key={`${activeUrl}:${attempt}`} sourceUrl={activeUrl}
        onRetry={() => setAttempt((value) => value + 1)} {...mapProps} /> : (
        <Empty className="absolute inset-0"><EmptyHeader><EmptyDescription>
          {sourceUrl.trim() && !url ? t('mapDesign.preview.invalidUrl') : t('mapDesign.preview.hint')}
        </EmptyDescription></EmptyHeader></Empty>
      )}
    </section>
  );
}

function DirectStylePreview({ sourceUrl, onRetry, ...mapProps }: PreviewProps & { onRetry(): void }) {
  const t = useT();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<'load' | 'resource' | 'webgl' | null>(null);
  const readyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const timeout = window.setTimeout(() => {
      if (!readyRef.current) setError((current) => current ?? 'load');
    }, SOURCE_PREVIEW_TIMEOUT_MS);
    return () => { mounted.current = false; window.clearTimeout(timeout); };
  }, []);
  const handleLoad = () => {
    if (!mounted.current) return;
    readyRef.current = true;
    setReady(true);
    setError((current) => current === 'resource' ? current : null);
  };
  return (
    <div className="absolute inset-0" aria-busy={!ready && !error} data-preview-ready={ready ? 'true' : 'false'}>
      <MapLibreCanvas style={sourceUrl} resourceGateway={false}
        className="absolute inset-0 size-full" {...mapProps}
        transformRequest={createMapResourceTransform({ origin: window.location.origin, sourceUrl })}
        onMapLoad={handleLoad}
        onMapError={(event) => {
          if (mounted.current) setError(event?.webglUnavailable ? 'webgl' : readyRef.current || event?.sourceId || event?.status ? 'resource' : 'load');
        }}
      />
      {!ready && !error ? <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <MapLoading label={t('common.loading')} />
      </div> : null}
      <div className="absolute inset-x-3 bottom-9 flex flex-col gap-2">
        {error ? <Alert variant={ready ? 'default' : 'destructive'} appearance="floating"><AlertDescription>
          {error === 'webgl' ? t('mapDesign.preview.webglUnavailable') : error === 'resource' ? t('mapDesign.preview.resourceError') : t('mapDesign.preview.loadError')}
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>{t('mapDesign.preview.retry')}</Button>
        </AlertDescription></Alert> : null}
      </div>
    </div>
  );
}
