import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ToolPackCache } from "../src/cache.js";
import type { ToolPackConfig } from "../src/config.js";
import { prepareResourceTree } from "../src/win/resources.js";
import type { WinPaths } from "../src/win/types.js";

const RESOURCE_TREE_CACHE_TEST_TIMEOUT_MS = 15_000;


async function createWorkspaceFixture(workspaceRoot: string): Promise<void> {
  await mkdir(join(workspaceRoot, "skills", "sample"), { recursive: true });
  await writeFile(join(workspaceRoot, "DESIGN.md"), "# Interface design\n", "utf8");
  await mkdir(join(workspaceRoot, "design-templates", "orbit-general"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, "design-systems", "sample"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, "craft", "sample"), { recursive: true });
  await mkdir(join(workspaceRoot, "assets", "frames"), { recursive: true });
  await mkdir(join(workspaceRoot, "assets", "community-pets", "sample"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, "prompt-templates", "image"), {
    recursive: true,
  });
}

describe("prepareResourceTree", () => {
  it("does not invalidate the Windows resource tree cache when retired design templates change", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-win-resources-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "map-design");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;
    const templatePath = join(
      workspaceRoot,
      "design-templates",
      "orbit-general",
      "SKILL.md",
    );
    const materializedTemplatePath = join(
      resourceRoot,
      "design-templates",
      "orbit-general",
      "SKILL.md",
    );

    try {
      await createWorkspaceFixture(workspaceRoot);
      await writeFile(templatePath, "version one\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(materializedTemplatePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      await writeFile(templatePath, "version two\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      expect(cache.report().entries.map((entry) => entry.status)).toEqual([
        "miss",
        "hit",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, RESOURCE_TREE_CACHE_TEST_TIMEOUT_MS);

  it("does not invalidate the Windows resource tree cache when retired prompt templates change", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-win-native-resources-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "map-design");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;
    const promptTemplatePath = join(workspaceRoot, "prompt-templates", "image", "sample.json");
    const materializedPromptTemplatePath = join(resourceRoot, "prompt-templates", "image", "sample.json");

    try {
      await createWorkspaceFixture(workspaceRoot);
      await writeFile(promptTemplatePath, "{\"id\":\"one\"}\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(materializedPromptTemplatePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      await prepareResourceTree(config, paths, cache, { materialize: true });

      expect(cache.report().entries.map((entry) => entry.status)).toEqual([
        "miss",
        "hit",
      ]);
      await writeFile(promptTemplatePath, "{\"id\":\"two\"}\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      expect(cache.report().entries.map((entry) => entry.status)).toEqual([
        "miss",
        "hit",
        "hit",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, RESOURCE_TREE_CACHE_TEST_TIMEOUT_MS);

});
