export const PRODUCT_NAME = "MapDesign";
export const WIN_EXECUTABLE_BASENAME = "map-design";
export const DESKTOP_LOG_ECHO_ENV = "MAP_DESIGN_DESKTOP_LOG_ECHO";
export const WEB_STANDALONE_HOOK_CONFIG_ENV = "MAP_DESIGN_TOOLS_PACK_WEB_STANDALONE_HOOK_CONFIG";
export const WEB_STANDALONE_RESOURCE_NAME = "map-design-web-standalone";
export const ELECTRON_BUILDER_ASAR = false;
export const ELECTRON_BUILDER_BUILD_DEPENDENCIES_FROM_SOURCE = false;
export const ELECTRON_BUILDER_NODE_GYP_REBUILD = false;
export const ELECTRON_BUILDER_NPM_REBUILD = false;
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
export const NSIS_INSTALLER_LANGUAGE_BY_WEB_LOCALE = {
  en: "en_US",
  fa: "fa_IR",
  "pt-BR": "pt_BR",
  ru: "ru_RU",
  "zh-CN": "zh_CN",
  "zh-TW": "zh_TW",
} as const;
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
