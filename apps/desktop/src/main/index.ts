import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { app, type BrowserWindow } from "electron";
import {
  MAP_DESIGN_SIDECAR_CONTRACT,
  MAP_DESIGN_SIDECAR_MESSAGES,
  normalizeMapDesignSidecarMessage,
  type MapDesignStamp,
  type WebStatusSnapshot,
} from "@mapseekai/sidecar-proto";
import { bootstrapSidecarRuntime, createJsonIpcServer, requestJsonIpc, resolveAppIpcPath, type SidecarRuntimeContext } from "@mapseekai/sidecar";
import { readProcessStamp } from "@mapseekai/platform";

import { createDesktopRuntime, type DesktopRuntime } from "./runtime.js";
import { beginDesktopSession, endDesktopSessionCleanly, markDesktopSessionRunning } from "./session-lifecycle.js";
import { attachDesktopProcessErrorFilter } from "./uncaught-exception.js";

export { createSplashWindow } from "./splash-mark.js";

export interface DesktopMainOptions {
  discoverWebUrl(): Promise<string | null>;
  discoverDaemonUrl(): Promise<string | null>;
  preloadPath: string;
  windowTitle?: string;
  splashWindow?: BrowserWindow | null;
  splashStartedAt?: number;
  beforeShutdown?(): Promise<void>;
}

export const OS_LOCALE_PRELOAD_ARG_PREFIX = "--map-design-os-locale=";

export function applyOsLocaleSwitch(electronApp: Electron.App): string {
  const locale = electronApp.getPreferredSystemLanguages?.()[0] ?? "en";
  if (!electronApp.isReady()) electronApp.commandLine.appendSwitch("lang", locale);
  return locale;
}

export function applyLoopbackConnectionLimitSwitch(electronApp: Electron.App): void {
  if (!electronApp.isReady()) electronApp.commandLine.appendSwitch("ignore-connections-limit", "127.0.0.1,localhost");
}

function isDirectEntry(): boolean {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function createWebDiscovery(runtime: SidecarRuntimeContext<MapDesignStamp>): () => Promise<string | null> {
  return async () => {
    const socketPath = resolveAppIpcPath({
      app: "web",
      contract: MAP_DESIGN_SIDECAR_CONTRACT,
      namespace: runtime.namespace,
    });
    return (await requestJsonIpc<WebStatusSnapshot>(
      socketPath,
      { type: MAP_DESIGN_SIDECAR_MESSAGES.STATUS },
      { timeoutMs: 600 },
    ).catch(() => null))?.url ?? null;
  };
}

const TOOLS_DEV_PARENT_PID_ENV = "MAP_DESIGN_TOOLS_DEV_PARENT_PID";

function attachParentMonitor(stop: () => Promise<void>): void {
  const parentPid = Number(process.env[TOOLS_DEV_PARENT_PID_ENV]);
  if (!Number.isInteger(parentPid) || parentPid <= 0) return;
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      clearInterval(timer);
      void stop().finally(() => process.exit(0));
    }
  }, 1_000);
  timer.unref();
}

async function registerDesktopAuth(runtime: SidecarRuntimeContext<MapDesignStamp>, secret: Buffer): Promise<void> {
  const socketPath = resolveAppIpcPath({
    app: "daemon",
    contract: MAP_DESIGN_SIDECAR_CONTRACT,
    namespace: runtime.namespace,
  });
  for (const delay of [0, 120, 240, 480, 960, 1_500]) {
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    const response = await requestJsonIpc<{ accepted: true }>(
      socketPath,
      { type: "register-desktop-auth", input: { secret: secret.toString("base64") } },
      { timeoutMs: 1_000 },
    ).catch(() => null);
    if (response?.accepted === true) return;
  }
  throw new Error("MapDesign daemon desktop-auth registration failed.");
}

