import { MapLoading, Alert, AlertDescription, Empty, EmptyHeader, EmptyDescription } from '@mapseekai/components';
import { assertMapDesignResourceUrl, type MapSourcePreflightOutput } from '@mapseekai/map-design-contracts';

import { useT } from '../../i18n';
import { MapLibreCanvas, type MapLibreCanvasProps } from '../map/MapLibreCanvas';
import { PMTILES_PROTOCOL } from '../map/pmtiles-protocol';
import { MAP_DESIGN_RESOURCE_PROTOCOL } from '../map/resource-protocol';

interface MapSourcePreflightProps {
  result: MapSourcePreflightOutput | null;
  loading: boolean;
  ready: boolean;
  error: string | null;
  onPreviewReady(previewId: string): void;
  onPreviewError(previewId: string): void;
  maplibre?: MapLibreCanvasProps['maplibre'];
  protocolOptions?: MapLibreCanvasProps['protocolOptions'];
  createMap?: MapLibreCanvasProps['createMap'];
}

export function MapSourcePreflight({
  result,
  loading,
  ready,
  error,
  onPreviewReady,
  onPreviewError,
  maplibre,
  protocolOptions,
  createMap,
}: MapSourcePreflightProps) {
  const t = useT();
  const preview = result?.preview ?? null;
  const origin = protocolOptions?.origin
    ?? (typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
  const transformRequest = preview ? createPreviewTransformRequest(preview, origin) : undefined;

  return (
    <section
      className="relative isolate min-h-96 w-full overflow-hidden rounded-xl border border-border bg-muted md:min-h-[480px]"
      role="region"
      aria-label={t('mapDesign.preview.title')}
      aria-busy={loading || Boolean(preview && !ready && !error)}
    >
      {loading ? <div className="absolute inset-0 grid place-items-center">
        <MapLoading label={t('common.loading')} />
      </div> : null}

      {!preview && error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {!preview && !loading && !error ? (
        <Empty className="absolute inset-0"><EmptyHeader><EmptyDescription>{t('mapDesign.preview.idle')}</EmptyDescription></EmptyHeader></Empty>
      ) : null}
      {preview ? (
        <div
          className="absolute inset-0 overflow-hidden bg-muted"
          data-preview-ready={ready ? 'true' : 'false'}
        >
          <MapLibreCanvas
            key={preview.previewId}
            style={preview.styleUrl}
            className="absolute inset-0 size-full"
            {...(maplibre ? { maplibre } : {})}
            {...(protocolOptions ? { protocolOptions } : {})}
            {...(transformRequest ? { transformRequest } : {})}
            {...(createMap ? { createMap } : {})}
            onMapIdle={() => onPreviewReady(preview.previewId)}
            onMapError={() => {
              if (!ready) onPreviewError(preview.previewId);
            }}
          />
          {!ready && !error ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted/80 text-sm text-muted-foreground backdrop-blur-sm">
              <MapLoading label={t('common.loading')} />
            </div>
          ) : null}
          {error ? <div className="absolute inset-x-3 bottom-3"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
        </div>
      ) : null}
    </section>
  );
}

function createPreviewTransformRequest(
  preview: MapSourcePreflightOutput['preview'],
  origin: string,
): NonNullable<MapLibreCanvasProps['transformRequest']> {
  const styleUrl = new URL(preview.styleUrl, origin);
  return (url) => {
    if (new URL(url, origin).href === styleUrl.href) return { url: styleUrl.href };
    if (url.startsWith(`${PMTILES_PROTOCOL}://`)) {
      assertMapDesignResourceUrl(url, preview.previewId, { origin, scope: 'source-previews' });
      return { url };
    }
    const resource = new URL(assertMapDesignResourceUrl(url, preview.previewId, {
      origin,
      scope: 'source-previews',
    }));
    return { url: `${MAP_DESIGN_RESOURCE_PROTOCOL}://${resource.pathname}` };
  };
}
