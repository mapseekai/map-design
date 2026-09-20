import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { NtExecutable, NtExecutableResource, Resource } from "resedit";
import { describe, expect, it } from "vitest";

import { materializeCachedUnpackedForInstaller } from "../src/win/builder.js";
import type { WinPaths } from "../src/win/types.js";
import { readWinExecutableVersionSnapshot } from "../src/win/version-resource.js";

const execFileAsync = promisify(execFile);

function createPaths(root: string): WinPaths {
  const namespaceRoot = join(root, "namespaces", "second");
  return {
    appBuilderConfigPath: join(namespaceRoot, "builder-config.json"),
    appBuilderOutputRoot: join(namespaceRoot, "builder"),
    assembledAppRoot: join(namespaceRoot, "assembled", "app"),
    assembledMainEntryPath: join(namespaceRoot, "assembled", "app", "main.cjs"),
    assembledPackageJsonPath: join(namespaceRoot, "assembled", "app", "package.json"),
    assembledPrebundledRoot: join(namespaceRoot, "assembled", "app", "prebundled"),
    blockmapPath: join(namespaceRoot, "builder", "MapDesign-second-setup.exe.blockmap"),
    builtManifestPath: join(namespaceRoot, "built-app.json"),
    daemonCliPrebundleEntrypointPath: join(namespaceRoot, "prebundle-entrypoints", "daemon-cli.js"),
    daemonCliPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "daemon", "daemon-cli.mjs"),
    daemonPrebundleMetaPath: join(namespaceRoot, "prebundle-meta", "daemon.meta.json"),
    daemonPrebundleRoot: join(namespaceRoot, "assembled", "app", "prebundled", "daemon"),
    daemonSidecarPrebundleEntrypointPath: join(namespaceRoot, "prebundle-entrypoints", "daemon-sidecar.js"),
    daemonSidecarPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "daemon", "daemon-sidecar.mjs"),
    mapDesignMcpCliPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "daemon", "map-design-mcp-cli.mjs"),
    exePath: join(namespaceRoot, "builder", "MapDesign-second.exe"),
    installDir: join(namespaceRoot, "runtime", "install", "MapDesign"),
    installedExePath: join(namespaceRoot, "runtime", "install", "MapDesign", "map-design.exe"),
    installerBasePayloadPath: join(namespaceRoot, "installer", "payload-base.7z"),
    installerOverlayPayloadPath: join(namespaceRoot, "installer", "payload-overlay.7z"),
    installerScriptPath: join(namespaceRoot, "installer", "installer.nsi"),
    launcherPayloadPath: join(namespaceRoot, "payload", "MapDesign-second-payload.7z"),
    publicDesktopShortcutPath: join(namespaceRoot, "desktop", "public.lnk"),
    latestYmlPath: join(namespaceRoot, "builder", "latest.yml"),
    installMarkerPath: join(namespaceRoot, "logs", "install.marker.json"),
    installTimingPath: join(namespaceRoot, "logs", "install.timing.json"),
    nsisLogPath: join(namespaceRoot, "logs", "nsis.log"),
    nsisIncludePath: join(namespaceRoot, "nsis", "installer.nsh"),
    packagedConfigPath: join(namespaceRoot, "map-design-config.json"),
    packagedMainPrebundleMetaPath: join(namespaceRoot, "prebundle-meta", "packaged-main.meta.json"),
    packagedMainPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "packaged-main.mjs"),
    resourceRoot: join(namespaceRoot, "resources", "map-design"),
    setupPath: join(namespaceRoot, "builder", "MapDesign-second-setup.exe"),
    setupZipPath: join(namespaceRoot, "builder", "MapDesign-second-portable.zip"),
    startMenuShortcutPath: join(namespaceRoot, "start-menu.lnk"),
    tarballsRoot: join(namespaceRoot, "tarballs"),
    userDesktopShortcutPath: join(namespaceRoot, "desktop", "user.lnk"),
    uninstallMarkerPath: join(namespaceRoot, "logs", "uninstall.marker.json"),
    uninstallTimingPath: join(namespaceRoot, "logs", "uninstall.timing.json"),
    uninstallerPath: join(namespaceRoot, "runtime", "install", "MapDesign", "Uninstall.exe"),
    webStandaloneHookAuditPath: join(namespaceRoot, "web-standalone-after-pack-audit.json"),
    webStandaloneHookConfigPath: join(namespaceRoot, "web-standalone-after-pack-config.json"),
    webSidecarPrebundleMetaPath: join(namespaceRoot, "prebundle-meta", "web-sidecar.meta.json"),
    webSidecarPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "web-sidecar.mjs"),
    winIconPath: join(namespaceRoot, "resources", "win", "icon.ico"),
    unpackedExePath: join(namespaceRoot, "builder", "win-unpacked", "map-design.exe"),
    unpackedRoot: join(namespaceRoot, "builder", "win-unpacked"),
  };
}

