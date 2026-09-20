import type { ToolPackConfig } from "../config.js";
import { PRODUCT_NAME, WIN_EXECUTABLE_BASENAME } from "./constants.js";

export type WinInstallIdentity = {
  appPathsKey: string;
  displayName: string;
  exeName: string;
  registryKey: string;
  shortcutName: string;
  uninstallerName: string;
};

function resolveWindowsNamespaceToken(namespace: string): string {
  return namespace.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function resolveWindowsUninstallRegistryKey(namespace: string): string {
  return `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}-${resolveWindowsNamespaceToken(namespace)}`;
}

export function resolveWinInstallIdentity(config: Pick<ToolPackConfig, "namespace"> & { appVersion?: string }): WinInstallIdentity {
  const namespaceToken = resolveWindowsNamespaceToken(config.namespace);
  const displayName = PRODUCT_NAME;

  return {
    appPathsKey: `Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${displayName}.exe`,
    displayName,
    exeName: `${WIN_EXECUTABLE_BASENAME}.exe`,
    registryKey: resolveWindowsUninstallRegistryKey(config.namespace),
    shortcutName: `${displayName}.lnk`,
    uninstallerName: `Uninstall ${displayName}.exe`,
  };
}
