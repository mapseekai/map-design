import { MAP_DESIGN_SIDECAR_CONTRACT } from "@mapseekai/sidecar-proto";
import { bootstrapSidecarRuntime } from "@mapseekai/sidecar";
import { readProcessStamp } from "@mapseekai/platform";

import { startWebSidecar } from "./server.js";

async function main(): Promise<void> {
  const stamp = readProcessStamp(process.argv.slice(2), MAP_DESIGN_SIDECAR_CONTRACT);
  if (stamp == null || stamp.app !== "web") throw new Error("MapDesign web sidecar stamp is required");
  const runtime = bootstrapSidecarRuntime(stamp, process.env, { app: "web", contract: MAP_DESIGN_SIDECAR_CONTRACT });
  const server = await startWebSidecar(runtime);
  process.stdout.write(`${JSON.stringify(await server.status(), null, 2)}\n`);
  await server.waitUntilStopped();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
