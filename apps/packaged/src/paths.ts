import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

import { normalizeNamespace } from "@mapseekai/sidecar-proto";

import type { PackagedConfig } from "./config.js";
import { PackagedPathAccessError } from "./errors.js";

export type PackagedNamespacePaths = {
  cacheRoot: string;
  dataRoot: string;
  desktopLogsRoot: string;
  electronSessionDataRoot: string;
  electronUserDataRoot: string;
  logsRoot: string;
  namespaceRoot: string;
  resourceRoot: string;
  runtimeRoot: string;
};

function resolveDataRoot(baseRoot: string, namespace: string, env: NodeJS.ProcessEnv): string {
  const configured = env.MAP_DESIGN_DATA_DIR?.trim();
  if (configured == null || configured.length === 0) return join(baseRoot, namespace, "data");
  const expanded = configured === "~" ? homedir() : configured.replace(/^~[/\\]/, `${homedir()}/`);
  const absolute = process.platform === "win32" ? win32.isAbsolute(expanded) : posix.isAbsolute(expanded);
  if (!absolute) {
    throw new PackagedPathAccessError("MapDesign requires MAP_DESIGN_DATA_DIR to be an absolute path.", { title: "MapDesign cannot start" });
  }
  return expanded;
}

export function resolvePackagedNamespacePaths(
  config: Pick<PackagedConfig, "namespaceBaseRoot" | "resourceRoot">,
  namespace: string,
  env: NodeJS.ProcessEnv = process.env,
): PackagedNamespacePaths {
  const normalizedNamespace = normalizeNamespace(namespace);
  const namespaceRoot = join(config.namespaceBaseRoot, normalizedNamespace);
  return {
    cacheRoot: join(namespaceRoot, "cache"),
    dataRoot: resolveDataRoot(config.namespaceBaseRoot, normalizedNamespace, env),
    desktopLogsRoot: join(namespaceRoot, "logs", "desktop"),
    electronSessionDataRoot: join(namespaceRoot, "user-data", "session"),
    electronUserDataRoot: join(namespaceRoot, "user-data"),
    logsRoot: join(namespaceRoot, "logs"),
    namespaceRoot,
    resourceRoot: config.resourceRoot,
    runtimeRoot: join(namespaceRoot, "runtime"),
  };
}
