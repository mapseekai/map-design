import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const MAP_DESIGN_TARGET_WORKSPACES = [
  "@cartographymd/init-skill",
  "@cartographymd/data-profile-skill",
  "@mapseekai/components",
  "@mapseekai/contracts",
  "@mapseekai/daemon",
  "@mapseekai/desktop",
  "@mapseekai/e2e",
  "@mapseekai/map-design-contracts",
  "@mapseekai/packaged",
  "@mapseekai/platform",
  "@mapseekai/sidecar",
  "@mapseekai/sidecar-proto",
  "@mapseekai/tools-dev",
  "@mapseekai/tools-pack",
  "@mapseekai/web",
] as const;

export function isRetainedMapDesignWorkspace(name: string): boolean {
  return (MAP_DESIGN_TARGET_WORKSPACES as readonly string[]).includes(name);
}

type WorkspaceManifest = {
  readonly directory: string;
  readonly name: string;
  readonly dependencyNames?: readonly string[];
};

const formerPackageScopes = [
  `@${["open", "design"].join("-")}/`,
  `@${["map", "design"].join("-")}/`,
] as const;

export function findFormerScopeDependencies(manifests: readonly WorkspaceManifest[]): string[] {
  return manifests.flatMap((manifest) =>
    (manifest.dependencyNames ?? [])
      .filter((dependency) => formerPackageScopes.some((scope) => dependency.startsWith(scope)))
      .map((dependency) => `${manifest.directory} (${dependency})`),
  ).sort();
}

export function findUnexpectedMapDesignWorkspaces(workspaces: readonly WorkspaceManifest[]): string[] {
  return workspaces
    .filter((workspace) => !isRetainedMapDesignWorkspace(workspace.name))
    .map((workspace) => `${workspace.directory} (${workspace.name})`)
    .sort();
}

export function findMissingMapDesignWorkspaces(workspaces: readonly WorkspaceManifest[]): string[] {
  const actualNames = new Set(workspaces.map((workspace) => workspace.name));
  return MAP_DESIGN_TARGET_WORKSPACES.filter((name) => !actualNames.has(name)).sort();
}

const MAPLIBRE_STYLE_TOOLS = "maplibre-style-tools";
const allowedEntrypoints = new Set([
  "maplibre-style-tools/core",
  "maplibre-style-tools/capabilities",
  "maplibre-style-tools/maplibre",
  "maplibre-style-tools/bridge",
  "maplibre-style-tools/mcp",
]);
const scannedRoots = [
  "apps/daemon/src/map-design",
  "apps/web/src/map-design",
  "packages/map-design-contracts/src",
];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

const identityFileExtensions: Record<string, true> = {
  ".cjs": true,
  ".cts": true,
  ".css": true,
  ".desktop": true,
  ".html": true,
  ".ini": true,
  ".json": true,
  ".js": true,
  ".mjs": true,
  ".plist": true,
  ".rc": true,
  ".sh": true,
  ".svg": true,
  ".template": true,
  ".toml": true,
  ".ts": true,
  ".tsx": true,
  ".xml": true,
  ".yaml": true,
  ".yml": true,
};
const identityRoots = ["apps/", "assets/", "e2e/", "packages/", "resources/", "scripts/", "tools/"] as const;
const formerIdentityPatterns = [
  new RegExp(["open", "design"].join("[-_ ]"), "i"),
  new RegExp(["Open", "Design"].join("")),
  new RegExp(["Map", "Design"].join(" ")),
  new RegExp(`@${["open", "design"].join("-")}/`, "i"),
  new RegExp(`@${["map", "design"].join("-")}/`, "i"),
  new RegExp(`\\b${["O", "D"].join("")}_`),
  new RegExp(`\\b${["o", "d"].join("")}\\b`),
  new RegExp(`x-${["open", "design"].join("-")}`, "i"),
  new RegExp(`${["open", "design"].join("-")}://`, "i"),
  new RegExp(`/tmp/${["open", "design"].join("-")}`, "i"),
  new RegExp(`\\.tmp/${["open", "design"].join("-")}`, "i"),
] as const;

export function findFormerIdentityOccurrences(filePath: string, source: string): string[] {
  return formerIdentityPatterns.flatMap((pattern) => {
    const match = source.match(pattern);
    return match == null ? [] : [`${filePath}: ${match[0]}`];
  });
}

export function isTrackedIdentityFile(filePath: string): boolean {
  const parts = filePath.split("/");
  return filePath !== ""
    && !parts.some((part) => part.startsWith("."))
    && (identityRoots.some((root) => filePath.startsWith(root)) || filePath === "package.json" || filePath === "pnpm-workspace.yaml")
    && identityFileExtensions[path.extname(filePath)] === true;
}

function trackedNonHiddenIdentityFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repositoryRoot, encoding: "utf8" })
    .split("\0")
    .filter(isTrackedIdentityFile)
    .filter((filePath) => existsSync(path.join(repositoryRoot, filePath)));
}

function staticModuleSpecifier(node: ts.Node | undefined): string | undefined {
  if (node == null) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  return ts.isLiteralTypeNode(node) ? staticModuleSpecifier(node.literal) : undefined;
}

function moduleSpecifierFromNode(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return staticModuleSpecifier(node.moduleSpecifier);
  }

  if (ts.isImportTypeNode(node)) {
    return staticModuleSpecifier(node.argument);
  }

  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return staticModuleSpecifier(node.moduleReference.expression);
  }

  if (!ts.isCallExpression(node)) {
    return undefined;
  }
  const moduleSpecifier = staticModuleSpecifier(node.arguments[0]);
  if (moduleSpecifier == null) return undefined;

  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return moduleSpecifier;
  }

  return ts.isIdentifier(node.expression) && node.expression.text === "require" ? moduleSpecifier : undefined;
}

