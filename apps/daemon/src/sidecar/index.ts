import { MAP_DESIGN_SIDECAR_CONTRACT } from "@mapseekai/sidecar-proto";
import { bootstrapSidecarRuntime } from "@mapseekai/sidecar";
import { readProcessStamp } from "@mapseekai/platform";

import { startDaemonSidecar } from "./server.js";

async function main(): Promise<void> {
  const stamp = readProcessStamp(process.argv.slice(2), MAP_DESIGN_SIDECAR_CONTRACT);
  if (stamp == null || stamp.app !== "daemon") throw new Error("MapDesign daemon sidecar stamp is required");
  const runtime = bootstrapSidecarRuntime(stamp, process.env, { app: "daemon", contract: MAP_DESIGN_SIDECAR_CONTRACT });
  await startDaemonSidecar(runtime);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
