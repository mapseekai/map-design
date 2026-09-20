
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

import { requestJsonIpc, resolveAppIpcPath } from "@mapseekai/sidecar";
import { MAP_DESIGN_SIDECAR_CONTRACT } from "@mapseekai/sidecar-proto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@mapseekai/sidecar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mapseekai/sidecar")>();
  return {
    ...actual,
    requestJsonIpc: vi.fn(async () => {
      throw new Error("requestJsonIpc mock requires explicit setup");
    }),
  };
});

import type { ToolPackConfig } from "../src/config.js";
import {
  buildDockerArgs,
  cleanupPackedLinuxNamespace,
  createLinuxAssembledPackageJson,
  createLinuxBuilderConfig,
  createLinuxDesktopLaunchEnv,
  inspectPackedLinuxApp,
  LINUX_APPIMAGE_EXECUTABLE_ARGS,
  matchesAppImageProcess,
  renderDesktopTemplate,
  renderLinuxAppImageAppRun,
  renderLinuxPackagedMainEntry,
  resolveProductionInstallCommand,
  stopPackedLinuxApp,
  sanitizeNamespace,
} from "../src/linux.js";

const linuxCliSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const linuxLifecycleSource = readFileSync(new URL("../src/linux.ts", import.meta.url), "utf8");


async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function makeConfig(): ToolPackConfig {
  return {
    containerized: true,
    electronBuilderCliPath: "/x/electron-builder/cli.js",
    electronDistPath: "/x/electron/dist",
    electronVersion: "41.3.0",
    macCompression: "normal",
    namespace: "default",
    platform: "linux",
    portable: false,
    removeData: false,
    removeLogs: false,
    removeProductUserData: false,
    removeSidecars: false,
    roots: {
      output: {
        appBuilderRoot: "/work/.tmp/tools-pack/out/linux/namespaces/default/builder",
        namespaceRoot: "/work/.tmp/tools-pack/out/linux/namespaces/default",
        platformRoot: "/work/.tmp/tools-pack/out/linux",
        root: "/work/.tmp/tools-pack/out",
      },
      runtime: {
        namespaceBaseRoot: "/work/.tmp/tools-pack/runtime/linux/namespaces",
        namespaceRoot: "/work/.tmp/tools-pack/runtime/linux/namespaces/default",
      },
      cacheRoot: "/work/.tmp/tools-pack/cache",
      toolPackRoot: "/work/.tmp/tools-pack",
    },
    silent: true,
    signed: false,
    to: "all",
    webOutputMode: "server",
    workspaceRoot: "/work",
  };
}

describe("Linux packaged identity", () => {
  it("generates canonical MapDesign metadata, protocol, and disabled publishing", () => {
    const packageJson = createLinuxAssembledPackageJson(
      { "@mapseekai/packaged": "file:packaged.tgz" },
      "1.2.3",
    );
    const builderConfig = createLinuxBuilderConfig(
      makeConfig(),
      {
        appBuilderOutputRoot: "/work/builder",
        appImageAppRunPath: "/work/appimage/AppRun",
        assembledAppRoot: "/work/assembled/app",
        packagedConfigPath: "/work/map-design-config.json",
        resourceRoot: "/work/resources/map-design",
      },
      "1.2.3",
    );

    expect(packageJson).toMatchObject({
      author: "MapDesign Team",
      description: "MapDesign is a local-first cartographic workspace for map creation and exploration.",
      name: "map-design-packaged",
    });
    expect(builderConfig).toMatchObject({
      executableName: "map-design",
      productName: "MapDesign",
      publish: null,
      protocols: [{ name: "MapDesign", schemes: ["map-design"] }],
    });
    expect(builderConfig.linux).toMatchObject({
      maintainer: "MapDesign Contributors",
      synopsis: "MapDesign cartographic workspace",
    });
    expect(builderConfig.extraResources).toEqual(
      expect.arrayContaining([{ from: "/work/resources/map-design", to: "map-design" }]),
    );
  });

  it("keeps root package metadata cartographic and MapDesign-specific", () => {
    const rootPackageJson = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { description: string; name: string };

    expect(rootPackageJson).toMatchObject({
      name: "map-design",
      description: "MapDesign is a local-first cartographic workspace for map creation and exploration.",
    });
  });
});

