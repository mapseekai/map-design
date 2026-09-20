import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ToolPackCache } from "../cache.js";
import type { ToolPackConfig } from "../config.js";
import { ensureWorkspaceBuildArtifacts } from "../workspace-build.js";
import { runPnpm } from "./commands.js";

async function buildWorkspaceArtifacts(config: ToolPackConfig): Promise<void> {
  const webNextEnvPath = join(config.workspaceRoot, "apps", "web", "next-env.d.ts");
  const previousWebNextEnv = await readFile(webNextEnvPath, "utf8").catch(() => null);

  await runPnpm(config, ["--filter", "@mapseekai/contracts", "build"]);
  await runPnpm(config, ["--filter", "@mapseekai/map-design-contracts", "build"]);
  await runPnpm(config, ["--filter", "@mapseekai/sidecar-proto", "build"]);
  await runPnpm(config, ["--filter", "@mapseekai/sidecar", "build"]);
  await runPnpm(config, ["--filter", "@mapseekai/platform", "build"]);
  await runPnpm(config, ["--filter", "@mapseekai/components", "build"]);
  await runPnpm(config, ["--filter", "@cartographymd/init-skill", "build"]);
  await runPnpm(config, ["--filter", "@mapseekai/daemon", "build"]);
  try {
    await runPnpm(config, ["--filter", "@mapseekai/web", "build"], {
      MAP_DESIGN_WEB_OUTPUT_MODE: config.webOutputMode,
    });
    await runPnpm(config, ["--filter", "@mapseekai/web", "build:sidecar"]);
    // Inject chunk IDs + upload browser sourcemaps to PostHog, then strip
    // .map files. Runs before any packaging step copies the web output into
    // the Electron resources so .map never ends up inside the .app bundle.
  } finally {
    if (previousWebNextEnv == null) {
      await rm(webNextEnvPath, { force: true });
    } else {
      await writeFile(webNextEnvPath, previousWebNextEnv, "utf8");
    }
  }
  await runPnpm(config, ["--filter", "@mapseekai/desktop", "build"]);
  await runPnpm(config, ["--filter", "@mapseekai/packaged", "build"]);
}

export async function ensureMacWorkspaceBuild(config: ToolPackConfig, cache: ToolPackCache): Promise<void> {
  await ensureWorkspaceBuildArtifacts(config, cache, async () => {
    await buildWorkspaceArtifacts(config);
  });
}
