import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { hashJson, hashPath, ToolPackCache } from "../cache.js";
import type { ToolPackConfig } from "../config.js";
import { BUNDLED_RESOURCE_TREES, copyBundledResourceTrees, winResources } from "../resources.js";
import type { WinPaths, ResourceTreeCacheMetadata } from "./types.js";

const RESOURCE_TREE_CACHE_SCHEMA_VERSION = 9;

async function createResourceTreeCacheKey(config: ToolPackConfig): Promise<string> {
  const bundledResources = Object.fromEntries(await Promise.all(BUNDLED_RESOURCE_TREES.map(async ({ from, to }) => [to, await hashPath(join(config.workspaceRoot, from))])));
  return hashJson({ bundledResources, node: "win.resource-tree", schemaVersion: RESOURCE_TREE_CACHE_SCHEMA_VERSION, sevenZipDll: await hashPath(winResources.sevenZipDll), sevenZipExe: await hashPath(winResources.sevenZipExe) });
}

export type ResourceTreeResult = { key: string; resourceRoot: string };
export async function prepareResourceTree(config: ToolPackConfig, paths: WinPaths, cache: ToolPackCache, options: { materialize: boolean }): Promise<ResourceTreeResult> {
  const key = await createResourceTreeCacheKey(config);
  const manifest = await cache.acquire({ materialize: options.materialize ? [{ from: "map-design", to: paths.resourceRoot }] : [], node: { id: "win.resource-tree", key, outputs: ["map-design"], invalidate: async () => null, build: async ({ entryRoot }: { entryRoot: string }): Promise<ResourceTreeCacheMetadata> => { const resourceRoot = join(entryRoot, "map-design"); await mkdir(resourceRoot, { recursive: true }); await copyBundledResourceTrees({ workspaceRoot: config.workspaceRoot, resourceRoot }); await mkdir(join(resourceRoot, "bin"), { recursive: true }); await cp(winResources.sevenZipExe, join(resourceRoot, "bin", "7z.exe")); await cp(winResources.sevenZipDll, join(resourceRoot, "bin", "7z.dll")); return { resourceName: "map-design" }; } } });
  return { key, resourceRoot: options.materialize ? paths.resourceRoot : join(manifest.entryPath, "map-design") };
}
export async function copyWinIcon(paths: WinPaths): Promise<void> { await mkdir(dirname(paths.winIconPath), { recursive: true }); await cp(winResources.icon, paths.winIconPath); }
