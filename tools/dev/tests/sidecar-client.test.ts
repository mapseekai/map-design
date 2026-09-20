import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { MAP_DESIGN_SIDECAR_MESSAGES } from "@mapseekai/sidecar-proto";
import { createJsonIpcServer } from "@mapseekai/sidecar";

import {
  DAEMON_STARTUP_TIMEOUT_MS,
  inspectDaemonRuntime,
  inspectDesktopRuntime,
  inspectWebRuntime,
  resolveDaemonIpcPath,
  resolveDesktopIpcPath,
  resolveWebIpcPath,
  waitForDaemonRuntime,
  waitForDesktopRuntime,
  waitForWebRuntime,
} from "../src/sidecar-client.js";

describe("sidecar startup waits", () => {
  it("allows daemon initialization to continue past the legacy 35 second deadline", () => {
    assert.equal(DAEMON_STARTUP_TIMEOUT_MS, 120_000);
  });

  it("fails immediately when a spawned app exits before publishing status", async () => {
    const waits = [
      ["daemon", waitForDaemonRuntime],
      ["web", waitForWebRuntime],
      ["desktop", waitForDesktopRuntime],
    ] as const;

    for (const [appName, waitForRuntime] of waits) {
      const startedAt = Date.now();
      await assert.rejects(
        waitForRuntime(
          { base: "unused", namespace: `exited-${appName}-${process.pid}` },
          5_000,
          () => false,
        ),
        new RegExp(`${appName} exited before exposing status`),
      );
      assert.ok(Date.now() - startedAt < 1_000);
    }
  });

  it("reads the current minimal status snapshots over each sidecar IPC endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-design-tools-dev-status-"));
    const runtime = { base: root, namespace: `status-${process.pid}-${Date.now()}` };
    const snapshots = {
      daemon: { pid: 1001, state: "running" as const, url: "http://127.0.0.1:4100" },
      desktop: { pid: 1003, state: "running" as const, url: null },
      web: { pid: 1002, state: "running" as const, url: "http://127.0.0.1:4200" },
    };
    const servers = await Promise.all([
      createJsonIpcServer({
        socketPath: resolveDaemonIpcPath(runtime),
        handler: async (message) => {
          assert.equal(message?.type, MAP_DESIGN_SIDECAR_MESSAGES.STATUS);
          return snapshots.daemon;
        },
      }),
      createJsonIpcServer({
        socketPath: resolveWebIpcPath(runtime),
        handler: async (message) => {
          assert.equal(message?.type, MAP_DESIGN_SIDECAR_MESSAGES.STATUS);
          return snapshots.web;
        },
      }),
      createJsonIpcServer({
        socketPath: resolveDesktopIpcPath(runtime),
        handler: async (message) => {
          assert.equal(message?.type, MAP_DESIGN_SIDECAR_MESSAGES.STATUS);
          return snapshots.desktop;
        },
      }),
    ]);

    try {
      assert.deepEqual(await inspectDaemonRuntime(runtime), snapshots.daemon);
      assert.deepEqual(await inspectWebRuntime(runtime), snapshots.web);
      assert.deepEqual(await inspectDesktopRuntime(runtime), snapshots.desktop);
      assert.deepEqual(await waitForDaemonRuntime(runtime, 1_000), snapshots.daemon);
      assert.deepEqual(await waitForWebRuntime(runtime, 1_000), snapshots.web);
      assert.deepEqual(await waitForDesktopRuntime(runtime, 1_000), snapshots.desktop);
    } finally {
      await Promise.all(servers.map(async (server) => await server.close()));
      await rm(root, { force: true, recursive: true });
    }
  });
});
