import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasGuardedWorkspaceUnitCommands } from "../../../scripts/check-packaged-leaf-boundary.ts";
import { evaluateScopeOutputs } from "../../../scripts/scopes.ts";

const workflow = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("guarded workspace unit commands", () => {
  it.each(["\n", "\r\n"])("accepts the required commands with %j line endings", (lineEnding) => {
    const checkedWorkflow = workflow.replace(/\n/g, lineEnding);

    expect(hasGuardedWorkspaceUnitCommands(checkedWorkflow)).toBe(true);
  });

  it("rejects a workflow missing a required packaged test command", () => {
    const checkedWorkflow = workflow.replace(/pnpm --filter @mapseekai\/packaged test/, "echo skipped");

    expect(hasGuardedWorkspaceUnitCommands(checkedWorkflow)).toBe(false);
  });

  it("rejects a workflow missing the Electron protocol scenario", () => {
    const checkedWorkflow = workflow.replace(/^.*xvfb-run.*packaged-protocol\.test\.ts.*$/m, "");

    expect(hasGuardedWorkspaceUnitCommands(checkedWorkflow)).toBe(false);
  });

  it.each(["e2e/lib/playwright/packaged-protocol.ts", "e2e/ui/packaged-protocol.test.ts"])(
    "arms packaged validation for %s",
    (filePath) => {
      const evaluation = evaluateScopeOutputs([filePath], "medium", { deriveWorkspaceValidationFromTestScopes: true });

      expect(evaluation.outputs.tools_pack_tests_required).toBe(true);
    },
  );
});
