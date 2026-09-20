'use client';

import dynamic from 'next/dynamic';
import { MapLoading } from '@mapseekai/components/ui/map-loading';
import { useT } from '../../src/i18n';
import { useEffect } from 'react';


// The product is a fully client-driven SPA — every component reads
// localStorage, window.location, etc. — so we opt out of static-time
// rendering for the entire tree. This keeps `next build --output export`
// from trying to evaluate browser-only code while still emitting a real
// shell HTML the daemon can serve as the SPA fallback.
const App = dynamic(async () => {
  // Load code and play the intro in parallel: slow loads incur no extra delay.
  const duration = typeof window !== 'undefined' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 1400 : 0;
  const [module] = await Promise.all([
    import('../../src/App'),
    new Promise<void>(resolve => setTimeout(resolve, duration)),
  ]);
  return module.App;
}, {
  ssr: false,
  loading: InitialLoading,
});

function InitialLoading() {
  const t = useT();
  return <MapLoading variant="screen" label={t('common.loading')} />;
}

export function ClientApp() {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.mapDesignAppMounted = '1';

    return () => {
      root.removeAttribute('data-map-design-app-mounted');
    };
  }, []);

  return <App />;
}
