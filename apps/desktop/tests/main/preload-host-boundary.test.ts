import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { describe, expect, it, vi } from "vitest";

describe("desktop preload MapDesign host boundary", () => {
  it("updates the macOS titlebar inset from native fullscreen changes", () => {
    const source = readFileSync(new URL("../../src/main/preload.cts", import.meta.url), "utf8");
    const ipcRenderer = { on: vi.fn() };
    const setProperty = vi.fn();
    const compiled = transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText;
    new Function("require", "process", "exports", "module", "document", compiled)(
      () => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer }),
      { platform: "darwin" }, {}, { exports: {} },
      { documentElement: { style: { setProperty } } },
    );
    expect(ipcRenderer.on).toHaveBeenCalledExactlyOnceWith("map-design:window:fullscreen", expect.any(Function));
    const onFullscreen = ipcRenderer.on.mock.calls[0]![1] as (event: unknown, fullscreen: unknown) => void;
    onFullscreen({}, false);
    onFullscreen({}, true);
    onFullscreen({}, false);
    onFullscreen({}, "true");
    expect(setProperty.mock.calls).toEqual([
      ["--app-titlebar-inset-left", "88px"],
      ["--app-titlebar-inset-left", "12px"],
      ["--app-titlebar-inset-left", "88px"],
    ]);
  });

  it("exposes only the frozen version-one MapDesign bridge through Electron", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../../src/main/preload.cts"), "utf8");
    const exposedGlobals = Array.from(source.matchAll(/contextBridge\.exposeInMainWorld\(([^,\n]+)/g))
      .map((match) => match[1]?.trim());
    const runtimeRequires = Array.from(source.matchAll(/require\((['"][^'"]+['"])\)/g))
      .map((match) => match[1]);

    expect(exposedGlobals).toEqual(["MAP_DESIGN_HOST_GLOBAL"]);
    expect(runtimeRequires).toEqual(["'electron'"]);
    expect(source).toContain("satisfies MapDesignHostBridge");
    expect(source).toContain("Object.freeze");
    expect(source).toContain("'map-design:appearance:set-theme'");
    expect(source).toContain("'map-design:project:pick-working-directory'");
    expect(source).toContain("'map-design:shell:open-external'");
    expect(source).toContain("ipcRenderer.invoke('map-design:shell:open-external', url)");
    expect(source).toContain("const path = candidate.path.trim()");
    expect(source).toContain("const token = candidate.token.trim()");
    expect(source).toContain("path.length > 0 && path.length <= 4_096");
    expect(source).toContain("token.length >= 16 && token.length <= 4_096");
    expect(source).not.toContain("@mapseekai/host");
    expect(source).not.toContain("browser");
    expect(source).not.toContain("capture");
    expect(source).not.toContain("pdf");
    expect(source).not.toContain("pickAndImport");
    expect(source).not.toContain("pickAndReplaceWorkingDir");
    expect(source).not.toContain("openPath");
    expect(source).not.toContain("exportDiagnostics");
  });

  it("normalizes selected picker IPC values and rejects malformed successes", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../../src/main/preload.cts"), "utf8");
    const responses = [
      { ok: true, path: " /tmp/map ", token: " trusted-picker-123 " },
      { ok: true, path: "   ", token: "trusted-picker-123" },
      { ok: true, path: "/tmp/map", token: "too-short" },
      { ok: true, path: "x".repeat(4_097), token: "trusted-picker-123" },
      { ok: true, path: "/tmp/map", token: "x".repeat(4_097) },
    ];
    const exposeInMainWorld = vi.fn();
    const ipcRenderer = {
      invoke: vi.fn(() => Promise.resolve(responses.shift())),
      send: vi.fn(),
    };
    const compiled = transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText;
    new Function("require", "process", "exports", "module", compiled)(
      (id: string) => id === "electron" ? { contextBridge: { exposeInMainWorld }, ipcRenderer } : undefined,
      { platform: "linux" },
      {},
      { exports: {} },
    );
    const bridge = exposeInMainWorld.mock.calls[0]?.[1] as {
      project: { pickWorkingDirectory(): Promise<unknown> };
    };

    await expect(bridge.project.pickWorkingDirectory()).resolves.toEqual({
      ok: true, path: "/tmp/map", token: "trusted-picker-123",
    });
    for (let index = 0; index < 4; index += 1) {
      await expect(bridge.project.pickWorkingDirectory()).resolves.toEqual({
        ok: false, message: "Unable to choose a working directory.",
      });
    }
  });
});
