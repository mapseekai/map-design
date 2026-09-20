import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { INTERNAL_PACKAGES as LINUX_INTERNAL_PACKAGES } from "../src/linux.js";
import { INTERNAL_PACKAGES as MAC_INTERNAL_PACKAGES } from "../src/mac/constants.js";
import { shouldInstallInternalPackageForMacPrebundle } from "../src/mac-prebundle.js";
import { INTERNAL_PACKAGES as WIN_INTERNAL_PACKAGES } from "../src/win/constants.js";
import { shouldInstallInternalPackageForWinPrebundle } from "../src/win-prebundle.js";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REMOVED_PLUGIN_PACKAGES = ["@mapseekai/plugin-runtime", "@mapseekai/registry-protocol"] as const;
const RETIRED_PACKAGES = [
  "@mapseekai/download",
  "@mapseekai/host",
  "@mapseekai/release",
] as const;

type PackageEntry = { readonly directory: string; readonly name: string };

function runtimeWorkspaceDeps(directory: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(workspaceRoot, directory, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  return Object.entries(manifest.dependencies ?? {}).filter(([, spec]) => spec.startsWith("workspace:")).map(([name]) => name);
}

// Each pack lane assembles its packaged app by `pnpm pack`-ing a subset of
// INTERNAL_PACKAGES into tarballs, wiring them as `file:` dependencies, and
// running an npm/pnpm install in the isolated app directory. `pnpm pack`
// rewrites every `workspace:*` ref to a concrete version, so the install
// resolves each tarball's runtime `workspace:*` dependencies. Any such
// dependency that is NOT also installed as a local tarball is fetched from the
// public npm registry and 404s — these packages are workspace-only and never
// published.
//
// The invariant: the set a lane actually installs must be closed under its
// runtime `workspace:*` dependencies.
//
// Every lane now ships the same retained package closure. Retired release,
// launcher-proto, download, and host packages are neither built nor packaged.
const LANES: { name: string; packages: readonly PackageEntry[]; isInstalled: (pkg: PackageEntry) => boolean }[] = [
  {
    name: "linux",
    packages: LINUX_INTERNAL_PACKAGES,
    isInstalled: () => true,
  },
  {
    name: "mac",
    packages: MAC_INTERNAL_PACKAGES,
    isInstalled: (pkg) =>
      shouldInstallInternalPackageForMacPrebundle({ packageName: pkg.name, webOutputMode: "standalone" }),
  },
  {
    name: "win",
    packages: WIN_INTERNAL_PACKAGES,
    isInstalled: (pkg) =>
      shouldInstallInternalPackageForWinPrebundle({ packageName: pkg.name, webOutputMode: "standalone" }),
  },
];

describe("pack lane INTERNAL_PACKAGES dependency closure", () => {
  it("excludes deleted plugin implementation packages from every pack lane", () => {
    for (const lane of LANES) {
      const packageNames = lane.packages.map((pkg) => pkg.name);
      for (const packageName of REMOVED_PLUGIN_PACKAGES) {
        expect(packageNames).not.toContain(packageName);
      }
    }
  });

  it("includes retained MapDesign contracts in every packaged tarball closure", () => {
    for (const lane of LANES) {
      const contracts = lane.packages.find((pkg) => pkg.name === "@mapseekai/map-design-contracts");
      expect(contracts).toEqual({
        directory: "packages/map-design-contracts",
        name: "@mapseekai/map-design-contracts",
      });
      expect(lane.isInstalled(contracts!)).toBe(true);
    }
  });

  it("excludes retired packages from every pack lane and build callback", () => {
    const workspaceBuildSources = [
      "tools/pack/src/workspace-build.ts",
      "tools/pack/src/linux.ts",
      "tools/pack/src/mac/workspace.ts",
      "tools/pack/src/win/app.ts",
    ].map((path) => readFileSync(join(workspaceRoot, path), "utf8"));

    for (const packageName of RETIRED_PACKAGES) {
      for (const lane of LANES) {
        expect(lane.packages.map((pkg) => pkg.name)).not.toContain(packageName);
      }
      for (const source of workspaceBuildSources) {
        expect(source).not.toContain(`"${packageName}"`);
      }
    }
  });

  it("does not invoke deleted plugin package build filters", () => {
    const workspaceBuildSources = [
      "tools/pack/src/workspace-build.ts",
      "tools/pack/src/linux.ts",
      "tools/pack/src/mac/workspace.ts",
      "tools/pack/src/win/app.ts",
    ].map((path) => readFileSync(join(workspaceRoot, path), "utf8"));

    for (const source of workspaceBuildSources) {
      for (const packageName of REMOVED_PLUGIN_PACKAGES) {
        expect(source).not.toContain(`--filter\", \"${packageName}`);
      }
    }
  });

  it("retires Helm deployment metadata with the Docker distribution surface", () => {
    expect(existsSync(join(workspaceRoot, "tools/pack/helm"))).toBe(false);
  });

  for (const lane of LANES) {
    it(`${lane.name}: every installed package's runtime workspace deps are installed`, () => {
      const installed = lane.packages.filter((pkg) => lane.isInstalled(pkg));
      const installedNames = new Set(installed.map((pkg) => pkg.name));
      const missing: { dependency: string; dependent: string }[] = [];

      for (const pkg of installed) {
        for (const dependency of runtimeWorkspaceDeps(pkg.directory)) {
          if (!installedNames.has(dependency)) {
            missing.push({ dependency, dependent: pkg.name });
          }
        }
      }

      expect(missing).toEqual([]);
    });
  }
});
