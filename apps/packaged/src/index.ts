import { join } from "node:path";

import { MAP_DESIGN_SIDECAR_CONTRACT, type MapDesignStamp } from "@mapseekai/sidecar-proto";
import { bootstrapSidecarRuntime, createSidecarLaunchEnv, resolveAppIpcPath } from "@mapseekai/sidecar";
import { app } from "electron";

import { readPackagedConfig } from "./config.js";
import { applyPackagedElectronPathOverrides, ensurePackagedNamespacePaths } from "./launch.js";
import { resolvePackagedNamespacePaths } from "./paths.js";
import { packagedEntryUrl, registerMapDesignProtocol } from "./protocol.js";
import { startPackagedSidecars } from "./sidecars.js";
import { MAP_DESIGN_WINDOW_TITLE } from "./window-title.js";


export interface StartMapDesignPackagedRuntimeOptions {
  namespace: string;
  resourcesPath: string;
  appVersion: string;
}

export async function startMapDesignPackagedRuntime(
  options: StartMapDesignPackagedRuntimeOptions,
): Promise<{ stop(): Promise<void> }> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return { stop: async () => undefined };
  }
  const config = await readPackagedConfig();
  const paths = resolvePackagedNamespacePaths({ ...config, resourceRoot: options.resourcesPath }, options.namespace, process.env);
  await ensurePackagedNamespacePaths(paths);
  applyPackagedElectronPathOverrides(paths);

  const stamp: MapDesignStamp = {
    app: "desktop",
    ipc: resolveAppIpcPath({ app: "desktop", contract: MAP_DESIGN_SIDECAR_CONTRACT, namespace: options.namespace }),
    mode: "runtime",
    namespace: options.namespace,
    source: "packaged",
  };
  const runtime = bootstrapSidecarRuntime(stamp, createSidecarLaunchEnv({ base: paths.runtimeRoot, contract: MAP_DESIGN_SIDECAR_CONTRACT, stamp }), {
    app: "desktop",
    base: paths.runtimeRoot,
    contract: MAP_DESIGN_SIDECAR_CONTRACT,
  });
  const sidecars = await startPackagedSidecars(runtime, paths, {
    appVersion: options.appVersion,
    daemonCliEntry: config.daemonCliEntry,
    daemonSidecarEntry: config.daemonSidecarEntry,
    nodeCommand: config.nodeCommand,
    requireDesktopAuth: true,
    webOutputMode: config.webOutputMode,
    webSidecarEntry: config.webSidecarEntry,
    webStandaloneRoot: config.webStandaloneRoot,
  });
  let sidecarClosePromise: Promise<void> | null = null;
  const closeSidecars = (): Promise<void> => {
    sidecarClosePromise ??= sidecars.close();
    return sidecarClosePromise;
  };
  try {
    registerMapDesignProtocol(() => sidecars.currentWebUrl());
    const { runDesktopMain } = await import("@mapseekai/desktop/main");
    const desktop = await runDesktopMain(runtime, {
      beforeShutdown: closeSidecars,
      async discoverDaemonUrl() { return sidecars.daemon.url; },
      async discoverWebUrl() { return packagedEntryUrl(); },
      preloadPath: join(app.getAppPath(), "preload.cjs"),
      windowTitle: MAP_DESIGN_WINDOW_TITLE,
    });
    let stopPromise: Promise<void> | null = null;
    const stop = (): Promise<void> => {
      stopPromise ??= (async () => {
        await (desktop as { shutdown?: () => Promise<void> } | null)?.shutdown?.();
        await closeSidecars();
      })();
      return stopPromise;
    };
    return { stop };
  } catch (error) {
    await closeSidecars();
    throw error;
  }
}

if (process.env.VITEST == null) {
  void startMapDesignPackagedRuntime({
    appVersion: app.getVersion(),
    namespace: process.env.MAP_DESIGN_NAMESPACE ?? "default",
    resourcesPath: join(process.resourcesPath, "map-design"),
  }).catch((error: unknown) => {
    console.error("MapDesign packaged runtime failed", error);
    app.exit(1);
  });
}
