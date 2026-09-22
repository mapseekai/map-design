import type * as FileSystem from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function withPosixPermissions(original: typeof FileSystem) {
  if (process.platform !== "win32") return original;
  const modes = new Map<string, number>();
  const key = (path: Parameters<typeof original.chmod>[0]) => resolve(
    path instanceof URL ? fileURLToPath(path) : path.toString(),
  );
  return {
    ...original,
    chmod: async (path: Parameters<typeof original.chmod>[0], mode: Parameters<typeof original.chmod>[1]) => {
      await original.chmod(path, mode);
      modes.set(key(path), typeof mode === "number" ? mode : Number.parseInt(mode, 8));
    },
    stat: async (...args: Parameters<typeof original.stat>) => {
      const metadata = await original.stat(...args);
      const mode = modes.get(key(args[0]));
      if (mode !== undefined) {
        const value = typeof metadata.mode === "bigint"
          ? (metadata.mode & ~0o777n) | BigInt(mode & 0o777)
          : (metadata.mode & ~0o777) | (mode & 0o777);
        Object.defineProperty(metadata, "mode", { value, writable: true, configurable: true });
      }
      return metadata;
    },
  };
}
