import { describe, expect, it } from "vitest";
import {
  findForbiddenMapDesignImports,
  findFormerIdentityOccurrences,
  findFormerScopeDependencies,
  findMissingMapDesignWorkspaces,
  findUnexpectedMapDesignWorkspaces,
  isTrackedIdentityFile,
  isRetainedMapDesignWorkspace,
  MAP_DESIGN_TARGET_WORKSPACES,
} from "../../../scripts/check-mapdesign-imports.js";

describe("findForbiddenMapDesignImports", () => {
  it("rejects private and legacy maplibre-style-tools entrypoints", () => {
    const source = [
      'import x from "maplibre-style-tools";',
      'import y from "maplibre-style-tools/src/core";',
      'import z from "maplibre-style-tools/dist/index.js";',
    ].join("\n");

    expect(findForbiddenMapDesignImports("apps/web/src/map-design/x.ts", source)).toHaveLength(3);
  });

  it("accepts the five public entrypoints", () => {
    const source = ["core", "maplibre", "bridge", "mcp", "capabilities"]
      .map((entry) => `import type {} from "maplibre-style-tools/${entry}";`)
      .join("\n");

    expect(findForbiddenMapDesignImports("apps/web/src/map-design/x.ts", source)).toEqual([]);
  });

  it("rejects deep, legacy, and CommonJS entrypoints without matching comments", () => {
    const source = [
      '// import ignored from "maplibre-style-tools/ai";',
      'export * from "maplibre-style-tools/core/private";',
      'const legacy = require("maplibre-style-tools/ai");',
      'const dynamic = import("maplibre-style-tools/maplibre/internal");',
    ].join("\n");

    expect(findForbiddenMapDesignImports("apps/daemon/src/map-design/x.ts", source)).toHaveLength(3);
  });

  it("rejects statically known dynamic, type, and template imports", () => {
    const source = [
      'const dynamicWithOptions = import("maplibre-style-tools/ai", { with: { type: "json" } });',
      'type PrivateTool = import("maplibre-style-tools/ai").Tool;',
      "const dynamicTemplate = import(`maplibre-style-tools/ai`);",
      "const commonJsTemplate = require(`maplibre-style-tools/ai`);",
    ].join("\n");

    expect(findForbiddenMapDesignImports("apps/web/src/map-design/x.ts", source)).toHaveLength(4);
  });
});

describe("target MapDesign workspace topology", () => {
  it("exports the exact retained workspaces and recognizes only them", () => {
    expect(MAP_DESIGN_TARGET_WORKSPACES).toEqual([
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
    ]);

    for (const workspace of MAP_DESIGN_TARGET_WORKSPACES) {
      expect(isRetainedMapDesignWorkspace(workspace)).toBe(true);
    }
    expect(isRetainedMapDesignWorkspace("@mapseekai/legacy-map-design")).toBe(false);
  });

  it("reports every non-target workspace in deterministic order", () => {
    expect(findUnexpectedMapDesignWorkspaces([
      { directory: "tools/release", name: "@mapseekai/tools-release" },
      { directory: "packages/contracts", name: "@mapseekai/contracts" },
      { directory: "packages/agui-adapter", name: "@mapseekai/agui-adapter" },
    ])).toEqual([
      "packages/agui-adapter (@mapseekai/agui-adapter)",
      "tools/release (@mapseekai/tools-release)",
    ]);
  });

  it("reports every missing target workspace in deterministic order", () => {
    expect(findMissingMapDesignWorkspaces([
      { directory: "apps/daemon", name: "@mapseekai/daemon" },
      { directory: "tools/dev", name: "@mapseekai/tools-dev" },
    ])).toEqual([
      "@cartographymd/data-profile-skill",
      "@cartographymd/init-skill",
      "@mapseekai/components",
      "@mapseekai/contracts",
      "@mapseekai/desktop",
      "@mapseekai/e2e",
      "@mapseekai/map-design-contracts",
      "@mapseekai/packaged",
      "@mapseekai/platform",
      "@mapseekai/sidecar",
      "@mapseekai/sidecar-proto",
      "@mapseekai/tools-pack",
      "@mapseekai/web",
    ]);
  });

  it("reports former-scope dependency keys deterministically", () => {
    const formerScope = `@${["open", "design"].join("-")}/`;
    const formerMapScope = `@${["map", "design"].join("-")}/`;
    expect(findFormerScopeDependencies([
      { directory: "apps/web", name: "@mapseekai/web", dependencyNames: [`${formerScope}components`] },
      { directory: "packages/contracts", name: "@mapseekai/contracts", dependencyNames: ["zod", `${formerMapScope}contracts`] },
      { directory: "tools/dev", name: "@mapseekai/tools-dev", dependencyNames: ["@mapseekai/platform"] },
    ])).toEqual([
      `apps/web (${formerScope}components)`,
      `packages/contracts (${formerMapScope}contracts)`,
    ]);
  });

  it("detects every retired runtime identity", () => {
    const former = [
      ["open", "design"].join("-"),
      ["open", "design"].join("_"),
      ["Open", "Design"].join(""),
      ["Map", "Design"].join(" "),
      ["O", "D"].join("") + "_DATA_DIR",
      ["o", "d"].join(""),
      `x-${["open", "design"].join("-")}-token`,
      `${["open", "design"].join("-")}://`,
      `/tmp/${["open", "design"].join("-")}`,
      `.tmp/${["open", "design"].join("-")}`,
      `@${["map", "design"].join("-")}/contracts`,
    ].join("\n");
    const retiredPascalName = ["Open", "Design"].join("");
    const formerMapDesign = ["Map", "Design"].join(" ");
    const occurrences = findFormerIdentityOccurrences("apps/daemon/src/example.ts", former);
    expect(occurrences).toEqual(expect.arrayContaining([
      `apps/daemon/src/example.ts: ${retiredPascalName}`,
      `apps/daemon/src/example.ts: ${formerMapDesign}`,
    ]));
  });
});

describe("retained identity file coverage", () => {
  it("rejects retired identities planted in tracked SVG assets and .cts preload sources", () => {
    const former = ["Map", "Design"].join(" ");
    for (const filePath of ["assets/brand/retired.svg", "apps/desktop/src/preload.cts"]) {
      expect(isTrackedIdentityFile(filePath)).toBe(true);
      expect(findFormerIdentityOccurrences(filePath, former)).not.toEqual([]);
    }
  });
});
