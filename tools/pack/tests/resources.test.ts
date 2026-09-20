import { describe, expect, it } from "vitest";
import { linuxResources } from "../src/resources.js";

describe("pack resources", () => {
  it("uses the MapDesign desktop file template", () => {
    expect(linuxResources.desktopTemplate).toMatch(/map-design\.desktop\.template$/);
  });
});
