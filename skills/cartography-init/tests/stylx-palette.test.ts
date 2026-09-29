import { describe, expect, it } from "vitest";
import { parseStylx } from "../src/adapters/arcgis.js";
import { initializeCartography } from "../src/index.js";
import { verifyDocument } from "../src/verify.js";
import { makeStylx } from "./helpers.js";

const red = { type: "CIMRGBColor", values: [233, 0, 45, 100] };
const green = { type: "CIMRGBColor", values: [0, 176, 0, 100] };

describe("STYLX custom categories and palettes", () => {
  it("extracts ordered fixed colors from a custom category and null-terminated content", () => {
    const input = makeStylx([{ name: "Rag Status", category: "OS", content: JSON.stringify({
      type: "CIMFixedColorRamp", colors: [red, green, red], arrangement: "Default",
    }) + "\u0000" }]);
    const ir = parseStylx(input, "OS.stylx");
    expect(ir.colors.map(item => item.value)).toEqual(["#e9002d", "#00b000", "#e9002d"]);
    expect(ir.colors.map(item => item.nameHint)).toEqual(["Rag Status 1", "Rag Status 2", "Rag Status 3"]);
    expect(ir.elements).toEqual([]);
    expect(ir.skipped).toEqual([]);
    const draft = initializeCartography(input, "OS.stylx", "OS");
    expect(verifyDocument(draft.source).ok).toBe(true);
    expect(draft.source).toContain("rag-status-3:");
  });

  it("extracts a color and a symbol by CIM type regardless of category", () => {
    const ir = parseStylx(makeStylx([
      { name: "Red", category: "Custom", content: JSON.stringify(red) },
      { name: "Road", category: "OS Transport", content: JSON.stringify({ type: "CIMLineSymbol",
        symbolLayers: [{ type: "CIMSolidStroke", color: red, width: 2 }],
      }) },
    ]), "custom.stylx");
    expect(ir.colors.map(item => item.value)).toEqual(["#e9002d", "#e9002d"]);
    expect(ir.elements[0]?.style.strokeWidth).toEqual({ value: 2, unit: "pt" });
    expect(ir.skipped).toEqual([]);
  });

  it("reports unsupported ramp colors without losing supported neighbors", () => {
    const ir = parseStylx(makeStylx([{ name: "Palette", category: "OS", content: JSON.stringify({
      type: "CIMFixedColorRamp", colors: [red, { type: "UnsupportedColor" }, green],
    }) }]), "partial.stylx");
    expect(ir.colors.map(item => item.value)).toEqual(["#e9002d", "#00b000"]);
    expect(ir.colors[1]?.nameHint).toBe("Palette 3");
    expect(ir.skipped).toHaveLength(1);
  });

  it("still rejects malformed JSON inside an item", () => {
    const ir = parseStylx(makeStylx([{ name: "Broken", category: "OS", content: "{\u0000}" }]), "broken.stylx");
    expect(ir.skipped).toContainEqual(expect.objectContaining({ reason: "Invalid .stylx item JSON" }));
  });
});
