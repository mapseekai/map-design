import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { INTERNAL_PACKAGES as LINUX_INTERNAL_PACKAGES } from "../src/linux.js";
import { INTERNAL_PACKAGES as MAC_INTERNAL_PACKAGES } from "../src/mac/constants.js";
import { INTERNAL_PACKAGES as WIN_INTERNAL_PACKAGES } from "../src/win/constants.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

type PackageJson = {
  dependencies?: Record<string, string>;
};

function collectWorkspaceRuntimeDeps(relativePath: string): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, relativePath, "package.json"), "utf8")) as PackageJson;
  return Object.entries(pkg.dependencies ?? {}).filter(([, spec]) => spec.startsWith("workspace:")).map(([name]) => name);
}

const PACKAGED_APPS = ["apps/desktop", "apps/web", "apps/packaged", "apps/daemon"];
const PACK_LANES = [
  { lane: "linux", packages: LINUX_INTERNAL_PACKAGES },
  { lane: "mac", packages: MAC_INTERNAL_PACKAGES },
  { lane: "win", packages: WIN_INTERNAL_PACKAGES },
];

describe("INTERNAL_PACKAGES covers all workspace runtime deps", () => {
  const requiredPackages = new Set<string>();
  for (const app of PACKAGED_APPS) {
    for (const dep of collectWorkspaceRuntimeDeps(app)) {
      requiredPackages.add(dep);
    }
  }

  for (const { lane, packages } of PACK_LANES) {
    it(`${lane} lane includes all required workspace packages`, () => {
      const declared = new Set<string>(packages.map((pkg) => pkg.name));
      const missing = [...requiredPackages].filter((pkg) => !declared.has(pkg));
      expect(missing, `${lane} INTERNAL_PACKAGES is missing: ${missing.join(", ")}`).toEqual([]);
    });
  }
});
