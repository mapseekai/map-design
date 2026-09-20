export const MAP_DESIGN_APPS = ["daemon", "desktop", "web"] as const;
export type MapDesignApp = (typeof MAP_DESIGN_APPS)[number];
export const MAP_DESIGN_MODES = ["dev", "runtime"] as const;
export type MapDesignMode = (typeof MAP_DESIGN_MODES)[number];
export const MAP_DESIGN_SOURCES = ["dev", "packaged"] as const;
export type MapDesignSource = (typeof MAP_DESIGN_SOURCES)[number];

export const MAP_DESIGN_SIDECAR_ENV = Object.freeze({
  BASE: "MAP_DESIGN_SIDECAR_BASE",
  IPC_PATH: "MAP_DESIGN_IPC_PATH",
  NAMESPACE: "MAP_DESIGN_NAMESPACE",
  SOURCE: "MAP_DESIGN_SOURCE",
} as const);
export const MAP_DESIGN_STAMP_FLAGS = Object.freeze({
  app: "--map-design-stamp-app",
  ipc: "--map-design-stamp-ipc",
  mode: "--map-design-stamp-mode",
  namespace: "--map-design-stamp-namespace",
  source: "--map-design-stamp-source",
} as const);
export const MAP_DESIGN_STAMP_FIELDS = ["app", "mode", "namespace", "ipc", "source"] as const;
export const MAP_DESIGN_SIDECAR_SOURCES = Object.freeze({ DEV: "dev", PACKAGED: "packaged" } as const);
export const MAP_DESIGN_SIDECAR_MESSAGES = Object.freeze({
  EVAL: "eval", SCREENSHOT: "screenshot", SHOW: "show", SHUTDOWN: "shutdown", STATUS: "status",
} as const);
export const MAP_DESIGN_SIDECAR_DEFAULTS = Object.freeze({ ipcBase: "/tmp/map-design/ipc", namespace: "default", projectTmpDirName: ".tmp/map-design" } as const);

export type MapDesignStamp = { app: MapDesignApp; mode: MapDesignMode; namespace: string; ipc: string; source: MapDesignSource };
export type MapDesignStampCriteria = Partial<MapDesignStamp>;
export type ServiceRuntimeState = "idle" | "running" | "starting" | "stopped" | "unknown";
export type DaemonStatusSnapshot = { pid?: number | null; state: ServiceRuntimeState; url: string | null };
export type WebStatusSnapshot = { pid?: number | null; state: ServiceRuntimeState; url: string | null };
export type DesktopStatusSnapshot = { pid?: number | null; state: ServiceRuntimeState; url: string | null };
export type DesktopEvalInput = { expression: string };
export type DesktopEvalResult = { value: unknown };
export type DesktopScreenshotInput = { path: string };
export type DesktopScreenshotResult = { path: string };
export type ShutdownResult = { accepted: true };
export type MapDesignSidecarMessage =
  | { type: "status" | "shutdown" }
  | { type: "show"; input?: { deeplinkUrl?: string } }
  | { type: "eval"; input: DesktopEvalInput }
  | { type: "screenshot"; input: DesktopScreenshotInput };

