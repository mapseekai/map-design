const SAFE_OS_ENVIRONMENT_KEYS = [
  'APPDATA',
  'ALL_PROXY',
  'COLORTERM',
  'COMSPEC',
  'FORCE_COLOR',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'LOGNAME',
  'NO_COLOR',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
  'PATH',
  'Path',
  'PATHEXT',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TERM_PROGRAM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'USERPROFILE',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

/**
 * Build the least-authority environment inherited by an Agent subprocess.
 * `inheritedEnvKeys` is an explicit definition/config contract; arbitrary
 * ambient daemon variables are never copied. Adapter-specific, run-scoped
 * values are added only after this boundary.
 */
export function sanitizeMapAgentLaunchEnvironment(
  environment: NodeJS.ProcessEnv,
  inheritedEnvKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  const allowed = new Set<string>([
    ...SAFE_OS_ENVIRONMENT_KEYS,
    ...inheritedEnvKeys,
  ]);
  for (const key of allowed) {
    if (key.startsWith('MAP_DESIGN_') || key === 'DSH_HOME') continue;
    const value = environment[key];
    if (value !== undefined) sanitized[key] = value;
  }
  return sanitized;
}
