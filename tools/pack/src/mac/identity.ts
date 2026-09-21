import type { ToolPackConfig } from "../config.js";
import { PRODUCT_NAME } from "./constants.js";

export type MacInstallIdentity = {
  appId: string;
  executableName: string;
  installerTitle: string;
  productName: string;
  publicAppBundleName: string;
  systemAppBundleName: string;
};

function sanitizeNamespace(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function resolveMacInstallIdentity(config: Pick<ToolPackConfig, "namespace"> & { appVersion?: string }): MacInstallIdentity {
  const namespaceToken = sanitizeNamespace(config.namespace);
  // electron-builder uses executableName as productFilename for the bundle.
  const executableName = "map-design";
  const publicAppBundleName = `${executableName}.app`;
  const systemAppBundleName = `${PRODUCT_NAME}.${namespaceToken}.app`;

  return {
    appId: "io.map-design.desktop",
    executableName,
    installerTitle: PRODUCT_NAME,
    productName: PRODUCT_NAME,
    publicAppBundleName,
    systemAppBundleName,
  };
}
