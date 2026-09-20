import {
  MAP_DESIGN_SIDECAR_CONTRACT,
  MAP_DESIGN_SIDECAR_MESSAGES,
  type DaemonStatusSnapshot,
  type DesktopStatusSnapshot,
  type WebStatusSnapshot,
} from "@mapseekai/sidecar-proto";
import { requestJsonIpc, resolveAppIpcPath } from "@mapseekai/sidecar";


export type AppRuntimeLookup = {
  base: string;
  namespace: string;
};

export const DAEMON_STARTUP_TIMEOUT_MS = 120_000;
const WEB_STARTUP_TIMEOUT_MS = 35_000;
const DESKTOP_STARTUP_TIMEOUT_MS = 15_000;

type ProcessAliveProbe = () => boolean;

function assertSpawnedProcessAlive(appName: string, isProcessAlive: ProcessAliveProbe | undefined): void {
  if (isProcessAlive?.() === false) {
    throw new Error(`${appName} exited before exposing status`);
  }
}

export function resolveDaemonIpcPath(runtime: AppRuntimeLookup): string {
  return resolveAppIpcPath({ app: "daemon", contract: MAP_DESIGN_SIDECAR_CONTRACT, namespace: runtime.namespace });
}

export function resolveWebIpcPath(runtime: AppRuntimeLookup): string {
  return resolveAppIpcPath({ app: "web", contract: MAP_DESIGN_SIDECAR_CONTRACT, namespace: runtime.namespace });
}

export function resolveDesktopIpcPath(runtime: AppRuntimeLookup): string {
  return resolveAppIpcPath({ app: "desktop", contract: MAP_DESIGN_SIDECAR_CONTRACT, namespace: runtime.namespace });
}

export async function inspectDaemonRuntime(runtime: AppRuntimeLookup, timeoutMs = 800): Promise<DaemonStatusSnapshot | null> {
  try {
    return await requestJsonIpc<DaemonStatusSnapshot>(resolveDaemonIpcPath(runtime), { type: MAP_DESIGN_SIDECAR_MESSAGES.STATUS }, { timeoutMs });
  } catch {
    return null;
  }
}

export async function waitForDaemonRuntime(
  runtime: AppRuntimeLookup,
  timeoutMs = DAEMON_STARTUP_TIMEOUT_MS,
  isProcessAlive?: ProcessAliveProbe,
): Promise<DaemonStatusSnapshot> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    assertSpawnedProcessAlive("daemon", isProcessAlive);
    const snapshot = await inspectDaemonRuntime(runtime, 800);
    if (snapshot?.url != null) return snapshot;
    assertSpawnedProcessAlive("daemon", isProcessAlive);
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  assertSpawnedProcessAlive("daemon", isProcessAlive);
  throw new Error("daemon did not expose status in time");
}

export async function inspectWebRuntime(runtime: AppRuntimeLookup, timeoutMs = 800): Promise<WebStatusSnapshot | null> {
  try {
    return await requestJsonIpc<WebStatusSnapshot>(resolveWebIpcPath(runtime), { type: MAP_DESIGN_SIDECAR_MESSAGES.STATUS }, { timeoutMs });
  } catch {
    return null;
  }
}

export async function waitForWebRuntime(
  runtime: AppRuntimeLookup,
  timeoutMs = WEB_STARTUP_TIMEOUT_MS,
  isProcessAlive?: ProcessAliveProbe,
): Promise<WebStatusSnapshot> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    assertSpawnedProcessAlive("web", isProcessAlive);
    const snapshot = await inspectWebRuntime(runtime, 800);
    if (snapshot?.url != null) return snapshot;
    assertSpawnedProcessAlive("web", isProcessAlive);
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  assertSpawnedProcessAlive("web", isProcessAlive);
  throw new Error("web did not expose status in time");
}

export async function inspectDesktopRuntime(runtime: AppRuntimeLookup, timeoutMs = 800): Promise<DesktopStatusSnapshot | null> {
  try {
    return await requestJsonIpc<DesktopStatusSnapshot>(resolveDesktopIpcPath(runtime), { type: MAP_DESIGN_SIDECAR_MESSAGES.STATUS }, { timeoutMs });
  } catch {
    return null;
  }
}

export async function waitForDesktopRuntime(
  runtime: AppRuntimeLookup,
  timeoutMs = DESKTOP_STARTUP_TIMEOUT_MS,
  isProcessAlive?: ProcessAliveProbe,
): Promise<DesktopStatusSnapshot> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    assertSpawnedProcessAlive("desktop", isProcessAlive);
    const snapshot = await inspectDesktopRuntime(runtime, 800);
    if (snapshot != null) return snapshot;
    assertSpawnedProcessAlive("desktop", isProcessAlive);
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  assertSpawnedProcessAlive("desktop", isProcessAlive);
  throw new Error("desktop did not expose status in time");
}