describe("materializeCachedUnpackedForInstaller", () => {
  it("overwrites cached packaged config and app package version", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-win-builder-"));
    const cachedUnpackedRoot = join(root, "cache", "builder", "win-unpacked");
    const paths = createPaths(root);

    try {
      await mkdir(join(cachedUnpackedRoot, "resources"), { recursive: true });
      await writeFile(join(cachedUnpackedRoot, "map-design.exe"), await createVersionedExecutable("0.5.0-beta.1"));
      await writeFile(
        join(cachedUnpackedRoot, "resources", "map-design-config.json"),
        `${JSON.stringify({ namespace: "first", version: 1 })}\n`,
        "utf8",
      );
      await mkdir(join(cachedUnpackedRoot, "resources", "app"), { recursive: true });
      await writeFile(
        join(cachedUnpackedRoot, "resources", "app", "package.json"),
        `${JSON.stringify({ name: "map-design-packaged-app", version: "0.5.0-beta.1" })}\n`,
        "utf8",
      );
      const nodePtyPrebuildRoot = join(
        cachedUnpackedRoot,
        "resources",
        "app",
        "node_modules",
        "node-pty",
        "prebuilds",
        "win32-x64",
      );
      await mkdir(nodePtyPrebuildRoot, { recursive: true });
      for (const fileName of [
        "conpty.node",
        "conpty_console_list.node",
        "pty.node",
        "winpty-agent.exe",
        "winpty.dll",
      ]) {
        await writeFile(join(nodePtyPrebuildRoot, fileName), Buffer.alloc(32 * 1024, 1));
      }
      await mkdir(join(paths.packagedConfigPath, ".."), { recursive: true });
      await writeFile(
        paths.packagedConfigPath,
        `${JSON.stringify({ appVersion: "0.5.0-beta.2", namespace: "second", version: 1 })}\n`,
        "utf8",
      );

      const manifest = await materializeCachedUnpackedForInstaller(cachedUnpackedRoot, paths, "0.5.0-beta.2");

      expect(manifest.source).toBe("namespace");
      expect(manifest.unpackedRoot).toBe(paths.unpackedRoot);
      await expect(readFile(join(paths.unpackedRoot, "resources", "map-design-config.json"), "utf8")).resolves.toContain(
        '"namespace":"second"',
      );
      await expect(readFile(join(paths.unpackedRoot, "resources", "app", "package.json"), "utf8")).resolves.toContain(
        '"version": "0.5.0-beta.2"',
      );
      await expect(readFile(join(paths.unpackedRoot, "resources", "map-design-config.json"), "utf8")).resolves.toContain(
        '"appVersion":"0.5.0-beta.2"',
      );
      await expect(readWinExecutableVersionSnapshot(join(paths.unpackedRoot, "map-design.exe"))).resolves.toMatchObject({
        fixedFileVersion: "0.5.0.0",
        fixedProductVersion: "0.5.0.0",
        stringTables: [
          {
            values: expect.objectContaining({
              FileVersion: "0.5.0-beta.2",
              ProductVersion: "0.5.0.0",
            }),
          },
        ],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("Windows pack artifact boundaries", () => {

  it("invalidates the NSIS installer cache when installer helper code changes", async () => {
    const source = await readFile(new URL("../src/win/builder.ts", import.meta.url), "utf8");
    expect(source).toContain("hashWinNsisInstallerImplementation");
    expect(source).toContain("nsisInstallerImplementation");
    expect(source.indexOf("nsisInstallerImplementation")).toBeLessThan(source.indexOf('target: "nsis-installer"'));
  });
});


async function createVersionedExecutable(packagedVersion: string): Promise<Buffer> {
  const executable = NtExecutable.createEmpty(false, false);
  const resource = NtExecutableResource.from(executable);
  const version = Resource.VersionInfo.createEmpty();
  version.lang = 1033;
  version.setFileVersion("0.5.0.0", 1033);
  version.setProductVersion("0.5.0.0", 1033);
  version.setStringValues(
    { codepage: 1200, lang: 1033 },
    {
      FileDescription: "MapDesign",
      FileVersion: packagedVersion,
      ProductName: "MapDesign",
      ProductVersion: "0.5.0.0",
    },
  );
  version.outputToResourceEntries(resource.entries);
  resource.outputResource(executable);
  return Buffer.from(executable.generate());
}
