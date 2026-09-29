import { MapLoading } from '@mapseekai/components';
import { lazy, Suspense, useCallback, useState } from 'react';
import { useT } from './i18n';
import { MapDesignShell } from './map-design/MapDesignShell';
import { navigate, useRoute, type MapDesignRoute } from './router';
import { WorkspaceTabs, WorkspaceTabsProvider } from './map-design/WorkspaceTabs';

const CartographyManager = lazy(() => import('./map-design/CartographyManager').then((module) => ({ default: module.CartographyManager })));
const CartographyEditor = lazy(() => import('./map-design/CartographyEditor').then((module) => ({ default: module.CartographyEditor })));
const MapDesignProjects = lazy(() => import('./map-design/MapDesignProjects').then((module) => ({ default: module.MapDesignProjects })));
const MapDesignHome = lazy(() => import('./map-design/MapDesignHome').then((module) => ({ default: module.MapDesignHome })));
const MapDesignSettings = lazy(() => import('./map-design/MapDesignSettings').then((module) => ({ default: module.MapDesignSettings })));
const MapDesignWorkspace = lazy(() => import('./map-design/MapDesignWorkspace').then((module) => ({ default: module.MapDesignWorkspace })));

export function App() {
  const route = useRoute();
  return <WorkspaceTabsProvider route={route}><AppContent route={route} /></WorkspaceTabsProvider>;
}

function AppContent({ route }: { route: MapDesignRoute }) {
  const t = useT();
  const [notice, setNotice] = useState<string | null>(null);
  const returnHome = useCallback((message: string) => {
    setNotice(message);
    navigate({ kind: 'home' }, { replace: true });
  }, []);
  let surface;
  switch (route.kind) {
    case 'cartography-editor':
      surface = <CartographyEditor key={route.sessionId} sessionId={route.sessionId} />;
      break;
    case 'project':
      surface = <MapDesignWorkspace key={route.projectId} projectId={route.projectId} onMissingProject={returnHome} onOpenSettings={() => navigate({ kind: 'settings' })} />;
      break;
    case 'projects':
      surface = <MapDesignProjects onOpenProject={(projectId) => navigate({ kind: 'project', projectId })} />;
      break;
    case 'cartographies':
      surface = <CartographyManager />;
      break;
    case 'settings':
      surface = <MapDesignSettings section={route.section ?? 'models'} />;
      break;
    case 'home':
      surface = <><MapDesignHome onOpenProject={(projectId) => navigate({ kind: 'project', projectId })} />{notice ? <p role="status">{notice}</p> : null}</>;
      break;
  }
  return <MapDesignShell tabs={<WorkspaceTabs />}><Suspense fallback={<MapLoading label={t('common.loading')} />}>{surface}</Suspense></MapDesignShell>;
}
