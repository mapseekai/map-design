import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { resolveToolPackConfig } from "../src/config.js";
import { winResources } from "../src/resources.js";
import { resolveWinPaths } from "../src/win/paths.js";
import { buildWinPortableZip } from "../src/win/zip.js";

it.skipIf(process.platform !== "win32")("round-trips the portable executable and nested resources at the ZIP root", async () => {
  const root = await mkdtemp(join(tmpdir(), "map-design-portable-zip-"));
  try {
    const config = resolveToolPackConfig("win", { dir: root, namespace: "zip-test", portable: true, to: "zip" });
    const paths = resolveWinPaths(config);
    const resourcePath = join("resources", "app", "map data.bin");
    const executable = Buffer.from("MZ portable fixture");
    const resource = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80]);
    await mkdir(dirname(join(paths.unpackedRoot, resourcePath)), { recursive: true });
    await writeFile(paths.unpackedExePath, executable);
    await writeFile(join(paths.unpackedRoot, resourcePath), resource);

    await buildWinPortableZip(config, paths, {
      version: 1,
      source: "namespace",
      unpackedRoot: paths.unpackedRoot,
      executablePath: paths.unpackedExePath,
      appBuilderOutputRoot: paths.appBuilderOutputRoot,
      configPath: paths.packagedConfigPath,
      cacheEntryPath: null,
      webStandaloneHookAuditPath: null,
    });

    const extracted = join(root, "extracted app");
    await promisify(execFile)(winResources.sevenZipExe, ["x", "-tzip", paths.setupZipPath, `-o${extracted}`, "-y"], {
      timeout: 30_000,
      windowsHide: true,
    });
    expect(await readFile(join(extracted, "map-design.exe"))).toEqual(executable);
    expect(await readFile(join(extracted, resourcePath))).toEqual(resource);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
