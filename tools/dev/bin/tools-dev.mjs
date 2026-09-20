#!/usr/bin/env node

import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const entryDir = dirname(fileURLToPath(import.meta.url));
const toolRoot = resolve(entryDir, "..");
const distEntry = resolve(toolRoot, "dist/index.mjs");

try {
  await access(distEntry);
} catch {
  throw new Error(`tools-dev build is missing: run "pnpm --filter @mapseekai/tools-dev build" before using tools-dev.`);
}

await import(pathToFileURL(distEntry).href);
