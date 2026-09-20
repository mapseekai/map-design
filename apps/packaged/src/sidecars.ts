import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import {
  MAP_DESIGN_SIDECAR_CONTRACT,
  MAP_DESIGN_SIDECAR_MESSAGES,
  type DaemonStatusSnapshot,
  type MapDesignApp,
  type MapDesignStamp,
  type WebStatusSnapshot,
} from "@mapseekai/sidecar-proto";
import { createSidecarLaunchEnv, requestJsonIpc, resolveAppIpcPath, type SidecarRuntimeContext } from "@mapseekai/sidecar";
import { createProcessStampArgs, stopProcesses, waitForProcessExit } from "@mapseekai/platform";

import type { PackagedWebOutputMode } from "./config.js";
import type { PackagedNamespacePaths } from "./paths.js";

const require = createRequire(import.meta.url);

type ManagedChild = { app: MapDesignApp; child: ChildProcess; ipcPath: string };

export type PackagedSidecarHandle = {
  close(): Promise<void>;
  currentWebUrl(): string;
  daemon: DaemonStatusSnapshot;
  web: WebStatusSnapshot;
};

function entry(packageName: string, name: string): string {
  return require.resolve(`${packageName}/${name}`);
}

async function waitForStatus<T extends { url: string | null }>(ipcPath: string, child: ChildProcess): Promise<T> {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) throw new Error(`MapDesign sidecar exited before becoming ready: ${ipcPath}`);
    const status = await requestJsonIpc<T>(ipcPath, { type: MAP_DESIGN_SIDECAR_MESSAGES.STATUS }, { timeoutMs: 600 }).catch(() => null);
    if (status?.url != null) return status;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`MapDesign sidecar did not become ready: ${ipcPath}`);
}

async function spawnSidecar(input: {
  app: MapDesignApp;
  entryPath: string;
  env: NodeJS.ProcessEnv;
  nodeCommand: string | null;
  paths: PackagedNamespacePaths;
  runtime: SidecarRuntimeContext<MapDesignStamp>;
}): Promise<ManagedChild> {
  const ipcPath = resolveAppIpcPath({ app: input.app, contract: MAP_DESIGN_SIDECAR_CONTRACT, namespace: input.runtime.namespace });
  const stamp: MapDesignStamp = { app: input.app, ipc: ipcPath, mode: "runtime", namespace: input.runtime.namespace, source: "packaged" };
  const command = input.nodeCommand ?? process.execPath;
  const env = createSidecarLaunchEnv({
    base: input.paths.runtimeRoot,
    contract: MAP_DESIGN_SIDECAR_CONTRACT,
    extraEnv: { ...input.env, NODE_ENV: "production", ...(input.nodeCommand == null ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    stamp,
  });
  const child = spawn(command, [input.entryPath, ...createProcessStampArgs(stamp, MAP_DESIGN_SIDECAR_CONTRACT)], {
    cwd: input.paths.runtimeRoot,
    env,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  return { app: input.app, child, ipcPath };
}

async function close(child: ManagedChild): Promise<void> {
  await requestJsonIpc(child.ipcPath, { type: MAP_DESIGN_SIDECAR_MESSAGES.SHUTDOWN }, { timeoutMs: 1_200 }).catch(() => undefined);
  if (!(await waitForProcessExit(child.child.pid, 5_000))) await stopProcesses([child.child.pid]);
}

export async function startPackagedSidecars(
  runtime: SidecarRuntimeContext<MapDesignStamp>,
  paths: PackagedNamespacePaths,
  options: {
    appVersion: string | null;
    daemonCliEntry: string | null;
    daemonSidecarEntry: string | null;
    nodeCommand: string | null;
    requireDesktopAuth: boolean;
    webSidecarEntry: string | null;
    webStandaloneRoot: string | null;
    webOutputMode: PackagedWebOutputMode;
  },
): Promise<PackagedSidecarHandle> {
  await Promise.all([mkdir(paths.dataRoot, { recursive: true }), mkdir(paths.logsRoot, { recursive: true }), mkdir(paths.runtimeRoot, { recursive: true })]);
  const daemon = await spawnSidecar({
    app: "daemon",
    entryPath: options.daemonSidecarEntry ?? entry("@mapseekai/daemon", "sidecar"),
    env: {
      MAP_DESIGN_DATA_DIR: paths.dataRoot,
      MAP_DESIGN_RESOURCE_ROOT: paths.resourceRoot,
      ...(options.appVersion == null ? {} : { MAP_DESIGN_APP_VERSION: options.appVersion }),
      ...(options.daemonCliEntry == null ? {} : { MAP_DESIGN_DAEMON_CLI_PATH: options.daemonCliEntry }),
      ...(options.requireDesktopAuth ? { MAP_DESIGN_REQUIRE_DESKTOP_AUTH: "1" } : {}),
    },
    nodeCommand: options.nodeCommand,
    paths,
    runtime,
  });
  try {
    const daemonStatus = await waitForStatus<DaemonStatusSnapshot>(daemon.ipcPath, daemon.child);
    const web = await spawnSidecar({
      app: "web",
      entryPath: options.webSidecarEntry ?? entry("@mapseekai/web", "sidecar"),
      env: {
        MAP_DESIGN_DAEMON_URL: daemonStatus.url ?? "",
        MAP_DESIGN_WEB_OUTPUT_MODE: options.webOutputMode,
        ...(options.webStandaloneRoot == null ? {} : { MAP_DESIGN_WEB_STANDALONE_ROOT: options.webStandaloneRoot }),
        PORT: "0",
      },
      nodeCommand: options.nodeCommand,
      paths,
      runtime,
    });
    try {
      const webStatus = await waitForStatus<WebStatusSnapshot>(web.ipcPath, web.child);
      return {
        daemon: daemonStatus,
        web: webStatus,
        currentWebUrl: () => webStatus.url ?? "",
        close: async () => {
          await Promise.all([close(web), close(daemon)]);
        },
      };
    } catch (error) {
      await close(web);
      throw error;
    }
  } catch (error) {
    await close(daemon);
    throw error;
  }
}
