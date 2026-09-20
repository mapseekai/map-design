import { describe, expect, it } from "vitest";

import { resolveToolPackConfig } from "../src/config.js";

describe("resolveToolPackConfig", () => {
  it("uses one MapDesign installer identity", () => {
    const config = resolveToolPackConfig("linux", { silent: true });

    expect(config.productName).toBe("MapDesign");
    expect(config.executableName).toBe("map-design");
    expect(config.protocol).toBe("map-design");
    expect(config.linuxDesktopFile).toBe("map-design.desktop");
  });

  it("reads the root version by default", () => {
    const config = resolveToolPackConfig("mac", { silent: true });
    expect(config.appVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});
