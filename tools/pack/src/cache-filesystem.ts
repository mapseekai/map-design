import { rename } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

export async function publishCacheEntry(stagingPath: string, entryPath: string): Promise<void> {
  let originalError: Error | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(stagingPath, entryPath);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EPERM", "EBUSY", "EACCES"].includes(String(error.code))
      ) throw error;
      originalError ??= error;
      if (attempt >= 6) throw originalError;
      await setTimeout(100 * (attempt + 1));
    }
  }
}
