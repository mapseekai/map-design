import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { createAppRuntimeEnv, createDaemonSidecarEnv, createWebSidecarEnv } from "../src/sidecar-env.js";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

describe("tools-dev sidecar environments", () => {
  it("passes requested ports to the daemon using MapDesign environment names", () => {
    const env = createDaemonSidecarEnv({ daemonPort: 4101, webPort: 4201 });

    assert.deepEqual(env, {
      MAP_DESIGN_PORT: "4101",
      MAP_DESIGN_WEB_PORT: "4201",
    });
    assert.equal("PORT" in env, false);
  });

  it("passes requested ports to the web sidecar while preserving its internal PORT", () => {
    const env = createWebSidecarEnv({ daemonPort: "4101", daemonUrl: "http://localhost:4101", webPort: 4201 });

    assert.deepEqual(env, {
      MAP_DESIGN_PORT: "4101",
      MAP_DESIGN_DAEMON_URL: "http://localhost:4101",
      MAP_DESIGN_WEB_PORT: "4201",
      PORT: "4201",
    });
    assert.equal("PORT" in env, true);
  });

  it("removes inherited listener ports before applying an app-specific environment", () => {
    const env = createAppRuntimeEnv(
      { MAP_DESIGN_PORT: "1000", MAP_DESIGN_WEB_PORT: "1001", PORT: "1002", PRESERVE: "yes" },
      { MAP_DESIGN_PORT: "4101" },
    );

    assert.deepEqual(env, { MAP_DESIGN_PORT: "4101", PRESERVE: "yes" });
  });

  it("keeps canonical stamp keys while assigning exact app port environments", () => {
    const canonicalStampEnv = {
      MAP_DESIGN_IPC_PATH: "/tmp/map-design-daemon.sock",
      MAP_DESIGN_NAMESPACE: "test",
      MAP_DESIGN_SIDECAR_BASE: "/tmp/map-design",
      MAP_DESIGN_SOURCE: "dev",
    };
    const inheritedEnv = {
      MAP_DESIGN_PORT: "stale-daemon",
      MAP_DESIGN_WEB_PORT: "stale-web",
      PORT: "stale-listener",
    };

    assert.deepEqual(
      createAppRuntimeEnv(inheritedEnv, { ...canonicalStampEnv, ...createDaemonSidecarEnv({ daemonPort: 4101, webPort: 4201 }) }),
      { ...canonicalStampEnv, MAP_DESIGN_PORT: "4101", MAP_DESIGN_WEB_PORT: "4201" },
    );
    assert.deepEqual(
      createAppRuntimeEnv(inheritedEnv, { ...canonicalStampEnv, ...createWebSidecarEnv({ daemonPort: 4101, daemonUrl: "http://127.0.0.1:4101", webPort: 4201 }) }),
      { ...canonicalStampEnv, MAP_DESIGN_PORT: "4101", MAP_DESIGN_DAEMON_URL: "http://127.0.0.1:4101", MAP_DESIGN_WEB_PORT: "4201", PORT: "4201" },
    );
    assert.deepEqual(createAppRuntimeEnv(inheritedEnv, canonicalStampEnv), canonicalStampEnv);
  });

  it("routes production web API requests to the discovered daemon instead of an inherited URL", () => {
    const env = createAppRuntimeEnv(
      { MAP_DESIGN_WEB_PROD: "1", MAP_DESIGN_DAEMON_URL: "http://127.0.0.1:9999" },
      createWebSidecarEnv({ daemonPort: 4101, daemonUrl: "http://localhost:4101", webPort: 4201 }),
    );

    assert.equal(env.MAP_DESIGN_DAEMON_URL, "http://localhost:4101");
    assert.equal(env.MAP_DESIGN_WEB_PROD, "1");
  });

  it("builds the stamp environment without inheriting process environment values", () => {
    assert.match(indexSource, /createSidecarLaunchEnv\(\{[\s\S]*?extraEnv: \{\}/u);
  });
});
