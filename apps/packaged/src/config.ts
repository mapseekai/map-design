import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { MAP_DESIGN_SIDECAR_DEFAULTS, normalizeNamespace } from "@mapseekai/sidecar-proto";

export const PACKAGED_CONFIG_PATH_ENV = "MAP_DESIGN_PACKAGED_CONFIG_PATH";
export const PACKAGED_NAMESPACE_ENV = "MAP_DESIGN_NAMESPACE";
export const PACKAGED_NAMESPACE_BASE_ROOT_ENV = "MAP_DESIGN_NAMESPACE_BASE_ROOT";

export type PackagedWebOutputMode = "server" | "standalone";

type RawPackagedConfig = {
  appVersion?: string;
  daemonCliEntryRelative?: string;
  daemonSidecarEntryRelative?: string;
  namespace?: string;
  namespaceBaseRoot?: string;
  nodeCommandRelative?: string;
  resourceRoot?: string;
  webOutputMode?: string;
  webSidecarEntryRelative?: string;
  webStandaloneRoot?: string;
};

export type PackagedConfig = {
  appVersion: string | null;
  daemonCliEntry: string | null;
  daemonSidecarEntry: string | null;
  namespace: string;
  namespaceBaseRoot: string;
  nodeCommand: string | null;
  resourceRoot: string;
  webOutputMode: PackagedWebOutputMode;
  webSidecarEntry: string | null;
  webStandaloneRoot: string | null;
};

async function exists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false);
}

async function electronAppPath(): Promise<{ getAppPath(): string; getPath(name: string): string }> {
  return (await import("electron")).app;
}

function optional(value: string | undefined): string | null {
  const result = value?.trim();
  return result == null || result.length === 0 ? null : result;
}

async function readRawConfig(): Promise<RawPackagedConfig> {
  const explicit = optional(process.env[PACKAGED_CONFIG_PATH_ENV]);
  const app = await electronAppPath();
  const candidates = [
    explicit == null ? null : resolve(explicit),
    join(process.resourcesPath, "map-design-config.json"),
    join(app.getAppPath(), "map-design-config.json"),
  ];
  for (const path of candidates) {
    if (path != null && await exists(path)) return JSON.parse(await readFile(path, "utf8")) as RawPackagedConfig;
  }
  if (explicit != null) throw new Error(`packaged config not found at ${explicit}`);
  return {};
}

async function resourceEntry(value: string | undefined): Promise<string | null> {
  const relative = optional(value);
  if (relative == null) return null;
  const entry = join(process.resourcesPath, relative);
  if (!(await exists(entry))) throw new Error(`configured packaged entry not found at ${entry}`);
  return entry;
}

export async function readPackagedConfig(): Promise<PackagedConfig> {
  const raw = await readRawConfig();
  const app = await electronAppPath();
  const webOutputMode = raw.webOutputMode == null || raw.webOutputMode === "" ? "server" : raw.webOutputMode;
  if (webOutputMode !== "server" && webOutputMode !== "standalone") throw new Error(`unsupported packaged web output mode: ${webOutputMode}`);
  const resourceRoot = optional(raw.resourceRoot) ?? join(process.resourcesPath, "map-design");
  const nodeCandidate = join(process.resourcesPath, optional(raw.nodeCommandRelative) ?? join("map-design", "bin", "node"));
  const webStandaloneRoot = webOutputMode === "standalone"
    ? optional(raw.webStandaloneRoot) ?? join(process.resourcesPath, "map-design-web-standalone")
    : null;
  if (webStandaloneRoot != null && !(await exists(webStandaloneRoot))) {
    throw new Error(`configured packaged standalone root not found at ${webStandaloneRoot}`);
  }

  return {
    appVersion: optional(raw.appVersion),
    daemonCliEntry: await resourceEntry(raw.daemonCliEntryRelative),
    daemonSidecarEntry: await resourceEntry(raw.daemonSidecarEntryRelative),
    namespace: normalizeNamespace(process.env[PACKAGED_NAMESPACE_ENV] ?? raw.namespace ?? MAP_DESIGN_SIDECAR_DEFAULTS.namespace),
    namespaceBaseRoot: resolve(process.env[PACKAGED_NAMESPACE_BASE_ROOT_ENV] ?? raw.namespaceBaseRoot ?? join(app.getPath("userData"), "namespaces")),
    nodeCommand: await exists(nodeCandidate) ? nodeCandidate : null,
    resourceRoot,
    webStandaloneRoot,
    webOutputMode,
    webSidecarEntry: await resourceEntry(raw.webSidecarEntryRelative),
  };
}
