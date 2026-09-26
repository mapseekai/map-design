import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, test, vi } from "vitest";

const runtime = readFileSync(new URL("../../src/main/runtime.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../../src/main/index.ts", import.meta.url), "utf8");

const mocks = vi.hoisted(() => ({
  app: {
    commandLine: { appendSwitch: vi.fn() },
    dock: { setIcon: vi.fn() },
    getPath: vi.fn(() => "/tmp"),
    getPreferredSystemLanguages: vi.fn(() => ["en"]),
    getVersion: vi.fn(() => "1.2.3"),
    isPackaged: false,
    isReady: vi.fn(() => false),
    on: vi.fn(),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(async () => undefined),
  },
  createDesktopRuntime: vi.fn(),
  createJsonIpcServer: vi.fn(),
  attachDesktopProcessErrorFilter: vi.fn(),
  beginDesktopSession: vi.fn(),
  endDesktopSessionCleanly: vi.fn(),
  markDesktopSessionRunning: vi.fn(),
  normalizeMapDesignSidecarMessage: vi.fn(),
  requestJsonIpc: vi.fn(),
  resolveAppIpcPath: vi.fn(() => "/tmp/daemon.sock"),
}));

vi.mock("electron", () => ({ app: mocks.app }));
vi.mock("@mapseekai/sidecar", () => ({
  bootstrapSidecarRuntime: vi.fn(),
  createJsonIpcServer: mocks.createJsonIpcServer,
  requestJsonIpc: mocks.requestJsonIpc,
  resolveAppIpcPath: mocks.resolveAppIpcPath,
}));
vi.mock("@mapseekai/sidecar-proto", () => ({
  MAP_DESIGN_SIDECAR_CONTRACT: "map-design",
  MAP_DESIGN_SIDECAR_MESSAGES: { EVAL: "eval", SCREENSHOT: "screenshot", SHOW: "show", SHUTDOWN: "shutdown", STATUS: "status" },
  normalizeMapDesignSidecarMessage: mocks.normalizeMapDesignSidecarMessage,
}));
vi.mock("@mapseekai/platform", () => ({ readProcessStamp: vi.fn() }));
vi.mock("../../src/main/runtime.js", () => ({ createDesktopRuntime: mocks.createDesktopRuntime }));
vi.mock("../../src/main/session-lifecycle.js", () => ({
  beginDesktopSession: mocks.beginDesktopSession,
  endDesktopSessionCleanly: mocks.endDesktopSessionCleanly,
  markDesktopSessionRunning: mocks.markDesktopSessionRunning,
}));
vi.mock("../../src/main/uncaught-exception.js", () => ({ attachDesktopProcessErrorFilter: mocks.attachDesktopProcessErrorFilter }));

describe("MapDesign desktop runtime", () => {
  test("creates one sandboxed BrowserWindow that loads the discovered web URL", () => {
    expect(runtime.match(/new BrowserWindow\(/g)).toHaveLength(1);
    expect(runtime).toContain("contextIsolation: true");
    expect(runtime).toContain("nodeIntegration: false");
    expect(runtime).toContain("await window.loadURL(url);");
  });

  test("keeps external HTTP navigation outside the renderer", () => {
    expect(runtime).toContain('window.webContents.on("will-navigate"');
    expect(runtime).toContain("await shell.openExternal(url);");
    expect(runtime).toContain("window.webContents.setWindowOpenHandler");
  });

  test("accepts only the packaged entry or HTTP(S) web URLs", () => {
    expect(runtime).toContain('url.protocol === "map-design:"');
    expect(runtime).toContain('url.host === "app"');
    expect(runtime).toContain('url.pathname === "/"');
    expect(runtime).toContain('url.search === ""');
    expect(runtime).toContain('url.protocol === "http:" ||');
    expect(runtime).toContain("if (url == null || !isMapDesignWebUrl(url))");
  });

  test("registers only the narrow host bridge handlers", () => {
    expect(runtime.match(/ipcMain\.handle\(/g)).toHaveLength(2);
    expect(runtime.match(/ipcMain\.on\(/g)).toHaveLength(1);
    expect(runtime).toContain('"map-design:project:pick-working-directory"');
    expect(runtime).toContain('"map-design:shell:open-external"');
    expect(runtime).toContain('"map-design:appearance:set-theme"');
    for (const retired of ["dialog:pick-and-import", "shell:open-path", "browser:clear-data", "export-pdf", "render-slides"]) {
      expect(runtime).not.toContain(retired);
    }
  });

  test("mints the daemon-compatible canonical working-directory HMAC token", () => {
    expect(runtime).toContain("`${path}\\n${options.nonce}\\n${options.exp}`");
    expect(runtime).toContain('return [options.nonce, options.exp, signature].join("~");');
  });

  test("retains tools-dev status, screenshot, and eval inspection", () => {
    for (const message of ["MAP_DESIGN_SIDECAR_MESSAGES.STATUS", "MAP_DESIGN_SIDECAR_MESSAGES.EVAL", "MAP_DESIGN_SIDECAR_MESSAGES.SCREENSHOT"]) {
      expect(main).toContain(message);
    }
  });
});

type BeforeQuitEvent = { preventDefault(): void };
type BeforeQuitListener = (event: BeforeQuitEvent) => void;

describe("desktop shutdown", () => {
  let finalPreventDefault = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    finalPreventDefault = vi.fn();
    const listeners = new Map<string, BeforeQuitListener>();
    mocks.app.on.mockImplementation((event: string, listener: BeforeQuitListener) => listeners.set(event, listener));
    mocks.app.quit.mockImplementation(() => listeners.get("before-quit")?.({ preventDefault: finalPreventDefault }));
    mocks.createJsonIpcServer.mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) });
    mocks.createDesktopRuntime.mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      eval: vi.fn(),
      screenshot: vi.fn(),
      show: vi.fn(),
      status: vi.fn(),
    });
    mocks.requestJsonIpc.mockResolvedValue({ accepted: true });
  });

  test.each([false, true])("allows startup and cleanup-triggered quit (packaged=%s)", async (isPackaged) => {
    mocks.app.isPackaged = isPackaged;
    const { runDesktopMain } = await import("../../src/main/index.js");
    const desktop = await runDesktopMain(
      { ipc: "/tmp/desktop.sock", namespace: "map-design", source: "packaged" } as never,
      {
        discoverDaemonUrl: async () => null,
        discoverWebUrl: async () => "map-design://app/",
        preloadPath: "/resources/preload.cjs",
      },
    );
    if (process.platform === "darwin" && !isPackaged) {
      expect(mocks.app.dock.setIcon).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("/desktop/resources/dock-icon.png"));
      expect(mocks.app.dock.setIcon.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.app.whenReady.mock.invocationCallOrder[0]!);
    } else expect(mocks.app.dock.setIcon).not.toHaveBeenCalled();
    const beforeQuit = mocks.app.on.mock.calls.find(([event]) => event === "before-quit")?.[1] as BeforeQuitListener;
    const initialPreventDefault = vi.fn();

    beforeQuit({ preventDefault: initialPreventDefault });
    await desktop?.shutdown();

    expect(initialPreventDefault).toHaveBeenCalledOnce();
    expect(finalPreventDefault).not.toHaveBeenCalled();
  });
});
