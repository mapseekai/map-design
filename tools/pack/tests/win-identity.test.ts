import { describe, expect, it } from "vitest";
import { resolveWinInstallIdentity } from "../src/win/identity.js";

describe("resolveWinInstallIdentity", () => {
  it("uses the single MapDesign identity", () => {
    expect(resolveWinInstallIdentity({ namespace: "test" })).toMatchObject({
      displayName: "MapDesign",
      exeName: "map-design.exe",
      shortcutName: "MapDesign.lnk",
    });
  });
});
