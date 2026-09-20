import { describe, expect, test } from "vitest";

import { beginDesktopSession, endDesktopSessionCleanly, markDesktopSessionRunning } from "../../src/main/session-lifecycle.js";

function store() {
  let value = "";
  return {
    readFile: () => value,
    writeFile: (_path: string, data: string) => { value = data; },
    state: () => JSON.parse(value) as { clean: boolean; reachedRunning: boolean },
  };
}

describe("desktop session lifecycle", () => {
  test("records a running session as unclean until graceful shutdown", () => {
    const state = store();
    expect(beginDesktopSession({ stateFilePath: "session.json", sessionId: "one", version: "1", now: () => new Date("2026-01-01"), ...state }).previousUnclean).toBe(false);
    markDesktopSessionRunning({ stateFilePath: "session.json", ...state });
    expect(beginDesktopSession({ stateFilePath: "session.json", sessionId: "two", version: "1", now: () => new Date("2026-01-02"), ...state }).previousUnclean).toBe(true);
    endDesktopSessionCleanly({ stateFilePath: "session.json", ...state });
    expect(state.state()).toMatchObject({ clean: true });
  });
});
