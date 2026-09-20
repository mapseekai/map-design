import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

const runtime = readFileSync(new URL("../../src/main/runtime.ts", import.meta.url), "utf8");

describe("MapDesign desktop window", () => {
  test("uses a single app window with secure web preferences", () => {
    expect(runtime.match(/new BrowserWindow\(/g)).toHaveLength(1);
    expect(runtime).toContain("sandbox: true");
    expect(runtime).toContain("contextIsolation: true");
    expect(runtime).toContain("nodeIntegration: false");
  });

  test("does not retain export, diagnostics, or managed download window hooks", () => {
    for (const retired of ["session.on(\"will-download\"", "printToPDF", "saveAsDialogOptions"]) {
      expect(runtime).not.toContain(retired);
    }
  });
});
