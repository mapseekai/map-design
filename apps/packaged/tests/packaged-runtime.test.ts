import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bootstrapSidecarRuntime: vi.fn(() => ({ namespace: "map-design", ipc: "/tmp/map-design.sock", source: "packaged" })),
  createSidecarLaunchEnv: vi.fn(() => ({})),
  registerMapDesignProtocol: vi.fn(),
  resolveAppIpcPath: vi.fn(() => "/tmp/map-design.sock"),
  readPackagedConfig: vi.fn(),
  resolvePackagedNamespacePaths: vi.fn(),
  applyPackagedElectronPathOverrides: vi.fn(),
  ensurePackagedNamespacePaths: vi.fn(),
  startPackagedSidecars: vi.fn(),
  runDesktopMain: vi.fn(),
}));

vi.mock("@mapseekai/sidecar", () => ({
  bootstrapSidecarRuntime: mocks.bootstrapSidecarRuntime,
  createSidecarLaunchEnv: mocks.createSidecarLaunchEnv,
  resolveAppIpcPath: mocks.resolveAppIpcPath,
}));
vi.mock("electron", () => ({
  app: {
    exit: vi.fn(),
    getAppPath: () => "/resources/app",
    requestSingleInstanceLock: () => true,
    getVersion: () => "1.2.3",
  },
}));
vi.mock("@mapseekai/desktop/main", () => ({ runDesktopMain: mocks.runDesktopMain }));
vi.mock("../src/config.js", () => ({ readPackagedConfig: mocks.readPackagedConfig }));
vi.mock("../src/launch.js", () => ({
  applyPackagedElectronPathOverrides: mocks.applyPackagedElectronPathOverrides,
  ensurePackagedNamespacePaths: mocks.ensurePackagedNamespacePaths,
}));
vi.mock("../src/paths.js", () => ({ resolvePackagedNamespacePaths: mocks.resolvePackagedNamespacePaths }));
vi.mock("../src/protocol.js", () => ({
  packagedEntryUrl: () => "map-design://app/",
  registerMapDesignProtocol: mocks.registerMapDesignProtocol,
}));
vi.mock("../src/sidecars.js", () => ({ startPackagedSidecars: mocks.startPackagedSidecars }));

describe("startMapDesignPackagedRuntime", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.readPackagedConfig.mockResolvedValue({
      appVersion: "1.2.3",
      daemonCliEntry: "/resources/daemon-cli.mjs",
      daemonSidecarEntry: "/resources/daemon-sidecar.mjs",
      namespace: "ignored-config-namespace",
      namespaceBaseRoot: "/data",
      nodeCommand: "/resources/node",
      resourceRoot: "/resources/map-design",
      webOutputMode: "server",
      webSidecarEntry: "/resources/web-sidecar.mjs",
      webStandaloneRoot: null,
    });
    mocks.resolvePackagedNamespacePaths.mockReturnValue({
      dataRoot: "/data/map-design/data",
      resourceRoot: "/resources/map-design",
      runtimeRoot: "/data/map-design/runtime",
    });
    mocks.startPackagedSidecars.mockResolvedValue({
      currentWebUrl: () => "http://127.0.0.1:4200",
      close: vi.fn(),
    });
    mocks.runDesktopMain.mockResolvedValue({ shutdown: vi.fn() });
  });

  it("resolves the namespace data root before launching daemon, web, and desktop", async () => {
    const { startMapDesignPackagedRuntime } = await import("../src/index.js");

    await startMapDesignPackagedRuntime({
      appVersion: "1.2.3",
      namespace: "map-design",
      resourcesPath: "/resources",
    });

    expect(mocks.resolvePackagedNamespacePaths).toHaveBeenCalledBefore(mocks.startPackagedSidecars);
    expect(mocks.startPackagedSidecars).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dataRoot: "/data/map-design/data" }),
      expect.objectContaining({ appVersion: "1.2.3", requireDesktopAuth: true }),
    );
    expect(mocks.registerMapDesignProtocol).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.runDesktopMain).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ windowTitle: "MapDesign" }),
    );
  });

  it("stops desktop sidecars and the runtime tree", async () => {
    const close = vi.fn();
    mocks.startPackagedSidecars.mockResolvedValueOnce({
      daemon: { url: "http://127.0.0.1:4100" },
      currentWebUrl: () => "http://127.0.0.1:4200",
      close,
    });
    const { startMapDesignPackagedRuntime } = await import("../src/index.js");

    const runtime = await startMapDesignPackagedRuntime({ appVersion: "1.2.3", namespace: "map-design", resourcesPath: "/resources" });
    await runtime.stop();

    expect(close).toHaveBeenCalledOnce();
  });

  it("shares a rejected sidecar close across concurrent public stops after desktop shutdown", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockRejectedValue(new Error("sidecar close failed"));
    mocks.startPackagedSidecars.mockResolvedValueOnce({
      daemon: { url: "http://127.0.0.1:4100" },
      currentWebUrl: () => "http://127.0.0.1:4200",
      close,
    });
    mocks.runDesktopMain.mockResolvedValueOnce({ shutdown });
    const { startMapDesignPackagedRuntime } = await import("../src/index.js");

    const runtime = await startMapDesignPackagedRuntime({ appVersion: "1.2.3", namespace: "map-design", resourcesPath: "/resources" });
    await expect(Promise.all([runtime.stop(), runtime.stop()])).rejects.toThrow("sidecar close failed");

    expect(shutdown).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
