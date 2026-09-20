import { createHmac, randomBytes } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import type {
  DesktopEvalInput,
  DesktopEvalResult,
  DesktopScreenshotInput,
  DesktopScreenshotResult,
  DesktopStatusSnapshot,
} from "@mapseekai/sidecar-proto";

export interface DesktopRuntime {
  close(): Promise<void>;
  eval(input: DesktopEvalInput): Promise<DesktopEvalResult>;
  screenshot(input: DesktopScreenshotInput): Promise<DesktopScreenshotResult>;
  show(): void;
  status(): DesktopStatusSnapshot;
}

export interface DesktopRuntimeOptions {
  discoverWebUrl(): Promise<string | null>;
  pickerSecret: Buffer;
  preloadPath: string;
  windowTitle?: string;
  splashStartedAt?: number;
  splashWindow?: BrowserWindow | null;
  onRevealed?(): void;
}

const TOKEN_TTL_MS = 60_000;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isMapDesignWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "map-design:" &&
        url.host === "app" &&
        url.pathname === "/" &&
        url.search === "" &&
        url.hash === "" &&
        url.username === "" &&
        url.password === "" &&
        url.port === "") ||
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}

export function signDesktopImportToken(secret: Buffer, path: string, options: { nonce: string; exp: string }): string {
  const signature = createHmac("sha256", secret)
    .update(`${path}\n${options.nonce}\n${options.exp}`)
    .digest("base64url");
  return [options.nonce, options.exp, signature].join("~");
}

async function pickWorkingDirectory(sender: Electron.WebContents, secret: Buffer): Promise<{ ok: true; path: string; token: string } | { ok: false; cancelled?: true; message?: string }> {
  const parent = BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getFocusedWindow();
  const result = parent
    ? await dialog.showOpenDialog(parent, { properties: ["openDirectory", "createDirectory", "dontAddToRecent"] })
    : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory", "dontAddToRecent"] });
  if (result.canceled || result.filePaths.length !== 1) return { ok: false, cancelled: true };
  try {
    const path = await realpath(result.filePaths[0]!);
    if (!(await stat(path)).isDirectory()) return { ok: false, message: "Selected path is not a directory." };
    return {
      ok: true,
      path,
      token: signDesktopImportToken(secret, path, {
        nonce: randomBytes(16).toString("base64url"),
        exp: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      }),
    };
  } catch {
    return { ok: false, message: "Selected directory is unavailable." };
  }
}

export async function createDesktopRuntime(options: DesktopRuntimeOptions): Promise<DesktopRuntime> {
  let currentUrl: string | null = null;
  let closed = false;
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: options.windowTitle ?? "MapDesign",
    autoHideMenuBar: true,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 18 } } : {}),
    webPreferences: {
      preload: options.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const requireMainWindow = (sender: Electron.WebContents): void => {
    if (sender !== window.webContents) throw new Error("Host IPC is only available to the MapDesign window.");
  };
  for (const channel of ["map-design:project:pick-working-directory", "map-design:shell:open-external"]) ipcMain.removeHandler(channel);
  ipcMain.removeAllListeners("map-design:appearance:set-theme");
  ipcMain.handle("map-design:project:pick-working-directory", (event) => {
    requireMainWindow(event.sender);
    return pickWorkingDirectory(event.sender, options.pickerSecret);
  });
  ipcMain.handle("map-design:shell:open-external", async (event, url: unknown): Promise<boolean> => {
    requireMainWindow(event.sender);
    if (typeof url !== "string" || !isHttpUrl(url)) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.on("map-design:appearance:set-theme", (event, theme: unknown) => {
    if (event.sender === window.webContents && (theme === "light" || theme === "dark" || theme === "system")) nativeTheme.themeSource = theme;
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url === currentUrl) return;
    event.preventDefault();
    if (isHttpUrl(url)) void shell.openExternal(url);
  });

  const url = await options.discoverWebUrl();
  if (url == null || !isMapDesignWebUrl(url)) throw new Error("MapDesign web URL is unavailable.");
  await window.loadURL(url);
  currentUrl = url;
  const remainingSplashMs = options.splashStartedAt == null ? 0 : Math.max(0, 2_000 - (Date.now() - options.splashStartedAt));
  if (remainingSplashMs > 0) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, remainingSplashMs);
    await promise;
  }
  window.show();
  window.focus();
  if (options.splashWindow != null && !options.splashWindow.isDestroyed()) options.splashWindow.close();
  options.onRevealed?.();

  return {
    async close() {
      closed = true;
      ipcMain.removeHandler("map-design:project:pick-working-directory");
      ipcMain.removeHandler("map-design:shell:open-external");
      ipcMain.removeAllListeners("map-design:appearance:set-theme");
      if (!window.isDestroyed()) window.destroy();
    },
    async eval(input) {
      if (window.isDestroyed()) throw new Error("desktop window is destroyed");
      return { value: await window.webContents.executeJavaScript(input.expression, true) };
    },
    async screenshot(input) {
      if (window.isDestroyed()) throw new Error("desktop window is destroyed");
      const path = resolve(input.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, (await window.webContents.capturePage()).toPNG());
      return { path };
    },
    show() {
      if (!window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }
    },
    status() {
      return {
        pid: process.pid,
        state: closed || window.isDestroyed() ? "unknown" : "running",
        url: currentUrl,
      };
    },
  };
}
