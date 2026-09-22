import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectResidualJavaScript } from "../../../scripts/guard.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("residual JavaScript in the working tree", () => {
  it("ignores removed tracked files while retaining existing violations", () => {
    const root = mkdtempSync(path.join(tmpdir(), "map-design-residual-"));
    roots.push(root);
    execFileSync("git", ["init", "--quiet", root]);
    for (const name of ["removed.mjs", "existing.mjs"]) {
      writeFileSync(path.join(root, name), "export {};\n");
    }
    execFileSync("git", ["add", "--", "removed.mjs", "existing.mjs"], { cwd: root });

    unlinkSync(path.join(root, "removed.mjs"));

    expect(collectResidualJavaScript(root)).toEqual(["existing.mjs"]);
  });
});
