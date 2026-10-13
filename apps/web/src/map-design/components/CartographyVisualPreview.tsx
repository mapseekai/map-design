import { lazy, Suspense, useState } from 'react';
import { MapLoading, Button } from '@mapseekai/components';
import type { CartographyPreview } from '@mapseekai/map-design-contracts';
import { useI18n } from '../../i18n';
import { cartographyPreviewCopy } from '../../i18n/locales/cartography-preview';

const SpecificationMap = lazy(() => import('./CartographySpecificationMap'));

export function CartographyVisualPreview({ preview, name, compact = false }: {
  preview?: CartographyPreview; name: string; compact?: boolean;
}) {
  const { locale } = useI18n();
  const copy = cartographyPreviewCopy[locale];
  const [view, setView] = useState<'tokens' | 'map'>('tokens');
  const colors = preview?.palette ?? [];
  if (compact) return <span className="flex overflow-hidden rounded border border-border" style={{ width: 44, height: 40 }} aria-label={`${copy.palette}: ${name}`}>
    {colors.length ? colors.slice(0, 5).map((color) => <span key={color.name} className="flex-1" style={{ backgroundColor: color.color }} />)
      : <span className="flex flex-1 items-center justify-center text-muted-foreground" aria-label={copy.noColors}>—</span>}
  </span>;
  return <div className="flex min-w-0 flex-col gap-5">
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant={view === 'tokens' ? 'secondary' : 'ghost'} aria-pressed={view === 'tokens'} onClick={() => setView('tokens')}>{copy.palette} / {copy.typography}</Button>
      <Button type="button" variant={view === 'map' ? 'secondary' : 'ghost'} aria-pressed={view === 'map'} onClick={() => setView('map')}>{copy.mapTitle}</Button>
    </div>
    {view === 'map' ? <Suspense fallback={<div className="grid h-80 place-items-center"><MapLoading label={copy.mapTitle} /></div>}><SpecificationMap key={`${name}:${JSON.stringify([preview?.elements, preview?.sampleBindings])}`} elements={preview?.elements ?? []} sampleBindings={preview?.sampleBindings} /></Suspense> : <div className="flex flex-col gap-8">
    <section aria-label={copy.palette} className="flex flex-col gap-4">
      <h3 className="text-sm font-medium">{copy.palette}</h3>
      {colors.length ? <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
        {colors.map((color) => <div key={color.name} className="overflow-hidden rounded-lg border border-border bg-card">
          <div style={{ height: 80, backgroundColor: color.color }} aria-label={`${color.name}: ${color.color}`} />
          <div className="space-y-1 p-3"><p className="break-all text-sm font-medium">{color.name}</p><p className="break-all font-mono text-xs text-muted-foreground">{color.color}</p></div>
        </div>)}
      </div> : <p className="text-sm text-muted-foreground">{copy.noColors}</p>}
    </section>
    <section aria-label={copy.typography} className="flex flex-col gap-4">
      <h3 className="text-sm font-medium">{copy.typography}</h3>
      {preview?.typography?.length ? <>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
          {preview.typography.map((token) => <div key={token.name} className="min-w-0 rounded-lg border border-border bg-card p-4">
            <div className="mb-5" style={{ fontFamily: token.fontFamily, fontSize: 40, fontWeight: token.fontWeight }}>Aa</div>
            <p className="break-all text-sm font-medium">{token.name}</p>
            <p className="mt-1 break-words text-xs text-muted-foreground">{token.fontFamily.replaceAll('"', '')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{[token.fontSize, token.fontWeight].filter((value) => value !== undefined).join(' · ')}</p>
          </div>)}
        </div><p className="mt-3 text-xs text-muted-foreground">{copy.fontNote}</p>
      </> : <p className="text-sm text-muted-foreground">{copy.noFonts}</p>}
    </section>
    </div>}
  </div>;
}