export async function runDesktopMain(
  runtime: SidecarRuntimeContext<MapDesignStamp>,
  options: DesktopMainOptions,
): Promise<(DesktopRuntime & { shutdown(): Promise<void> }) | null> {
  attachDesktopProcessErrorFilter();
  applyOsLocaleSwitch(app);
  applyLoopbackConnectionLimitSwitch(app);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }
  let desktop: DesktopRuntime | null = null;
  let pendingShow = false;
  app.on("second-instance", () => {
    if (desktop == null) pendingShow = true;
    else desktop.show();
  });
  await app.whenReady();
  // Packaged apps use the icon from their app bundle; this relative PNG exists
  // only in the development desktop package, not beside the bundled entrypoint.
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(fileURLToPath(new URL("../../resources/dock-icon.png", import.meta.url)));
  }

  const sessionStatePath = join(app.getPath("userData"), "map-design-session.json");
  beginDesktopSession({ stateFilePath: sessionStatePath, sessionId: randomUUID(), version: app.getVersion(), now: () => new Date() });
  const secret = randomBytes(32);


  let shutdownPromise: Promise<void> | null = null;
  let ipcServer: Awaited<ReturnType<typeof createJsonIpcServer>> | null = null;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      await options.beforeShutdown?.().catch((error: unknown) => console.error("desktop beforeShutdown failed", error));
      await ipcServer?.close().catch(() => undefined);
      await desktop?.close().catch(() => undefined);
      endDesktopSessionCleanly({ stateFilePath: sessionStatePath });
      app.quit();
    })();
    return shutdownPromise;
  };
  attachParentMonitor(shutdown);
  try {
    await registerDesktopAuth(runtime, secret);

  ipcServer = await createJsonIpcServer({
    socketPath: runtime.ipc,
    handler: async (message: unknown) => {
      const request = normalizeMapDesignSidecarMessage(message);
      switch (request.type) {
        case MAP_DESIGN_SIDECAR_MESSAGES.STATUS:
          return desktop?.status() ?? { pid: process.pid, state: "idle", url: null };
        case MAP_DESIGN_SIDECAR_MESSAGES.SHUTDOWN:
          setImmediate(() => void shutdown());
          return { accepted: true };
        case MAP_DESIGN_SIDECAR_MESSAGES.SHOW:
          if (desktop == null) {
            pendingShow = true;
            return { accepted: true };
          }
          desktop.show();
          return { accepted: true };
        case MAP_DESIGN_SIDECAR_MESSAGES.EVAL:
          if (desktop == null) throw new Error("desktop runtime is not initialized");
          return desktop.eval(request.input);
        case MAP_DESIGN_SIDECAR_MESSAGES.SCREENSHOT:
          if (desktop == null) throw new Error("desktop runtime is not initialized");
          return desktop.screenshot(request.input);
      }
    },
  });

  desktop = await createDesktopRuntime({
    discoverWebUrl: options.discoverWebUrl,
    pickerSecret: secret,
    preloadPath: options.preloadPath,
    splashWindow: options.splashWindow,
    splashStartedAt: options.splashStartedAt,
    windowTitle: options.windowTitle,
    onRevealed: () => markDesktopSessionRunning({ stateFilePath: sessionStatePath }),
  });
  } catch (error) {
    await shutdown();
    throw error;
  }
  if (pendingShow) desktop.show();
  app.on("activate", () => desktop?.show());
  app.on("window-all-closed", () => void shutdown());
  app.on("before-quit", (event) => {
    if (shutdownPromise != null) return;
    event.preventDefault();
    void shutdown();
  });
  return Object.assign(desktop, { shutdown });
}

if (isDirectEntry()) {
  const stamp = readProcessStamp(process.argv.slice(2), MAP_DESIGN_SIDECAR_CONTRACT);
  if (stamp == null) throw new Error("sidecar stamp is required");
  const runtime = bootstrapSidecarRuntime(stamp, process.env, { app: "desktop", contract: MAP_DESIGN_SIDECAR_CONTRACT });
  void runDesktopMain(runtime, {
    discoverWebUrl: createWebDiscovery(runtime),
    discoverDaemonUrl: async () => null,
    preloadPath: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
