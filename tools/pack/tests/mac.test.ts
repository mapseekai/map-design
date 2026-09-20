import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import type { ToolPackConfig } from "../src/config.js";
import {
  copyMacPrebundleRuntimeDependencies,
  copyResourceTree,
  createMacElectronRebuildOptions,
  renderMacPackagedConfig,
  validateMacMapDesignMcpCliPrebundle,
  validateMacNativeRebuildOutput,
} from "../src/mac/app.js";
import { runElectronBuilder } from "../src/mac/builder.js";
import { resolveSeededAppConfigPaths, seedPackagedAppConfig, writeLaunchPackagedConfig } from "../src/mac/index.js";
import { resolveMacPaths } from "../src/mac/paths.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function makeConfig(root: string, overrides: Partial<ToolPackConfig> = {}): ToolPackConfig {
  return {
    containerized: false,
    electronBuilderCliPath: "/x/electron-builder/cli.js",
    electronDistPath: "/x/electron/dist",
    electronVersion: "41.3.0",
    macCompression: "normal",
    namespace: "local-test",
    platform: "mac",
    portable: false,
    removeData: false,
    removeLogs: false,
    removeProductUserData: false,
    removeSidecars: false,
    roots: {
      output: {
        appBuilderRoot: join(root, ".tmp", "tools-pack", "out", "mac", "namespaces", "local-test", "builder"),
        namespaceRoot: join(root, ".tmp", "tools-pack", "out", "mac", "namespaces", "local-test"),
        platformRoot: join(root, ".tmp", "tools-pack", "out", "mac"),
        root: join(root, ".tmp", "tools-pack", "out"),
      },
      runtime: {
        namespaceBaseRoot: join(root, ".tmp", "tools-pack", "runtime", "mac", "namespaces"),
        namespaceRoot: join(root, ".tmp", "tools-pack", "runtime", "mac", "namespaces", "local-test"),
      },
      cacheRoot: join(root, ".tmp", "tools-pack", "cache"),
      toolPackRoot: join(root, ".tmp", "tools-pack"),
    },
    silent: true,
    signed: false,
    to: "app",
    webOutputMode: "standalone",
    workspaceRoot: root,
    ...overrides,
  };
}

const envState = { odDataDir: process.env.MAP_DESIGN_DATA_DIR };

afterEach(() => {
  if (envState.odDataDir == null) {
    delete process.env.MAP_DESIGN_DATA_DIR;
  } else {
    process.env.MAP_DESIGN_DATA_DIR = envState.odDataDir;
  }
});

describe("resolveSeededAppConfigPaths", () => {
  it("declares the MapDesign URL scheme in the packaged app metadata", async () => {
    const source = await readFile(new URL("../src/mac/builder.ts", import.meta.url), "utf8");
    expect(source).toContain("protocols: [");
    expect(source).toContain('schemes: ["map-design"]');
    expect(source).not.toContain(["open", "design"].join(""));
  });

  it("uses workspace .md by default", () => {
    const config = makeConfig("/work");
    expect(resolveSeededAppConfigPaths(config)).toEqual({
      sourcePath: join("/work", ".md", "app-config.json"),
      targetPath: join("/work", ".tmp", "tools-pack", "runtime", "mac", "namespaces", "local-test", "data", "app-config.json"),
    });
  });

  it("prefers MAP_DESIGN_DATA_DIR when provided", () => {
    process.env.MAP_DESIGN_DATA_DIR = "/custom/data";
    const config = makeConfig("/work");
    expect(resolveSeededAppConfigPaths(config)).toEqual({
      sourcePath: join("/custom/data", "app-config.json"),
      targetPath: join("/work", ".tmp", "tools-pack", "runtime", "mac", "namespaces", "local-test", "data", "app-config.json"),
    });
  });

  it("resolves relative MAP_DESIGN_DATA_DIR against the workspace root", () => {
    process.env.MAP_DESIGN_DATA_DIR = "e2e/ui/.map-design-data";
    const config = makeConfig("/work");
    expect(resolveSeededAppConfigPaths(config)).toEqual({
      sourcePath: resolve("/work", "e2e", "ui", ".map-design-data", "app-config.json"),
      targetPath: join("/work", ".tmp", "tools-pack", "runtime", "mac", "namespaces", "local-test", "data", "app-config.json"),
    });
  });

  it("expands $HOME-style MAP_DESIGN_DATA_DIR values", () => {
    process.env.MAP_DESIGN_DATA_DIR = "$HOME/.map-design";
    const config = makeConfig("/work");
    expect(resolveSeededAppConfigPaths(config)).toEqual({
      sourcePath: join(os.homedir(), ".map-design", "app-config.json"),
      targetPath: join("/work", ".tmp", "tools-pack", "runtime", "mac", "namespaces", "local-test", "data", "app-config.json"),
    });
  });
});

