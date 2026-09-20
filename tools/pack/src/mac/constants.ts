export const PRODUCT_NAME = "MapDesign";

export const INTERNAL_PACKAGES = [
  { directory: "packages/components", name: "@mapseekai/components" },
  { directory: "packages/contracts", name: "@mapseekai/contracts" },
  { directory: "packages/map-design-contracts", name: "@mapseekai/map-design-contracts" },
  { directory: "packages/sidecar-proto", name: "@mapseekai/sidecar-proto" },
  { directory: "packages/sidecar", name: "@mapseekai/sidecar" },
  { directory: "packages/platform", name: "@mapseekai/platform" },
  { directory: "skills/cartography-init", name: "@cartographymd/init-skill" },
  { directory: "apps/daemon", name: "@mapseekai/daemon" },
  { directory: "apps/web", name: "@mapseekai/web" },
  { directory: "apps/desktop", name: "@mapseekai/desktop" },
  { directory: "apps/packaged", name: "@mapseekai/packaged" },
] as const;

export const DESKTOP_LOG_ECHO_ENV = "MAP_DESIGN_DESKTOP_LOG_ECHO";
export const WEB_STANDALONE_HOOK_CONFIG_ENV = "MAP_DESIGN_TOOLS_PACK_WEB_STANDALONE_HOOK_CONFIG";
export const WEB_STANDALONE_RESOURCE_NAME = "map-design-web-standalone";
export const ELECTRON_BUILDER_ASAR = false;
export const ELECTRON_BUILDER_BUILD_DEPENDENCIES_FROM_SOURCE = false;
export const ELECTRON_REBUILD_MODE = "sequential" as const;
export const ELECTRON_REBUILD_NATIVE_MODULES = ["better-sqlite3"] as const;
export const ELECTRON_BUILDER_FILE_PATTERNS = [
  "**/*",
  "!**/node_modules/.bin",
  "!**/node_modules/electron{,/**/*}",
  "!**/*.map",
  "!**/*.tsbuildinfo",
  "!**/.next/cache",
  "!**/.next/cache/**",
  "!**/node_modules/better-sqlite3/build/Release/obj",
  "!**/node_modules/better-sqlite3/build/Release/obj/**",
  "!**/node_modules/better-sqlite3/deps",
  "!**/node_modules/better-sqlite3/deps/**",
] as const;
// Keep Electron native UI resources aligned with the Web UI locale set.
// Electron uses underscore-separated locale ids; its base "es" resource
// covers the app's es-ES dictionary.
export const MAC_ELECTRON_LANGUAGES = [
  "en",
  "de",
  "zh_CN",
  "zh_TW",
  "pt_BR",
  "es",
  "ru",
  "fa",
  "ar",
  "ja",
  "ko",
  "pl",
  "hu",
  "fr",
  "uk",
  "tr",
] as const;