function object(value: unknown, label: string): Record<string, unknown> { if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function string(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0 || value !== value.trim()) throw new Error(`${label} must be a non-empty unpadded string`); return value; }
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void { const invalid = Object.keys(value).filter((key) => !allowed.includes(key)); if (invalid.length) throw new Error(`${label} contains unsupported fields: ${invalid.join(", ")}`); }
export function normalizeNamespace(value: unknown): string { const namespace = string(value, "namespace"); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(namespace)) throw new Error(`namespace contains unsupported characters: ${namespace}`); return namespace; }
export function normalizeMapDesignApp(value: unknown): MapDesignApp { if (!(MAP_DESIGN_APPS as readonly unknown[]).includes(value)) throw new Error(`unsupported MapDesign app: ${String(value)}`); return value as MapDesignApp; }
export function normalizeMapDesignMode(value: unknown): MapDesignMode { if (!(MAP_DESIGN_MODES as readonly unknown[]).includes(value)) throw new Error("MapDesign mode must be dev or runtime"); return value as MapDesignMode; }
export function normalizeMapDesignSource(value: unknown): MapDesignSource { if (!(MAP_DESIGN_SOURCES as readonly unknown[]).includes(value)) throw new Error(`unsupported MapDesign source: ${String(value)}`); return value as MapDesignSource; }
export function isWindowsNamedPipePath(value: unknown): boolean { return typeof value === "string" && value.startsWith("\\\\.\\pipe\\"); }
export function normalizeIpcPath(value: unknown): string { if (typeof value !== "string") throw new Error("sidecar ipc path must be a string"); if (value.length === 0) throw new Error("sidecar ipc path must not be empty"); if (value !== value.trim()) throw new Error("sidecar ipc path must not contain leading or trailing whitespace"); if (value.includes("\0")) throw new Error("sidecar ipc path must not contain null bytes"); if (!isWindowsNamedPipePath(value) && !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)) throw new Error(`sidecar ipc path must be absolute: ${value}`); return value; }
export function normalizeMapDesignStamp(input: unknown): MapDesignStamp { const value = object(input, "MapDesign stamp"); keys(value, MAP_DESIGN_STAMP_FIELDS, "MapDesign stamp"); return { app: normalizeMapDesignApp(value.app), mode: normalizeMapDesignMode(value.mode), namespace: normalizeNamespace(value.namespace), ipc: normalizeIpcPath(value.ipc), source: normalizeMapDesignSource(value.source) }; }
export function normalizeMapDesignStampCriteria(input: unknown = {}): MapDesignStampCriteria { const value = object(input, "MapDesign stamp criteria"); keys(value, MAP_DESIGN_STAMP_FIELDS, "MapDesign stamp criteria"); return { ...(value.app == null ? {} : { app: normalizeMapDesignApp(value.app) }), ...(value.mode == null ? {} : { mode: normalizeMapDesignMode(value.mode) }), ...(value.namespace == null ? {} : { namespace: normalizeNamespace(value.namespace) }), ...(value.ipc == null ? {} : { ipc: normalizeIpcPath(value.ipc) }), ...(value.source == null ? {} : { source: normalizeMapDesignSource(value.source) }) }; }
export function normalizeMapDesignSidecarMessage(input: unknown): MapDesignSidecarMessage { const value = object(input, "MapDesign sidecar message"); const type = string(value.type, "MapDesign sidecar message type"); if (type === "status" || type === "shutdown") { keys(value, ["type"], "MapDesign sidecar message"); return { type }; } if (type === "show") { keys(value, ["input", "type"], "MapDesign sidecar message"); if (value.input == null) return { type }; const input = object(value.input, "show input"); keys(input, ["deeplinkUrl"], "show input"); const deeplinkUrl = input.deeplinkUrl == null ? undefined : string(input.deeplinkUrl, "show deeplinkUrl"); if (deeplinkUrl != null && !deeplinkUrl.startsWith("map-design://")) throw new Error("show deeplinkUrl must use the map-design scheme"); return { type, ...(deeplinkUrl == null ? {} : { input: { deeplinkUrl } }) }; } if (type === "eval") { keys(value, ["input", "type"], "MapDesign sidecar message"); const input = object(value.input, "eval input"); keys(input, ["expression"], "eval input"); return { type, input: { expression: string(input.expression, "eval expression") } }; } if (type === "screenshot") { keys(value, ["input", "type"], "MapDesign sidecar message"); const input = object(value.input, "screenshot input"); keys(input, ["path"], "screenshot input"); return { type, input: { path: normalizeIpcPath(input.path) } }; } throw new Error(`unknown MapDesign sidecar message: ${type}`); }
export const MAP_DESIGN_SIDECAR_CONTRACT = Object.freeze({ apps: MAP_DESIGN_APPS, defaults: MAP_DESIGN_SIDECAR_DEFAULTS, env: MAP_DESIGN_SIDECAR_ENV, messages: MAP_DESIGN_SIDECAR_MESSAGES, normalizeApp: normalizeMapDesignApp, normalizeNamespace, normalizeSource: normalizeMapDesignSource, normalizeStamp: normalizeMapDesignStamp, normalizeStampCriteria: normalizeMapDesignStampCriteria, stampFields: MAP_DESIGN_STAMP_FIELDS, stampFlags: MAP_DESIGN_STAMP_FLAGS });
