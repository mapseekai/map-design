import { describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBundledResourceTrees, linuxResources } from "../src/resources.js";

describe("pack resources", () => {
  it("uses the MapDesign desktop file template", () => {
    expect(linuxResources.desktopTemplate).toMatch(/map-design\.desktop\.template$/);
  });

  it("excludes skill workspace dependencies while retaining bundled content", async () => {
    const root = await mkdtemp(join(tmpdir(), "pack-resource-test-"));
    try {
      const workspaceRoot = join(root, "workspace");
      const resourceRoot = join(root, "output");
      const skillRoot = join(workspaceRoot, "skills", "fixture");
      await mkdir(join(skillRoot, "node_modules"), { recursive: true });
      await mkdir(join(skillRoot, "scripts"), { recursive: true });
      await mkdir(join(workspaceRoot, "design-systems"), { recursive: true });
      await writeFile(join(workspaceRoot, "DESIGN.md"), "design");
      await writeFile(join(skillRoot, "SKILL.md"), "skill");
      await writeFile(join(skillRoot, "scripts", "run.js"), "run");
      if (process.platform !== "win32") {
        await symlink(workspaceRoot, join(skillRoot, "node_modules", "external"));
      } else {
        await writeFile(join(skillRoot, "node_modules", "dependency.js"), "dependency");
      }
      await copyBundledResourceTrees({ workspaceRoot, resourceRoot });
      await expect(lstat(join(resourceRoot, "skills", "fixture", "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(resourceRoot, "skills", "fixture", "SKILL.md"), "utf8")).toBe("skill");
      expect(await readFile(join(resourceRoot, "skills", "fixture", "scripts", "run.js"), "utf8")).toBe("run");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
