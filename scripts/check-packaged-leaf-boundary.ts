import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

import {
  CERTAIN_PACKAGED_LEAF_PREFIXES,
  evaluateScopeOutputs,
  SCOPE_EFFECTS,
} from "./scopes.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const checkedRoots = ["apps", "packages", "tools", "e2e"] as const;
const checkedExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const skippedDirectories = new Set([
  ".astro",
  ".next",
  ".map-design-data",
  "dist",
  "node_modules",
  "out",
  "reports",
  "test-results",
  "vendor",
]);
const leafPackages = ["@mapseekai/desktop", "@mapseekai/packaged", "@mapseekai/tools-pack"] as const;

const allowedConsumerPrefixes = new Map([
  [
    "tools/dev/",
    "tools-dev launches the desktop entry; the certain rule keeps @mapseekai/tools-dev tests armed",
  ],
]);

const allowedConsumers = new Map([
  [
    "e2e/lib/playwright/packaged-protocol.ts",
    "the isolated Electron fixture is exercised by the guarded packaged CI block",
  ],
  [
    "apps/packaged/esbuild.config.mjs",
    "the packaged build owns these entrypoints; the config itself remains medium-tier",
  ],
  [
    "tools/pack/esbuild.config.mjs",
    "the tools-pack build owns this entrypoint; the config itself remains medium-tier",
  ],
  [
    "packages/platform/tests/index.test.ts",
    "package-manager invocation fixtures serialize the desktop build command without loading desktop code",
  ],
  [
    "e2e/tests/scripts/check-mapdesign-imports.test.ts",
    "the topology guard tests package identity strings without loading packaged leaf code",
  ],
]);

const requiredWorkspaceUnitBlock = `if [ "\${{ needs.scopes.outputs.tools_dev_tests_required }}" = "true" ]; then
            pnpm --filter @mapseekai/tools-dev test
          fi
          if [ "\${{ needs.scopes.outputs.tools_pack_tests_required }}" = "true" ]; then
            pnpm --filter @mapseekai/desktop build
            pnpm --filter @mapseekai/desktop test
            pnpm --filter @mapseekai/packaged test
            pnpm --filter @mapseekai/tools-pack test
            pnpm -C e2e exec playwright install-deps chromium
            xvfb-run --auto-servernum pnpm -C e2e exec playwright test -c playwright.config.ts ui/packaged-protocol.test.ts
          fi`;

export type PackagedLeafConsumptionViolation = {
  filePath: string;
  lineNumber: number;
  literal: string;
};

function repositoryPath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function landsInPackagedLeaf(value: string): boolean {
  return CERTAIN_PACKAGED_LEAF_PREFIXES.some(
    (prefix) => value === prefix.slice(0, -1) || value.startsWith(prefix),
  );
}

function literalTargetsPackagedLeaf(fromRepositoryPath: string, literal: string): boolean {
  if (leafPackages.some((packageName) => literal === packageName || literal.startsWith(`${packageName}/`))) {
    return true;
  }
  const resolved =
    literal.startsWith("./") || literal.startsWith("../")
      ? path.posix.normalize(path.posix.join(path.posix.dirname(fromRepositoryPath), literal))
      : literal;
  return landsInPackagedLeaf(resolved);
}

type StaticPath = { value: string; display: string };

function staticPath(node: ts.Expression, sourceFile: ts.SourceFile): StaticPath | undefined {
  if (ts.isStringLiteralLike(node)) return { value: node.text, display: node.getText(sourceFile) };
  if (ts.isTemplateExpression(node)) {
    return { value: node.head.text, display: node.getText(sourceFile) };
  }
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  if (
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== "path" ||
    (node.expression.name.text !== "join" && node.expression.name.text !== "resolve")
  ) {
    return undefined;
  }

  const segments: string[] = [];
  for (const [index, argument] of node.arguments.entries()) {
    if (index === 0 && ts.isIdentifier(argument) && /^(?:repoRoot|workspaceRoot|WORKSPACE_ROOT)$/.test(argument.text)) {
      continue;
    }
    if (!ts.isExpression(argument)) return undefined;
    const segment = staticPath(argument, sourceFile);
    if (segment == null || segment.value.length === 0) return undefined;
    segments.push(segment.value);
  }
  return segments.length > 0
    ? { value: path.posix.join(...segments), display: node.getText(sourceFile) }
    : undefined;
}

