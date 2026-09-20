import { describe, expect, it } from "vitest";
import { resolveMacInstallIdentity } from "../src/mac/identity.js";

describe("resolveMacInstallIdentity", () => {
  it("uses the single MapDesign identity", () => {
    expect(resolveMacInstallIdentity({ namespace: "test" })).toMatchObject({
      appId: "io.map-design.desktop",
      executableName: "map-design",
      productName: "MapDesign",
      publicAppBundleName: "MapDesign.app",
    });
  });
});
