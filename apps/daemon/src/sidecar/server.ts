import {
  MAP_DESIGN_SIDECAR_MESSAGES,
  normalizeMapDesignSidecarMessage,
  type DaemonStatusSnapshot,
  type MapDesignStamp,
} from "@mapseekai/sidecar-proto";
import { createJsonIpcServer, type SidecarRuntimeContext } from "@mapseekai/sidecar";

import { setDesktopAuthSecret } from "../desktop-auth.js";
import { startServer } from "../server.js";
function desktopRegistration(message: unknown): Buffer | null {
  if (message == null || typeof message !== "object" || Array.isArray(message)) return null;
  const request = message as { input?: { secret?: unknown }; type?: unknown };
  if (request.type !== "register-desktop-auth" || typeof request.input?.secret !== "string") return null;
  const secret = Buffer.from(request.input.secret, "base64");
  return secret.length === 0 ? null : secret;
}

type ParentMonitorTimer = {
  unref(): void;
};

type ParentMonitorDependencies = {
  clearInterval(timer: ParentMonitorTimer): void;
  exit(code: number): void;
  isAlive(pid: number): boolean;
  setInterval(callback: () => void, delayMs: number): ParentMonitorTimer;
};

function parseToolsDevParentPid(value: string | undefined): number | null {
  if (value == null || !/^[1-9]\d*$/u.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : null;
}

const parentMonitorDependencies: ParentMonitorDependencies = {
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
  exit: (code) => process.exit(code),
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
};

export function attachToolsDevParentMonitor(
  close: () => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ParentMonitorDependencies = parentMonitorDependencies,
): void {
  const parentPid = parseToolsDevParentPid(env.MAP_DESIGN_TOOLS_DEV_PARENT_PID);
  if (parentPid == null) return;

  let stopping = false;
  const timer = dependencies.setInterval(() => {
    if (stopping || dependencies.isAlive(parentPid)) return;
    stopping = true;
    dependencies.clearInterval(timer);
    void close().finally(() => dependencies.exit(0));
  }, 1000);
  timer.unref();
}

export async function startDaemonSidecar(runtime: SidecarRuntimeContext<MapDesignStamp>): Promise<{ close(): Promise<void>; status(): DaemonStatusSnapshot }> {
  const daemon = await startServer({ host: "127.0.0.1", port: Number(process.env.MAP_DESIGN_PORT ?? 0), returnServer: true });
  let closed = false;
  let ipc: { close(): Promise<void> } | null = null;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await ipc?.close();
    await daemon.shutdown();
    await new Promise<void>((resolve) => daemon.server.close(() => resolve()));
  };
  ipc = await createJsonIpcServer({
    socketPath: runtime.ipc,
    handler: async (message: unknown) => {
      const secret = desktopRegistration(message);
      if (secret != null) {
        setDesktopAuthSecret(secret);
        return { accepted: true };
      }
      const request = normalizeMapDesignSidecarMessage(message);
      if (request.type === MAP_DESIGN_SIDECAR_MESSAGES.STATUS) return { pid: process.pid, state: "running", url: daemon.url } satisfies DaemonStatusSnapshot;
      if (request.type === MAP_DESIGN_SIDECAR_MESSAGES.SHUTDOWN) {
        setImmediate(() => void close().finally(() => process.exit(0)));
        return { accepted: true };
      }
      throw new Error(`unsupported MapDesign daemon sidecar message: ${request.type}`);
    },
  });
  attachToolsDevParentMonitor(close);
  return {
    close,
    status: () => ({ pid: process.pid, state: closed ? "stopped" : "running", url: closed ? null : daemon.url }),
  };
}
