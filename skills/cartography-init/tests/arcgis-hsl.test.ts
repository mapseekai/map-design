import { describe, expect, it } from "vitest";
import { cimColorToCss } from "../src/adapters/cim.js";
import { initializeCartography } from "../src/index.js";
import { lintCartography } from "@mapseekai/cartography.md";

describe("ArcGIS HSL colors", () => {
  it.each([
    [[0, 100, 50, 100], "#ff0000"],
    [[120, 100, 50, 100], "#00ff00"],
    [[240, 100, 50, 100], "#0000ff"],
    [[360, 100, 50, 100], "#ff0000"],
    [[0, 0, 90, 100], "#e6e6e6"],
    [[0, 100, 0, 100], "#000000"],
    [[0, 100, 100, 100], "#ffffff"],
    [[0, 1, 50, 100], "#817e7e"],
    [[0, 100, 1, 100], "#050000"],
    [[200.26, 100, 88, 100], "#c2eaff"],
    [[120, 36.17, 85, 100], "#cbe7cb"],
  ])("converts %j to %s", (values, expected) => {
    expect(cimColorToCss({ type: "CIMHSLColor", values })).toBe(expected);
  });

  it("imports HSL-only polygon symbols without emitting empty elements", () => {
    const content = Buffer.from(JSON.stringify({
      type: "CIMLayerDocument",
      layerDefinitions: [{ name: "Lakes", renderer: {
        type: "CIMSimpleRenderer", symbol: { symbol: {
          type: "CIMPolygonSymbol", symbolLayers: [{
            type: "CIMSolidFill", color: { type: "CIMHSLColor", values: [200.26, 100, 88, 100] },
          }],
        } },
      } }],
    }));
    const draft = initializeCartography(content, "hsl.lyrx", "OSM Light");
    expect(lintCartography(draft.source).valid).toBe(true);
    expect(draft.source).toContain("#c2eaff");
    expect(draft.source).toContain("fillColor:");
  });
});
