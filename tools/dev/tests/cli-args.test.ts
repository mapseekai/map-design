import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { readFileSync } from "node:fs";

import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { rewriteCliArgsForDefaultStart } from "../src/cli-args.js";

const toolsDevRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


const toolsDevSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

describe("tools-dev CLI argument rewriting", () => {
  it("preserves global help before applying the default start command", () => {
    assert.deepEqual(rewriteCliArgsForDefaultStart(["--help"]), ["--help"]);
    assert.deepEqual(rewriteCliArgsForDefaultStart(["-h"]), ["-h"]);
    assert.deepEqual(rewriteCliArgsForDefaultStart(["--namespace", "demo", "--help"]), ["--namespace", "demo", "--help"]);
  });

  it("inserts the default start command without stealing option values", () => {
    assert.deepEqual(rewriteCliArgsForDefaultStart([]), ["start"]);
    assert.deepEqual(rewriteCliArgsForDefaultStart(["--namespace", "demo", "--json"]), [
      "start",
      "--namespace",
      "demo",
      "--json",
    ]);
    assert.deepEqual(rewriteCliArgsForDefaultStart(["--env-file=local.env", "--web-port", "17573"]), [
      "start",
      "--env-file=local.env",
      "--web-port",
      "17573",
    ]);
    assert.deepEqual(rewriteCliArgsForDefaultStart(["--namespace", "demo", "daemon"]), [
      "--namespace",
      "demo",
      "start",
      "daemon",
    ]);
  });

  it("preserves explicit commands", () => {
    assert.deepEqual(rewriteCliArgsForDefaultStart(["status", "--json"]), ["status", "--json"]);
    assert.deepEqual(rewriteCliArgsForDefaultStart(["--namespace", "demo", "logs"]), ["--namespace", "demo", "logs"]);
  });

  it("does not require --env-file when parsing shared command options", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", "status", "not-an-app"], {
      cwd: toolsDevRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsupported tools-dev app: not-an-app/);
    assert.doesNotMatch(result.stderr, /option `--env-file <path>` value is missing/);
  });
});

describe("tools-dev foreground ownership", () => {
  it("owns foreground children and uses those options consistently", () => {
    assert.match(toolsDevSource, /const foregroundOptions = \{ \.\.\.options, parentPid: process\.pid \};/);
    assert.ok(toolsDevSource.includes("resolveSharedPortsFromRunningState(targets, foregroundOptions"));
    assert.ok(toolsDevSource.includes("startApp(config, target, foregroundOptions)"));
  });
});
