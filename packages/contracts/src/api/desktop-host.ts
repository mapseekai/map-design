export const MAP_DESIGN_HOST_GLOBAL = '__mapDesign__' as const;
export const MAP_DESIGN_HOST_VERSION = 1 as const;

export type MapDesignAppearance = 'light' | 'dark' | 'system';

export type MapDesignHostFailure = {
  ok: false;
  message: string;
};

export type MapDesignHostActionResult =
  | { ok: true }
  | MapDesignHostFailure;

export type MapDesignHostPickWorkingDirectoryResult =
  | { ok: true; path: string; token: string }
  | { ok: false; cancelled: true }
  | MapDesignHostFailure;

export interface MapDesignHostBridge {
  readonly version: typeof MAP_DESIGN_HOST_VERSION;
  readonly client: {
    readonly type: 'desktop';
    readonly osLocale?: string;
    readonly platform: string;
  };
  readonly appearance: {
    setTheme(theme: MapDesignAppearance): void;
  };
  readonly project: {
    pickWorkingDirectory(): Promise<MapDesignHostPickWorkingDirectoryResult>;
  };
  readonly shell: {
    openExternal(url: string): Promise<MapDesignHostActionResult>;
  };
}