describe("seedPackagedAppConfig", () => {
  it("copies the current app-config into the packaged runtime namespace", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-pack-mac-"));
    try {
      const config = makeConfig(root);
      const sourceDir = join(root, ".md");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        join(sourceDir, "app-config.json"),
        `${JSON.stringify({ onboardingCompleted: true, agentId: "codex", agentCliEnv: { codex: { CODEX_BIN: "/Applications/Codex.app/Contents/Resources/codex" } } }, null, 2)}\n`,
        "utf8",
      );

      await seedPackagedAppConfig(config);

      await expect(
        readFile(join(config.roots.runtime.namespaceRoot, "data", "app-config.json"), "utf8"),
      ).resolves.toContain('"agentId": "codex"');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("skips seeding for portable builds", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-pack-mac-"));
    try {
      const config = makeConfig(root, { portable: true });
      const sourceDir = join(root, ".md");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, "app-config.json"), "{\n  \"agentId\": \"codex\"\n}\n", "utf8");

      await seedPackagedAppConfig(config);

      await expect(
        readFile(join(config.roots.runtime.namespaceRoot, "data", "app-config.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("copyResourceTree", () => {
  it("does not embed the build machine Node launcher into mac resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-pack-mac-"));
    try {
      const config = makeConfig(root);
      const paths = resolveMacPaths(config);
      await writeFile(join(root, "DESIGN.md"), "# Interface design\n", "utf8");
      const resourceNames = [
        "skills",
        "design-templates",
        "design-systems",
        "craft",
        "assets/frames",
        "assets/community-pets",
        "prompt-templates",
      ];

      for (const name of resourceNames) {
        await mkdir(join(root, name), { recursive: true });
      }

      await copyResourceTree(config, paths);

      expect(await pathExists(join(paths.resourceRoot, "bin", "node"))).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("copyMacPrebundleRuntimeDependencies", () => {
  it("copies the pinned prebuilt fsevents binding into the assembled app", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-pack-mac-"));
    try {
      const config = makeConfig(root);
      const chokidarRoot = join(root, "tools", "pack", "node_modules", "chokidar");
      const sourceRoot = join(chokidarRoot, "node_modules", "fsevents");
      const appRoot = join(root, "assembled", "app");
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(join(chokidarRoot, "package.json"), '{"name":"chokidar","version":"3.6.0"}\n', "utf8");
      await writeFile(join(sourceRoot, "package.json"), '{"name":"fsevents","version":"2.3.3"}\n', "utf8");
      await writeFile(join(sourceRoot, "fsevents.js"), "module.exports = {};\n", "utf8");
      await writeFile(join(sourceRoot, "fsevents.node"), "prebuilt-native-binding", "utf8");

      await copyMacPrebundleRuntimeDependencies(config, appRoot);

      await expect(readFile(join(appRoot, "node_modules", "fsevents", "fsevents.node"), "utf8")).resolves.toBe(
        "prebuilt-native-binding",
      );
      await expect(readFile(join(appRoot, "node_modules", "fsevents", "fsevents.js"), "utf8")).resolves.toBe(
        "module.exports = {};\n",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a workspace fsevents version that drifted from the assembly contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-pack-mac-"));
    try {
      const config = makeConfig(root);
      const chokidarRoot = join(root, "tools", "pack", "node_modules", "chokidar");
      const sourceRoot = join(chokidarRoot, "node_modules", "fsevents");
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(join(chokidarRoot, "package.json"), '{"name":"chokidar","version":"3.6.0"}\n', "utf8");
      await writeFile(join(sourceRoot, "package.json"), '{"name":"fsevents","version":"2.3.2"}\n', "utf8");

      await expect(copyMacPrebundleRuntimeDependencies(config, join(root, "assembled", "app"))).rejects.toThrow(
        /fsevents expected 2\.3\.3, found 2\.3\.2/,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("renderMacPackagedConfig", () => {
  it("omits nodeCommandRelative so packaged mac sidecars use Electron as Node", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-pack-mac-"));
    try {
      const config = makeConfig(root);

      const packagedConfig = JSON.parse(
        renderMacPackagedConfig({
          appVersion: "1.2.3",
          config,
          usePrebundledStandaloneWeb: true,
        }),
      ) as Record<string, unknown>;
      expect(packagedConfig).not.toHaveProperty("nodeCommandRelative");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

});

describe("runElectronBuilder", () => {
  async function prepareElectronBuilderConfig(root: string, overrides: Partial<ToolPackConfig>) {
    const cliPath = join(root, "fake-electron-builder.mjs");

    const config = makeConfig(root, {
      appVersion: "1.2.3-prerelease.4",
      electronBuilderCliPath: cliPath,
      signed: true,
      webOutputMode: "server",
      ...overrides,
    });
    const paths = resolveMacPaths(config);
    const nodePtyPrebuildRoot = join(
      paths.appPath,
      "Contents",
      "Resources",
      "app",
      "node_modules",
      "node-pty",
      "prebuilds",
      `darwin-${process.arch}`,
    );
    await writeFile(
      cliPath,
      [
        'import { chmod, mkdir, writeFile } from "node:fs/promises";',
        `const prebuildRoot = ${JSON.stringify(nodePtyPrebuildRoot)};`,
        "await mkdir(prebuildRoot, { recursive: true });",
        'await writeFile(new URL("pty.node", `file://${prebuildRoot}/`), Buffer.alloc(32 * 1024, 1));',
        'await writeFile(new URL("spawn-helper", `file://${prebuildRoot}/`), "#!/bin/sh\\nexit 0\\n", "utf8");',
        'await chmod(new URL("spawn-helper", `file://${prebuildRoot}/`), 0o755);',
        "",
      ].join("\n"),
      "utf8",
    );

    await runElectronBuilder(config, paths, ["dir"]);

    return JSON.parse(await readFile(paths.appBuilderConfigPath, "utf8")) as {
      afterSign?: string;
      mac?: {
        notarize?: boolean;
      };
      protocols?: Array<{ name: string; schemes: string[] }>;
    };
  }

  it("does not explicitly disable electron-builder notarization for notarized mac builds", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-pack-mac-"));
    try {
      const builderConfig = await prepareElectronBuilderConfig(root, { macNotarize: true });

      expect(builderConfig.afterSign).toContain("notarize.cjs");
      expect(builderConfig.mac).not.toHaveProperty("notarize");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps signed-only mac builds from invoking electron-builder notarization", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-pack-mac-"));
    try {
      const builderConfig = await prepareElectronBuilderConfig(root, { macNotarize: false });

      expect(builderConfig.afterSign).toBeUndefined();
      expect(builderConfig.mac?.notarize).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not emit updater publish metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-pack-mac-"));
    try {
      const builderConfig = await prepareElectronBuilderConfig(root, { macNotarize: false });

      expect(builderConfig).not.toHaveProperty("publish");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("registers only the MapDesign protocol", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-pack-mac-"));
    try {
      const builderConfig = await prepareElectronBuilderConfig(root, { macNotarize: false });

      expect(builderConfig.protocols).toEqual([{ name: "MapDesign Protocol", schemes: ["map-design"] }]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("createMacElectronRebuildOptions", () => {
  it("targets the packaged Electron ABI for required native modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-pack-mac-"));
    try {
      const config = makeConfig(root, { electronVersion: "41.3.0" });
      const appRoot = join(root, "assembled", "app");

      expect(createMacElectronRebuildOptions(config, appRoot)).toMatchObject({
        arch: process.arch,
        buildFromSource: false,
        buildPath: appRoot,
        electronVersion: "41.3.0",
        force: true,
        mode: "sequential",
        onlyModules: ["better-sqlite3"],
        platform: "darwin",
        projectRootPath: appRoot,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("validateMacNativeRebuildOutput", () => {
  it("reports a missing rebuilt native module as missing output", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-pack-mac-"));
    try {
      await expect(validateMacNativeRebuildOutput(root)).resolves.toBe(
        `native module output is missing: ${join(root, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node")}`,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("preserves non-ENOENT filesystem diagnostics from stat failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-pack-mac-"));
    try {
      const buildPath = join(root, "node_modules", "better-sqlite3", "build");
      const nativePath = join(buildPath, "Release", "better_sqlite3.node");
      await mkdir(dirname(buildPath), { recursive: true });
      await writeFile(buildPath, "not a directory", "utf8");

      const result = await validateMacNativeRebuildOutput(root);
      if (process.platform === "win32") {
        await expect(Promise.resolve(result)).resolves.toBe(
          `native module output is missing: ${nativePath}`,
        );
      } else {
        await expect(Promise.resolve(result)).resolves.toContain(
          `native module output could not be inspected: ${nativePath}: ENOTDIR: not a directory, stat '${nativePath}'`,
        );
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("validateMacMapDesignMcpCliPrebundle", () => {
  it("accepts a private CLI that exits safely without authorization", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-pack-mac-mcp-"));
    const entry = join(root, "map-design-mcp-cli.mjs");
    try {
      await writeFile(entry, 'process.stderr.write("MapDesign MCP server failed to start.\\n"); process.exitCode = 1;\n', "utf8");
      await expect(validateMacMapDesignMcpCliPrebundle(entry)).resolves.toBeNull();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a private CLI that writes non-protocol stdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-pack-mac-mcp-"));
    const entry = join(root, "map-design-mcp-cli.mjs");
    try {
      await writeFile(entry, 'process.stdout.write("noise\\n"); process.exitCode = 1;\n', "utf8");
      await expect(validateMacMapDesignMcpCliPrebundle(entry)).resolves.toBe(
        "mac MapDesign MCP CLI wrote unexpected stdout during startup validation.",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("writeLaunchPackagedConfig", () => {
  it("injects the tools-pack runtime namespace root without mutating the packaged app config", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-pack-mac-"));
    try {
      const config = makeConfig(root, { namespace: "local-test", portable: true });
      const appPath = join(root, "MapDesign.app");
      const embeddedConfigPath = join(appPath, "Contents", "Resources", "map-design-config.json");
      await mkdir(dirname(embeddedConfigPath), { recursive: true });
      await writeFile(
        embeddedConfigPath,
        `${JSON.stringify(
          {
            appVersion: "0.5.1-beta.2",
            namespace: "packaged-default",
            nodeCommandRelative: "map-design/bin/node",
            webOutputMode: "standalone",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const launchConfigPath = await writeLaunchPackagedConfig(config, appPath);
      const launchConfig = JSON.parse(await readFile(launchConfigPath, "utf8")) as Record<string, unknown>;
      const embeddedConfig = JSON.parse(await readFile(embeddedConfigPath, "utf8")) as Record<string, unknown>;

      expect(launchConfigPath).toBe(join(config.roots.runtime.namespaceRoot, "runtime", "map-design-config.json"));
      expect(launchConfig).toMatchObject({
        appVersion: "0.5.1-beta.2",
        namespace: "local-test",
        namespaceBaseRoot: config.roots.runtime.namespaceBaseRoot,
        nodeCommandRelative: "map-design/bin/node",
        webOutputMode: "standalone",
      });
      expect(embeddedConfig).not.toHaveProperty("namespaceBaseRoot");
      expect(embeddedConfig.namespace).toBe("packaged-default");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