export function collectPackagedLeafConsumptionFromSource(
  filePath: string,
  source: string,
): PackagedLeafConsumptionViolation[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: PackagedLeafConsumptionViolation[] = [];
  const seen = new Set<number>();

  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node)) {
      const candidate = staticPath(node, sourceFile);
      if (candidate != null && literalTargetsPackagedLeaf(filePath, candidate.value)) {
        const start = node.getStart(sourceFile);
        if (!seen.has(start)) {
          seen.add(start);
          violations.push({
            filePath,
            lineNumber: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
            literal: candidate.display,
          });
        }
        return;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

function isAllowedConsumer(filePath: string): boolean {
  return (
    allowedConsumers.has(filePath) ||
    [...allowedConsumerPrefixes.keys()].some((prefix) => filePath.startsWith(prefix))
  );
}

async function collectCheckedFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    const repoPath = repositoryPath(fullPath);
    if (entry.isDirectory()) {
      if (
        skippedDirectories.has(entry.name) ||
        entry.name.startsWith(".next-") ||
        landsInPackagedLeaf(`${repoPath}/`)
      ) {
        continue;
      }
      files.push(...(await collectCheckedFiles(fullPath)));
    } else if (entry.isFile() && checkedExtensions.has(path.extname(entry.name))) {
      files.push(repoPath);
    }
  }
  return files;
}

function scopeBoundaryErrors(): string[] {
  const expectedEffects = new Set([
    "tools_dev_tests_required",
    "tools_pack_tests_required",
    "workspace_validation_required",
  ]);
  const errors: string[] = [];

  for (const filePath of ["e2e/lib/playwright/packaged-protocol.ts", "e2e/ui/packaged-protocol.test.ts"]) {
    const { outputs } = evaluateScopeOutputs([filePath], "medium", {
      deriveWorkspaceValidationFromTestScopes: true,
    });
    if (!outputs.tools_pack_tests_required || !outputs.workspace_validation_required) {
      errors.push(`${filePath} must arm packaged protocol validation`);
    }
  }

  for (const filePath of [
    "apps/desktop/src/main/index.ts",
    "apps/desktop/tests/main/runtime.test.ts",
    "apps/packaged/src/index.ts",
    "apps/packaged/tests/index.test.ts",
    "tools/pack/src/index.ts",
    "tools/pack/tests/index.test.ts",
    "tools/pack/resources/linux/map-design.desktop.template",
  ]) {
    const evaluation = evaluateScopeOutputs([filePath], "certain", {
      deriveWorkspaceValidationFromTestScopes: true,
    });
    const decision = evaluation.decisions[0];
    const actualEffects = SCOPE_EFFECTS.filter((effect) => evaluation.outputs[effect]);
    if (
      decision?.escalated !== false ||
      decision.matchedRules.length !== 1 ||
      decision.matchedRules[0] !== "certain-packaged-leaf-sources" ||
      actualEffects.length !== expectedEffects.size ||
      actualEffects.some((effect) => !expectedEffects.has(effect))
    ) {
      errors.push(`${filePath} does not resolve to the guarded packaged-leaf effects at the certain threshold`);
    }
  }
  return errors;
}

export function hasGuardedWorkspaceUnitCommands(workflow: string): boolean {
  return workflow.replace(/\r\n/g, "\n").includes(requiredWorkspaceUnitBlock);
}

export async function checkPackagedLeafBoundary(): Promise<boolean> {
  const violations: PackagedLeafConsumptionViolation[] = [];
  for (const root of checkedRoots) {
    for (const filePath of await collectCheckedFiles(path.join(repoRoot, root))) {
      if (isAllowedConsumer(filePath)) continue;
      const source = await readFile(path.join(repoRoot, filePath), "utf8");
      violations.push(...collectPackagedLeafConsumptionFromSource(filePath, source));
    }
  }

  const workflow = await readFile(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const errors = scopeBoundaryErrors();
  if (!hasGuardedWorkspaceUnitCommands(workflow)) {
    errors.push("ci.yml no longer contains the guarded tools-dev and packaged unit command block");
  }

  if (violations.length > 0 || errors.length > 0) {
    console.error("Packaged-leaf boundary violations found:");
    for (const violation of violations) {
      console.error(`- ${violation.filePath}:${violation.lineNumber} ${violation.literal}`);
    }
    for (const error of errors) console.error(`- ${error}`);
    console.error("Keep new consumers inside the guarded validation plan or leave the changed surface at medium confidence.");
    return false;
  }

  console.log("Packaged-leaf boundary check passed: certain-tier consumers, effects, and CI commands stay aligned.");
  return true;
}
