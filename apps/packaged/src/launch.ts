import { access, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import { app } from "electron";

import { PackagedPathAccessError } from "./errors.js";
import type { PackagedNamespacePaths } from "./paths.js";

export async function ensurePackagedNamespacePaths(paths: PackagedNamespacePaths): Promise<void> {
  try {
    await mkdir(paths.dataRoot, { recursive: true });
    await access(paths.dataRoot, fsConstants.W_OK);
    await Promise.all([
      mkdir(paths.cacheRoot, { recursive: true }),
      mkdir(paths.desktopLogsRoot, { recursive: true }),
      mkdir(paths.electronSessionDataRoot, { recursive: true }),
      mkdir(paths.electronUserDataRoot, { recursive: true }),
      mkdir(paths.logsRoot, { recursive: true }),
      mkdir(paths.runtimeRoot, { recursive: true }),
    ]);
  } catch (error) {
    throw new PackagedPathAccessError(`MapDesign could not create or write to: ${paths.dataRoot}`, { cause: error });
  }
}

export function applyPackagedElectronPathOverrides(paths: PackagedNamespacePaths): void {
  app.setPath("userData", paths.electronUserDataRoot);
  app.setPath("sessionData", paths.electronSessionDataRoot);
  app.setPath("logs", paths.desktopLogsRoot);
}