const linuxOnlyIt = process.platform === "linux" ? it : it.skip;

async function waitForChildExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("buildDockerArgs", () => {
  it("returns the expected docker argv array", () => {
    const args = buildDockerArgs(makeConfig(), { uid: 1000, gid: 1000 });
    expect(args[0]).toBe("run");
    expect(args).toContain("--rm");
    expect(args).toContain("--user");
    expect(args).toContain("1000:1000");
    expect(args).toContain("electronuserland/builder:base");
  });

  it("mounts the workspace at /project", () => {
    const args = buildDockerArgs(makeConfig(), { uid: 1000, gid: 1000 });
    expect(args).toContain("-v");
    expect(args).toContain("/work:/project");
  });

  it("mounts docker home and electron caches under .tmp/tools-pack/.docker-*", () => {
    const args = buildDockerArgs(makeConfig(), { uid: 1000, gid: 1000 });
    expect(args).toContain(`${posix.join("/work/.tmp/tools-pack", ".docker-home")}:/home/builder`);
    expect(args).toContain(`${posix.join("/work/.tmp/tools-pack", ".docker-cache", "electron")}:/home/builder/.cache/electron`);
    expect(args).toContain(
      `${posix.join("/work/.tmp/tools-pack", ".docker-cache", "electron-builder")}:/home/builder/.cache/electron-builder`,
    );
  });

  it("mounts the tool-pack root at /tools-pack so inner build writes to host-visible output dir", () => {
    const args = buildDockerArgs(makeConfig(), { uid: 1000, gid: 1000 });
    expect(args).toContain("/work/.tmp/tools-pack:/tools-pack");
  });

  it("sets HOME and ELECTRON_CACHE env vars", () => {
    const args = buildDockerArgs(makeConfig(), { uid: 1000, gid: 1000 });
    expect(args).toContain("HOME=/home/builder");
    expect(args).toContain("ELECTRON_CACHE=/home/builder/.cache/electron");
    expect(args).toContain("ELECTRON_BUILDER_CACHE=/home/builder/.cache/electron-builder");
  });


  it("runs the built tools-pack CLI through node inside the container without generated package-bin shims", () => {
    const args = buildDockerArgs(makeConfig(), { uid: 1000, gid: 1000 });
    const last = args[args.length - 1];
    expect(last).toMatch(/command -v curl >\/dev\/null/);
    expect(last).toMatch(/case "\$\(uname -m\)" in/);
    expect(last).toMatch(/x86_64\) PNPM_ASSET=pnpm-linuxstatic-x64; PNPM_SHA256=[a-f0-9]{64}/);
    expect(last).toMatch(/aarch64\) PNPM_ASSET=pnpm-linuxstatic-arm64; PNPM_SHA256=[a-f0-9]{64}/);
    expect(last).toMatch(
      /curl --retry 3 --retry-all-errors --connect-timeout 10 --max-time 60 -fsSL "https:\/\/github\.com\/pnpm\/pnpm\/releases\/download\/v\d+\.\d+\.\d+\/\$PNPM_ASSET" -o \/tmp\/pnpm\.tmp/,
    );
    expect(last).toMatch(/echo "\$PNPM_SHA256  \/tmp\/pnpm\.tmp" \| sha256sum -c -/);
    expect(last).toMatch(/mv \/tmp\/pnpm\.tmp \/tmp\/pnpm/);
    expect(last).toMatch(/chmod \+x \/tmp\/pnpm/);
    expect(last).toMatch(/\/tmp\/pnpm env use --global 24\.\d+\.\d+/);
    expect(last).toMatch(/\/tmp\/pnpm install --frozen-lockfile/);
    expect(last).toMatch(/node tools\/pack\/bin\/tools-pack\.mjs linux build --to all --namespace default/);
    expect(last).not.toMatch(/\/tmp\/pnpm tools-pack linux build/);
    expect(last).not.toMatch(/--containerized/);
  });

  it("fetches pnpm standalone binary instead of relying on image npm tooling", () => {
    const args = buildDockerArgs(makeConfig(), { uid: 1000, gid: 1000 });
    const last = args[args.length - 1];
    expect(last).not.toMatch(/corepack/);
    expect(last).not.toMatch(/\bnpx\b/);
    expect(last).not.toMatch(/(^|[;&|]\s*)npm(\s|$)/);
    expect(last).toMatch(/pnpm-linuxstatic-x64/);
    expect(last).toMatch(/pnpm-linuxstatic-arm64/);
  });

  it("routes container setup and install output to stderr before the JSON-emitting build", () => {
    const args = buildDockerArgs(makeConfig(), { uid: 1000, gid: 1000 });
    const last = args[args.length - 1];
    expect(last).toContain("{ command -v curl");
    expect(last).toContain("/tmp/pnpm install --frozen-lockfile; } >&2 && node tools/pack/bin/tools-pack.mjs linux build");
    expect(last.indexOf("/tmp/pnpm install --frozen-lockfile")).toBeLessThan(
      last.indexOf("} >&2 && node tools/pack/bin/tools-pack.mjs linux build"),
    );
  });

  it("picks the pnpm asset by container CPU so amd64 and arm64 hosts both work", () => {
    const args = buildDockerArgs(makeConfig(), { uid: 1000, gid: 1000 });
    const last = args[args.length - 1];
    expect(last).toContain('case "$(uname -m)" in');
    expect(last).toContain("x86_64) PNPM_ASSET=pnpm-linuxstatic-x64");
    expect(last).toContain("aarch64) PNPM_ASSET=pnpm-linuxstatic-arm64");
    expect(last).toMatch(/unsupported container arch/);
  });

  it("verifies the downloaded standalone pnpm binary before executing it", () => {
    const args = buildDockerArgs(makeConfig(), { uid: 1000, gid: 1000 });
    const last = args[args.length - 1];
    expect(last).toMatch(/PNPM_SHA256=[a-f0-9]{64}/);
    expect(last).toMatch(/sha256sum -c -/);
    expect(last).toMatch(/\/tmp\/pnpm\.tmp/);
    expect(last.indexOf("sha256sum -c -")).toBeLessThan(last.indexOf("mv /tmp/pnpm.tmp /tmp/pnpm"));
    expect(last.indexOf("mv /tmp/pnpm.tmp /tmp/pnpm")).toBeLessThan(last.indexOf("chmod +x /tmp/pnpm"));
  });

  it("hardcoded pnpm version stays in lockstep with root package.json `packageManager`", () => {
    // Guard against silent drift: if someone bumps packageManager in the
    // root package.json but forgets to update PNPM_VERSION in linux.ts,
    // the Linux container build would silently keep downloading the old pnpm.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
      packageManager?: string;
    };
    const match = String(rootPkg.packageManager ?? "").match(/^pnpm@(\d+\.\d+\.\d+)$/);
    expect(match, `expected root packageManager "pnpm@x.y.z", got ${rootPkg.packageManager}`).not.toBeNull();
    const expectedVersion = match![1];

    const args = buildDockerArgs(makeConfig(), { uid: 1000, gid: 1000 });
    const last = args[args.length - 1];
    expect(last).toContain(`pnpm/releases/download/v${expectedVersion}/$PNPM_ASSET`);
  });

  it("container Node major stays in lockstep with root .node-version", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const expectedMajor = readFileSync(join(repoRoot, ".node-version"), "utf-8").trim();
    const args = buildDockerArgs(makeConfig(), { uid: 1000, gid: 1000 });
    const last = args[args.length - 1];
    const match = last.match(/\/tmp\/pnpm env use --global (\d+)\.\d+\.\d+/);
    expect(match, "expected container bootstrap to install an explicit Node version").not.toBeNull();
    expect(match?.[1]).toBe(expectedMajor);
  });

  it("forwards --dir /tools-pack so inner build output lands under the mounted host dir", () => {
    const args = buildDockerArgs(makeConfig(), { uid: 1000, gid: 1000 });
    const last = args[args.length - 1];
    expect(last).toMatch(/--dir \/tools-pack/);
  });

  it("forwards --portable when config.portable is true", () => {
    const args = buildDockerArgs({ ...makeConfig(), portable: true }, { uid: 1000, gid: 1000 });
    const last = args[args.length - 1];
    expect(last).toMatch(/--portable/);
  });


  it("omits --portable when config.portable is false", () => {
    const args = buildDockerArgs(makeConfig(), { uid: 1000, gid: 1000 });
    const last = args[args.length - 1];
    expect(last).not.toMatch(/--portable/);
  });

  it("forwards a shell-quoted --app-version to the inner build", () => {
    const args = buildDockerArgs(
      { ...makeConfig(), appVersion: "0.5.0-beta.1;echo-nope" },
      { uid: 1000, gid: 1000 },
    );
    const last = args[args.length - 1];
    expect(last).toContain("--app-version '0.5.0-beta.1;echo-nope'");
  });

  it("shell-quotes apostrophes in --app-version", () => {
    const args = buildDockerArgs(
      { ...makeConfig(), appVersion: "0.5.0-beta.1'quoted" },
      { uid: 1000, gid: 1000 },
    );
    const last = args[args.length - 1];
    expect(last).toContain("--app-version '0.5.0-beta.1'\\''quoted'");
  });

  it("exports MAP_DESIGN_TOOLS_PACK_PNPM_BIN=/tmp/pnpm so the inner build's production install skips npm", () => {
    const args = buildDockerArgs(makeConfig(), { uid: 1000, gid: 1000 });
    const envFlagIndex = args.findIndex(
      (arg, i) => arg === "-e" && args[i + 1] === "MAP_DESIGN_TOOLS_PACK_PNPM_BIN=/tmp/pnpm",
    );
    expect(envFlagIndex).toBeGreaterThan(-1);
  });
});


