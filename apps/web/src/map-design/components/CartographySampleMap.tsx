import { useState } from 'react';
import { Map, NavigationControl } from 'maplibre-gl';
import { Alert, AlertDescription } from '@mapseekai/components';
import { MapLibreCanvas } from '../map/MapLibreCanvas';
import { useI18n } from '../../i18n';
import { cartographyPreviewCopy } from '../../i18n/locales/cartography-preview';
import { cartographyCopy } from '../../i18n/locales/cartography';

export default function CartographySampleMap() {
  const { locale } = useI18n();
  const [failed, setFailed] = useState(false);
  return <main className="mx-auto flex max-w-7xl flex-col gap-4 p-6">
    <header className="flex flex-wrap items-center justify-between gap-4">
      <h1 className="font-serif text-2xl">Riverside · GeoJSON</h1>
      <nav className="flex flex-wrap gap-4 text-sm" aria-label="GeoJSON">
        {['riverside.geojson', 'style.json', 'manifest.json', 'README.md'].map((file) => <a key={file} className="text-primary underline" href={`/cartography-sample/${file}`} download>{file}</a>)}
      </nav>
    </header>
    {failed ? <Alert variant="destructive"><AlertDescription>{cartographyCopy[locale].error}</AlertDescription></Alert> : null}
    <div className="overflow-hidden rounded-xl border border-border" style={{ height: 440 }}>
      <MapLibreCanvas style="/cartography-sample/style.json" className="h-full w-full"
        createMap={(options) => new Map({ ...options, bounds: [[0, 0], [0.02156, 0.01437]], fitBoundsOptions: { padding: 32 }, localIdeographFontFamily: 'sans-serif' })}
        onMapReady={(map) => { (map as Map).addControl(new NavigationControl(), 'top-right'); }}
        onMapError={() => setFailed(true)} />
    </div>
    <p className="text-xs text-muted-foreground">MapLibre GL JS · EPSG:4326 · {cartographyPreviewCopy[locale].sampleData}</p>
  </main>;
}
