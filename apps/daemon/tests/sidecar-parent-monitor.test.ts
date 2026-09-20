import { describe, expect, it } from "vitest";

import { attachToolsDevParentMonitor } from "../src/sidecar/server.js";

type TimerCallback = () => void;

function monitorHarness(value: string | undefined, alive: boolean) {
  let callback: TimerCallback | undefined;
  let clearCount = 0;
  let closeCount = 0;
  let exitCount = 0;
  let unrefCount = 0;

  attachToolsDevParentMonitor(
    async () => {
      closeCount += 1;
    },
    { MAP_DESIGN_TOOLS_DEV_PARENT_PID: value },
    {
      clearInterval: () => {
        clearCount += 1;
      },
      exit: () => {
        exitCount += 1;
      },
      isAlive: () => alive,
      setInterval: (next) => {
        callback = next;
        return { unref: () => { unrefCount += 1; } };
      },
    },
  );

  return {
    async tick() {
      callback?.();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
    counts: () => ({ clearCount, closeCount, exitCount, unrefCount }),
  };
}

describe("tools-dev daemon parent monitor", () => {
  it("stops and exits exactly once when its parent dies", async () => {
    const monitor = monitorHarness("1234", false);

    await monitor.tick();
    await monitor.tick();

    expect(monitor.counts()).toEqual({ clearCount: 1, closeCount: 1, exitCount: 1, unrefCount: 1 });
  });

  it.each([undefined, "", "0", "-1", "1.5", "1e3", "0x10", "not-a-pid"])(
    "ignores invalid parent pid %j",
    (parentPid) => {
      const monitor = monitorHarness(parentPid, false);

      expect(monitor.counts()).toEqual({ clearCount: 0, closeCount: 0, exitCount: 0, unrefCount: 0 });
    },
  );
});