describe("stopPackedLinuxApp", () => {
  linuxOnlyIt("treats a direct AppRun-launched Electron process as owned", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-linux-direct-apprun-"));
    const namespace = "direct-apprun";
    const outputNamespaceRoot = join(root, "out", "linux", "namespaces", namespace);
    const runtimeNamespaceBaseRoot = join(root, "runtime", "linux", "namespaces");
    const runtimeNamespaceRoot = join(runtimeNamespaceBaseRoot, namespace);
    const config: ToolPackConfig = {
      ...makeConfig(),
      namespace,
      roots: {
        ...makeConfig().roots,
        output: {
          ...makeConfig().roots.output,
          appBuilderRoot: join(outputNamespaceRoot, "builder"),
          namespaceRoot: outputNamespaceRoot,
        },
        runtime: {
          namespaceBaseRoot: runtimeNamespaceBaseRoot,
          namespaceRoot: runtimeNamespaceRoot,
        },
      },
    };
    const appDir = join(root, "AppDir");
    const executablePath = join(appDir, "map-design");
    const appRunPath = join(appDir, "AppRun");
    const markerPath = join(runtimeNamespaceRoot, "runtime", "desktop-root.json");
    const stamp = {
      app: "desktop",
      ipc: resolveAppIpcPath({
        app: "desktop",
        contract: MAP_DESIGN_SIDECAR_CONTRACT,
        namespace,
      }),
      mode: "runtime",
      namespace,
      source: "packaged",
    };
    let child: ChildProcess | null = null;

    try {
      await mkdir(appDir, { recursive: true });
      await copyFile(process.execPath, executablePath);
      await chmod(executablePath, 0o755);
      await writeFile(appRunPath, "#!/bin/sh\n", "utf8");
      await mkdir(config.roots.output.appBuilderRoot, { recursive: true });
      await writeFile(join(config.roots.output.appBuilderRoot, "MapDesign.direct-apprun.AppImage"), "", "utf8");

      child = spawn(executablePath, ["-e", "setInterval(() => {}, 1000)"], {
        env: { ...process.env, APPIMAGE: appRunPath },
        stdio: "ignore",
      });
      await new Promise<void>((resolve, reject) => {
        child?.once("spawn", resolve);
        child?.once("error", reject);
      });
      expect(child.pid).toEqual(expect.any(Number));
      await access(`/proc/${child.pid}/exe`);

      await mkdir(dirname(markerPath), { recursive: true });
      await writeFile(
        markerPath,
        `${JSON.stringify({
          appPath: "/",
          executablePath,
          logPath: join(runtimeNamespaceRoot, "logs", "desktop", "latest.log"),
          namespaceRoot: runtimeNamespaceRoot,
          pid: child.pid,
          ppid: process.pid,
          stamp,
          startedAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          version: 1,
        })}\n`,
        "utf8",
      );

      vi.mocked(requestJsonIpc).mockRejectedValue(new Error("shutdown unavailable in test"));
      const result = await stopPackedLinuxApp(config);

      expect(result.status).toBe("stopped");
      expect(result.stoppedPids).toContain(child.pid);
      expect(result.remainingPids).toEqual([]);
    } finally {
      if (child?.pid != null && child.exitCode == null && child.signalCode == null) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
        await waitForChildExit(child, 1000);
      }
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("resolveProductionInstallCommand", () => {
  it("defaults to npm install --omit=dev --no-package-lock when MAP_DESIGN_TOOLS_PACK_PNPM_BIN is unset", () => {
    expect(resolveProductionInstallCommand({})).toEqual({
      command: "npm",
      args: ["install", "--omit=dev", "--no-package-lock"],
    });
  });

  it("treats an empty MAP_DESIGN_TOOLS_PACK_PNPM_BIN as unset and keeps the npm host default", () => {
    expect(resolveProductionInstallCommand({ MAP_DESIGN_TOOLS_PACK_PNPM_BIN: "" })).toEqual({
      command: "npm",
      args: ["install", "--omit=dev", "--no-package-lock"],
    });
  });

  it("uses MAP_DESIGN_TOOLS_PACK_PNPM_BIN with hoisted-layout pnpm flags when set", () => {
    // --config.node-linker=hoisted intentionally matches the prior
    // npm/electron-builder packaging layout so the AppImage pack step keeps
    // working when the assembled-app install runs through pnpm.
    expect(
      resolveProductionInstallCommand({ MAP_DESIGN_TOOLS_PACK_PNPM_BIN: "/tmp/pnpm" }),
    ).toEqual({
      command: "/tmp/pnpm",
      args: ["install", "--prod", "--no-lockfile", "--config.node-linker=hoisted"],
    });
  });

  it("chains end-to-end with buildDockerArgs: docker exports MAP_DESIGN_TOOLS_PACK_PNPM_BIN and the resolver returns the standalone pnpm install for that value", () => {
    const dockerArgs = buildDockerArgs(makeConfig(), { uid: 1000, gid: 1000 });
    const envFlagIndex = dockerArgs.findIndex(
      (arg, i) => arg === "-e" && dockerArgs[i + 1]?.startsWith("MAP_DESIGN_TOOLS_PACK_PNPM_BIN="),
    );
    expect(envFlagIndex).toBeGreaterThan(-1);
    const envValue = dockerArgs[envFlagIndex + 1]?.split("=")[1];
    expect(envValue).toBe("/tmp/pnpm");

    const resolved = resolveProductionInstallCommand({ MAP_DESIGN_TOOLS_PACK_PNPM_BIN: envValue });
    expect(resolved).toEqual({
      command: "/tmp/pnpm",
      args: ["install", "--prod", "--no-lockfile", "--config.node-linker=hoisted"],
    });
    expect(resolved.command).not.toBe("npm");
  });
});

describe("renderDesktopTemplate", () => {
  const template = `[Desktop Entry]
Type=Application
Name=MapDesign (@@NAMESPACE@@)
Exec=env -u ELECTRON_RUN_AS_NODE MAP_DESIGN_NAMESPACE=@@NAMESPACE@@ @@EXEC_PATH@@ --appimage-extract-and-run %U
Icon=@@ICON_PATH@@
MimeType=x-scheme-handler/map-design;
`;

  it("substitutes all @@TOKEN@@ placeholders", () => {
    const out = renderDesktopTemplate(template, {
      namespace: "default",
      execPath: "/home/u/.local/bin/MapDesign.default.AppImage",
      iconName: "map-design-default",
    });
    expect(out).toContain("Name=MapDesign (default)");
    expect(out).toContain(
      "Exec=env -u ELECTRON_RUN_AS_NODE MAP_DESIGN_NAMESPACE=default /home/u/.local/bin/MapDesign.default.AppImage --appimage-extract-and-run %U",
    );
    expect(out).toContain("Icon=map-design-default");
  });

  it("uses MAP_DESIGN_NAMESPACE so packaged launches retain the namespace override", () => {
    const out = renderDesktopTemplate(template, {
      namespace: "ns",
      execPath: "/x",
      iconName: "map-design-ns",
    });
    expect(out).toMatch(/^Exec=env -u ELECTRON_RUN_AS_NODE MAP_DESIGN_NAMESPACE=ns /m);
  });

  it("unsets ELECTRON_RUN_AS_NODE on the Exec= line so desktop launches run Electron normally", () => {
    const out = renderDesktopTemplate(template, {
      namespace: "ns",
      execPath: "/x",
      iconName: "map-design-ns",
    });
    expect(out).toMatch(/^Exec=env -u ELECTRON_RUN_AS_NODE /m);
  });

  it("preserves --appimage-extract-and-run on the Exec= line so menu launches bypass FUSE", () => {
    const out = renderDesktopTemplate(template, {
      namespace: "ns",
      execPath: "/x",
      iconName: "map-design-ns",
    });
    expect(out).toMatch(/^Exec=.*--appimage-extract-and-run .*%U$/m);
  });

  it("leaves no @@...@@ tokens unsubstituted", () => {
    const out = renderDesktopTemplate(template, {
      namespace: "ns",
      execPath: "/x",
      iconName: "map-design-ns",
    });
    expect(out).not.toMatch(/@@[A-Z_]+@@/);
  });

  it("preserves the MimeType=x-scheme-handler/map-design; line", () => {
    const out = renderDesktopTemplate(template, {
      namespace: "ns",
      execPath: "/x",
      iconName: "map-design-ns",
    });
    expect(out).toContain("MimeType=x-scheme-handler/map-design;");
  });
});

  it("keeps the installed desktop entry on the MapDesign identity", () => {
    const templatePath = new URL("../resources/linux/map-design.desktop.template", import.meta.url);
    const installedTemplate = readFileSync(templatePath, "utf8");

    expect(installedTemplate).toContain("Name=MapDesign (@@NAMESPACE@@)");
    expect(installedTemplate).toContain("StartupWMClass=MapDesign");
    expect(installedTemplate).toContain("Icon=@@ICON_PATH@@");
    expect(installedTemplate).toContain("Exec=env -u ELECTRON_RUN_AS_NODE MAP_DESIGN_NAMESPACE=@@NAMESPACE@@ @@EXEC_PATH@@ --appimage-extract-and-run %U");
    expect(installedTemplate).toContain("MimeType=x-scheme-handler/map-design;");
  });

describe("renderLinuxPackagedMainEntry", () => {
  it("loads the ESM packaged entry without require or temporary keepalive handles", () => {
    const out = renderLinuxPackagedMainEntry();

    expect(out).toContain('import("@mapseekai/packaged")');
    expect(out).not.toContain('require("@mapseekai/packaged")');
    expect(out).not.toContain("setTimeout");
  });
});


describe("LINUX_APPIMAGE_EXECUTABLE_ARGS", () => {
  it("keeps the AppImage no-sandbox fallback explicit for constrained Linux hosts", () => {
    expect([...LINUX_APPIMAGE_EXECUTABLE_ARGS]).toEqual(["--no-sandbox"]);
  });
});

describe("renderLinuxAppImageAppRun", () => {
  it("unsets ELECTRON_RUN_AS_NODE before execing the Electron binary", () => {
    const out = renderLinuxAppImageAppRun();

    expect(out).toContain("unset ELECTRON_RUN_AS_NODE");
    expect(out.indexOf("unset ELECTRON_RUN_AS_NODE")).toBeLessThan(out.indexOf('exec "$BIN"'));
    expect(out).toContain('BIN="$APPDIR/map-design"');
  });

  it("preserves AppImageLauncher install-only behavior", () => {
    const out = renderLinuxAppImageAppRun();

    expect(out).toContain('if [ -z "$APPIMAGE_EXIT_AFTER_INSTALL" ] ; then');
    expect(out).toContain("trap atexit EXIT");
  });

  it("passes desktop Exec arguments through to Electron", () => {
    const out = renderLinuxAppImageAppRun();

    expect(out).toContain('args=("$@")');
    expect(out).toContain('exec "$BIN" "${args[@]}"');
  });

  it("sets APPIMAGE when running an extracted AppRun directly", () => {
    const out = renderLinuxAppImageAppRun();

    expect(out).toContain('APPIMAGE="$APPDIR/AppRun"');
  });

  linuxOnlyIt("exports APPIMAGE fallback to the execed Electron process", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-linux-apprun-export-"));
    const appDir = join(root, "AppDir");
    const appRunPath = join(appDir, "AppRun");
    const observedEnvPath = join(root, "observed-env.txt");
    const electronPath = join(appDir, "map-design");

    try {
      await mkdir(appDir, { recursive: true });
      await writeFile(appRunPath, renderLinuxAppImageAppRun(), "utf8");
      await chmod(appRunPath, 0o755);
      await writeFile(
        electronPath,
        `#!/bin/bash
{
  printf 'APPIMAGE=%s\\n' "$APPIMAGE"
  printf 'ELECTRON_RUN_AS_NODE=%s\\n' "\${ELECTRON_RUN_AS_NODE-unset}"
} > ${JSON.stringify(observedEnvPath)}
`,
        "utf8",
      );
      await chmod(electronPath, 0o755);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        APPDIR: appDir,
        ELECTRON_RUN_AS_NODE: "1",
      };
      delete env.APPIMAGE;
      const child = spawn(appRunPath, [], { env, stdio: "ignore" });
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });

      expect(exit).toEqual({ code: 0, signal: null });
      expect(await readFile(observedEnvPath, "utf8")).toBe(
        `APPIMAGE=${appRunPath}\nELECTRON_RUN_AS_NODE=unset\n`,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("createLinuxDesktopLaunchEnv", () => {
  it("strips ELECTRON_RUN_AS_NODE before spawning the Electron AppImage", () => {
    const config = makeConfig();
    const stamp = {
      app: "desktop",
      ipc: "/tmp/map-design/ipc/default/desktop.sock",
      mode: "runtime",
      namespace: "default",
      source: "packaged",
    } as const;

    const env = createLinuxDesktopLaunchEnv(config, stamp, {
      ELECTRON_RUN_AS_NODE: "1",
      KEEP_ME: "yes",
    });

    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.KEEP_ME).toBe("yes");
    expect(env.MAP_DESIGN_SIDECAR_BASE).toBe(resolve(config.roots.runtime.namespaceRoot, "runtime"));
  });
});

describe("sanitizeNamespace", () => {
  it("replaces non-alphanumeric chars with hyphens", () => {
    expect(sanitizeNamespace("a/b c")).toBe("a-b-c");
  });
});


describe("inspectPackedLinuxApp", () => {
  it("allows desktop inspect eval and screenshot options", async () => {
    const requestJsonIpcMock = vi.mocked(requestJsonIpc);
    requestJsonIpcMock.mockReset();
    requestJsonIpcMock
      .mockResolvedValueOnce({ state: "running", url: "md://app/" })
      .mockResolvedValueOnce({ ok: true, value: "MapDesign" })
      .mockResolvedValueOnce({ path: "/tmp/map-design-linux.png" });

    const result = await inspectPackedLinuxApp(makeConfig(), {
      expr: "document.title",
      path: "/tmp/map-design-linux.png",
    });


    expect(result).toEqual({
      eval: { ok: true, value: "MapDesign" },
      screenshot: { path: "/tmp/map-design-linux.png" },
      status: { state: "running", url: "md://app/" },
    });
    expect(requestJsonIpcMock).toHaveBeenCalledTimes(3);
  });
});

describe("matchesAppImageProcess", () => {
  const installPath = "/home/u/.local/bin/MapDesign.default.AppImage";

  it("matches FUSE-mode (executable === installPath)", () => {
    const ok = matchesAppImageProcess(
      { pid: 1234, executable: installPath, env: {} },
      installPath,
    );
    expect(ok).toBe(true);
  });

  it("matches extracted-mode (env.APPIMAGE === installPath, executable matches /tmp/.mount_*/AppRun)", () => {
    const ok = matchesAppImageProcess(
      { pid: 1234, executable: "/tmp/.mount_abc123/AppRun", env: { APPIMAGE: installPath } },
      installPath,
    );
    expect(ok).toBe(true);
  });

  it("rejects unrelated processes", () => {
    const ok = matchesAppImageProcess(
      { pid: 9999, executable: "/usr/bin/node", env: {} },
      installPath,
    );
    expect(ok).toBe(false);
  });

  it("rejects extracted-mode with mismatched APPIMAGE env", () => {
    const ok = matchesAppImageProcess(
      { pid: 1234, executable: "/tmp/.mount_abc/AppRun", env: { APPIMAGE: "/other/path.AppImage" } },
      installPath,
    );
    expect(ok).toBe(false);
  });

  it("rejects extracted-mode when APPIMAGE env is missing", () => {
    const ok = matchesAppImageProcess(
      { pid: 1234, executable: "/tmp/.mount_abc123/AppRun", env: {} },
      installPath,
    );
    expect(ok).toBe(false);
  });

  it("matches direct AppRun fallback when APPIMAGE points to the sibling AppRun", () => {
    const ok = matchesAppImageProcess(
      {
        pid: 1234,
        executable: "/tmp/appimage_extracted_fe548e54/map-design",
        env: { APPIMAGE: "/tmp/appimage_extracted_fe548e54/AppRun" },
      },
      installPath,
    );
    expect(ok).toBe(true);
  });

  it("rejects direct AppRun fallback when APPIMAGE points outside the executable directory", () => {
    const ok = matchesAppImageProcess(
      {
        pid: 1234,
        executable: "/tmp/appimage_extracted_fe548e54/map-design",
        env: { APPIMAGE: "/tmp/other/AppRun" },
      },
      installPath,
    );
    expect(ok).toBe(false);
  });

  it("matches --appimage-extract-and-run mode (executable in /tmp/appimage_extracted_*/<binary>)", () => {
    const ok = matchesAppImageProcess(
      {
        pid: 1234,
        executable: "/tmp/appimage_extracted_fe548e54/map-design",
        env: { APPIMAGE: installPath },
      },
      installPath,
    );
    expect(ok).toBe(true);
  });

  it("rejects extract-and-run mode with mismatched APPIMAGE env", () => {
    const ok = matchesAppImageProcess(
      {
        pid: 1234,
        executable: "/tmp/appimage_extracted_fe548e54/map-design",
        env: { APPIMAGE: "/elsewhere/Other.AppImage" },
      },
      installPath,
    );
    expect(ok).toBe(false);
  });
});
describe("Linux lifecycle", () => {
  it("ships only the AppImage desktop runtime", () => {
    expect(linuxCliSource).not.toContain("--headless");
    expect(linuxLifecycleSource).not.toContain("Headless");
    expect(linuxLifecycleSource).not.toContain("headless");
  });
});
