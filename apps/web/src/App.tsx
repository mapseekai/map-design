import { useCallback, useState } from 'react';
import { CartographyManager } from './map-design/CartographyManager';
import { CartographyEditor } from './map-design/CartographyEditor';
import { MapDesignProjects } from './map-design/MapDesignProjects';
import { MapDesignHome } from './map-design/MapDesignHome';
import { MapDesignSettings } from './map-design/MapDesignSettings';
import { MapDesignShell } from './map-design/MapDesignShell';
import { MapDesignWorkspace } from './map-design/MapDesignWorkspace';
import { navigate, useRoute } from './router';

export function App() {
  const route = useRoute();
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
      surface = <MapDesignWorkspace projectId={route.projectId} onMissingProject={returnHome} onOpenSettings={() => navigate({ kind: 'settings' })} />;
      break;
    case 'projects':
      surface = <MapDesignProjects onOpenProject={(projectId) => navigate({ kind: 'project', projectId })} />;
      break;
    case 'cartographies':
      surface = <CartographyManager />;
      break;
    case 'settings':
      surface = <MapDesignSettings />;
      break;
    case 'home':
      surface = <><MapDesignHome onOpenProject={(projectId) => navigate({ kind: 'project', projectId })} />{notice ? <p role="status">{notice}</p> : null}</>;
      break;
  }
  return <MapDesignShell>{surface}</MapDesignShell>;
}
