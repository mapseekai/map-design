const LISTENER_PORT_ENV_NAMES: Record<string, true> = { MAP_DESIGN_PORT: true, MAP_DESIGN_WEB_PORT: true, PORT: true };

export function createAppRuntimeEnv(baseEnv: NodeJS.ProcessEnv, appEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (LISTENER_PORT_ENV_NAMES[key.toUpperCase()] === true) delete env[key];
  }
  return { ...env, ...appEnv };
}

export function createDaemonSidecarEnv({
  daemonPort,
  webPort,
}: {
  daemonPort: number | null;
  webPort: number | null;
}): NodeJS.ProcessEnv {
  return {
    MAP_DESIGN_PORT: String(daemonPort ?? 0),
    ...(webPort == null ? {} : { MAP_DESIGN_WEB_PORT: String(webPort) }),
  };
}

export function createWebSidecarEnv({
  daemonPort,
  webPort,
}: {
  daemonPort: number | string;
  webPort: number | null;
}): NodeJS.ProcessEnv {
  const port = String(webPort ?? 0);
  return {
    MAP_DESIGN_PORT: String(daemonPort),
    MAP_DESIGN_WEB_PORT: port,
    PORT: port,
  };
}
