import { describe, expect, it } from "vitest";
import { initializeCartography } from "../src/index.js";
import { verifyDocument } from "../src/verify.js";
import { loadFixture } from "./helpers.js";

const samples = [
  { file: "OSM Simple Light.lyrx", elements: 38, colors: 44, skipped: 0,
    evidence: ["#c2eaff", "#cbe7cb"] },
  { file: "style-example.sld", elements: 3, colors: 9, skipped: 3,
    evidence: ["#87CEEB", "#FFFACD", "#F08080"] },
  { file: "OS GeoDataViz Colours & Symbols (ArcPro)_v2.stylx", elements: 0, colors: 125, skipped: 0,
    evidence: ["rag-status-1:", "rag-status-cvd-3:", "#e9002d"] },
  { file: "style-v8.json", elements: 48, colors: 55, skipped: 46,
    evidence: ["hsl(47, 26%, 88%)", "hsl(205, 56%, 73%)"] },
] as const;

describe("user-supplied import samples", () => {
  it.each(samples)("converts $file into a valid draft with source evidence", sample => {
    const result = initializeCartography(loadFixture(`import-samples/${sample.file}`), sample.file, sample.file);
    expect(verifyDocument(result.source).ok).toBe(true);
    expect(Buffer.byteLength(result.source)).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.parse(result.reportJson)).toMatchObject({
      statistics: { elements: sample.elements, colors: sample.colors, skipped: sample.skipped },
    });
    for (const evidence of sample.evidence) expect(result.source).toContain(evidence);
    if (sample.file.endsWith(".sld")) {
      expect(result.reportMarkdown).toContain("Categorize");
      expect(result.reportMarkdown).toContain("TextSymbolizer");
    }
    if (sample.file === "style-v8.json") {
      expect(result.reportJson).toContain("stops");
      expect(result.reportMarkdown).toContain("line-width");
    }
  });
});