function isForbiddenEntrypoint(moduleSpecifier: string): boolean {
  return (
    moduleSpecifier === MAPLIBRE_STYLE_TOOLS ||
    (moduleSpecifier.startsWith(`${MAPLIBRE_STYLE_TOOLS}/`) && !allowedEntrypoints.has(moduleSpecifier))
  );
}

export function findForbiddenMapDesignImports(filePath: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, false);
  const forbiddenImports: string[] = [];

  const visit = (node: ts.Node): void => {
    const moduleSpecifier = moduleSpecifierFromNode(node);
    if (moduleSpecifier != null && isForbiddenEntrypoint(moduleSpecifier)) {
      forbiddenImports.push(moduleSpecifier);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return forbiddenImports;
}

async function sourceFilesIn(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          return sourceFilesIn(entryPath);
        }
        return entry.isFile() && sourceExtensions.has(path.extname(entry.name)) ? [entryPath] : [];
      }),
    );
    return files.flat();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function workspaceManifests(): Promise<WorkspaceManifest[]> {
  const roots = ["apps", "packages", "tools", "skills"];
  const entries = await Promise.all(roots.map(async (root) => {
    const directories = await readdir(path.join(repositoryRoot, root), { withFileTypes: true });
    return Promise.all(directories.filter((entry) => (
      entry.isDirectory()
      && existsSync(path.join(repositoryRoot, root, entry.name, "package.json"))
    )).map(async (entry) => {
      const directory = path.join(root, entry.name);
      const manifest = JSON.parse(await readFile(path.join(repositoryRoot, directory, "package.json"), "utf8")) as {
        name?: unknown;
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
        optionalDependencies?: Record<string, unknown>;
        peerDependencies?: Record<string, unknown>;
      };
      const dependencyNames = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ];
      return typeof manifest.name === "string" ? { directory, name: manifest.name, dependencyNames } : null;
  }));
  }));
  const e2e = JSON.parse(await readFile(path.join(repositoryRoot, "e2e", "package.json"), "utf8")) as {
    name?: unknown;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    optionalDependencies?: Record<string, unknown>;
    peerDependencies?: Record<string, unknown>;
  };
  const e2eDependencies = [
    ...Object.keys(e2e.dependencies ?? {}),
    ...Object.keys(e2e.devDependencies ?? {}),
    ...Object.keys(e2e.optionalDependencies ?? {}),
    ...Object.keys(e2e.peerDependencies ?? {}),
  ];
  const workspaceEntries = entries.flat(2) as Array<WorkspaceManifest | null>;
  return [
    ...workspaceEntries.filter((entry): entry is WorkspaceManifest => entry != null),
    ...(typeof e2e.name === "string" ? [{ directory: "e2e", name: e2e.name, dependencyNames: e2eDependencies }] : []),
  ];
}

async function runCli(): Promise<void> {
  const workspaces = await workspaceManifests();
  const unexpectedWorkspaces = findUnexpectedMapDesignWorkspaces(workspaces);
  const missingWorkspaces = findMissingMapDesignWorkspaces(workspaces);
  const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as {
    name?: unknown;
    bin?: unknown;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    optionalDependencies?: Record<string, unknown>;
    peerDependencies?: Record<string, unknown>;
  };
  const rootDependencies = [
    ...Object.keys(rootManifest.dependencies ?? {}),
    ...Object.keys(rootManifest.devDependencies ?? {}),
    ...Object.keys(rootManifest.optionalDependencies ?? {}),
    ...Object.keys(rootManifest.peerDependencies ?? {}),
  ];
  const formerScopeDependencies = findFormerScopeDependencies([
    ...workspaces,
    { directory: ".", name: typeof rootManifest.name === "string" ? rootManifest.name : "", dependencyNames: rootDependencies },
  ]);
  for (const workspace of missingWorkspaces) {
    console.error(`missing workspace: ${workspace}`);
  }
  for (const workspace of unexpectedWorkspaces) {
    console.error(`retired workspace: ${workspace}`);
  }
  if (rootManifest.name !== "map-design") {
    console.error(`root package name must be map-design (received ${String(rootManifest.name)})`);
  }
  for (const dependency of formerScopeDependencies) {
    console.error(`former scope dependency: ${dependency}`);
  }
  let failed = missingWorkspaces.length > 0
    || unexpectedWorkspaces.length > 0
    || rootManifest.name !== "map-design"
    || formerScopeDependencies.length > 0;
  const expectedRootBin = { md: "./apps/daemon/bin/md.mjs" };
  if (JSON.stringify(rootManifest.bin) !== JSON.stringify(expectedRootBin)) {
    failed = true;
    console.error(`root package bin must be ${JSON.stringify(expectedRootBin)}`);
  }
  for (const filePath of trackedNonHiddenIdentityFiles()) {
    const source = await readFile(path.join(repositoryRoot, filePath), "utf8");
    for (const occurrence of findFormerIdentityOccurrences(filePath, source)) {
      failed = true;
      console.error(`former identity: ${occurrence}`);
    }
  }
  const files = (await Promise.all(scannedRoots.map((root) => sourceFilesIn(path.join(repositoryRoot, root))))).flat();
  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    for (const moduleSpecifier of findForbiddenMapDesignImports(filePath, source)) {
      failed = true;
      console.error(`${path.relative(repositoryRoot, filePath)} -> ${moduleSpecifier}`);
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await runCli();
}
