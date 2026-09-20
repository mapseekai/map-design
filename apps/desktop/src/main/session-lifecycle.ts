import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DesktopSessionState {
  clean: boolean;
  reachedRunning: boolean;
  sessionId: string;
  startedAt: string;
  version: string;
}

export interface BeginDesktopSessionDeps {
  stateFilePath: string;
  sessionId: string;
  version: string;
  now?(): Date;
  readFile?(path: string): string;
  writeFile?(path: string, data: string): void;
}

function writeState(path: string, state: DesktopSessionState, writeFile: (path: string, data: string) => void): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFile(path, JSON.stringify(state));
}

export function beginDesktopSession(deps: BeginDesktopSessionDeps): { previousUnclean: boolean } {
  const readFile = deps.readFile ?? ((path) => readFileSync(path, "utf8"));
  const writeFile = deps.writeFile ?? ((path, data) => writeFileSync(path, data, "utf8"));
  let previousUnclean = false;
  try {
    const previous = JSON.parse(readFile(deps.stateFilePath)) as Partial<DesktopSessionState>;
    previousUnclean = previous.clean === false && previous.reachedRunning === true;
  } catch {}
  writeState(deps.stateFilePath, { clean: false, reachedRunning: false, sessionId: deps.sessionId, startedAt: (deps.now ?? (() => new Date()))().toISOString(), version: deps.version }, writeFile);
  return { previousUnclean };
}

function updateSession(path: string, patch: Partial<DesktopSessionState>, readFile: ((path: string) => string) | undefined, writeFile: ((path: string, data: string) => void) | undefined): void {
  const read = readFile ?? ((filePath) => readFileSync(filePath, "utf8"));
  const write = writeFile ?? ((filePath, data) => writeFileSync(filePath, data, "utf8"));
  try {
    writeState(path, { ...(JSON.parse(read(path)) as DesktopSessionState), ...patch }, write);
  } catch {}
}

export function markDesktopSessionRunning(deps: { stateFilePath: string; readFile?: (path: string) => string; writeFile?: (path: string, data: string) => void }): void {
  updateSession(deps.stateFilePath, { reachedRunning: true }, deps.readFile, deps.writeFile);
}

export function endDesktopSessionCleanly(deps: { stateFilePath: string; readFile?: (path: string) => string; writeFile?: (path: string, data: string) => void }): void {
  updateSession(deps.stateFilePath, { clean: true }, deps.readFile, deps.writeFile);
}
