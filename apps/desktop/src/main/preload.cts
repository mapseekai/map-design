const { contextBridge, ipcRenderer } = require('electron');

import type {
  MapDesignAppearance,
  MapDesignHostActionResult,
  MapDesignHostBridge,
  MapDesignHostPickWorkingDirectoryResult,
} from '@mapseekai/contracts';

const MAP_DESIGN_HOST_GLOBAL: typeof import('@mapseekai/contracts').MAP_DESIGN_HOST_GLOBAL = '__mapDesign__';
const MAP_DESIGN_HOST_VERSION: typeof import('@mapseekai/contracts').MAP_DESIGN_HOST_VERSION = 1;

if (process.platform === 'darwin') {
  ipcRenderer.on('map-design:window:fullscreen', (_event: Electron.IpcRendererEvent, fullscreen: unknown) => {
    if (typeof fullscreen !== 'boolean') return;
    document.documentElement?.style.setProperty('--app-titlebar-inset-left', fullscreen ? '12px' : '88px');
  });
}

function actionFailure(): MapDesignHostActionResult {
  return { ok: false, message: 'Unable to complete the desktop action.' };
}

function pickerFailure(): MapDesignHostPickWorkingDirectoryResult {
  return { ok: false, message: 'Unable to choose a working directory.' };
}

function normalizePickerResult(value: unknown): MapDesignHostPickWorkingDirectoryResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return pickerFailure();
  const candidate = value as { ok?: unknown; cancelled?: unknown; path?: unknown; token?: unknown };
  if (candidate.ok === false && candidate.cancelled === true) return { ok: false, cancelled: true };
  if (candidate.ok !== true || typeof candidate.path !== 'string' || typeof candidate.token !== 'string') {
    return pickerFailure();
  }
  const path = candidate.path.trim();
  const token = candidate.token.trim();
  if (
    path.length > 0 && path.length <= 4_096
    && token.length >= 16 && token.length <= 4_096
  ) return { ok: true, path, token };
  return pickerFailure();
}

const bridge = Object.freeze({
  version: MAP_DESIGN_HOST_VERSION,
  client: Object.freeze({ type: 'desktop' as const, platform: process.platform }),
  appearance: Object.freeze({
    setTheme: (theme: MapDesignAppearance): void => {
      ipcRenderer.send('map-design:appearance:set-theme', theme);
    },
  }),
  project: Object.freeze({
    pickWorkingDirectory: (): Promise<MapDesignHostPickWorkingDirectoryResult> =>
      ipcRenderer.invoke('map-design:project:pick-working-directory')
        .then(normalizePickerResult)
        .catch(pickerFailure),
  }),
  shell: Object.freeze({
    openExternal: (url: string): Promise<MapDesignHostActionResult> =>
      ipcRenderer.invoke('map-design:shell:open-external', url)
        .then((opened: unknown) => opened === true ? { ok: true } : actionFailure())
        .catch(actionFailure),
  }),
} satisfies MapDesignHostBridge);

contextBridge.exposeInMainWorld(MAP_DESIGN_HOST_GLOBAL, bridge);
