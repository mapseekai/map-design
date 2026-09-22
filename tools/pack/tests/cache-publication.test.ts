import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolPackCache } from "../src/cache.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: vi.fn(original.rename) };
});
vi.mock("node:timers/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:timers/promises")>();
  return { ...original, setTimeout: vi.fn(async () => undefined) };
});

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "map-design-cache-publication-"));
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
});

afterEach(async () => {
  if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
  vi.mocked(rename).mockReset();
  vi.mocked(setTimeout).mockClear();
  await rm(root, { recursive: true, force: true });
});

function fixture() {
  const cache = new ToolPackCache(join(root, "cache"));
  const build = vi.fn(async ({ entryRoot }: { entryRoot: string }) => {
    await mkdir(join(entryRoot, "payload"));
    await writeFile(join(entryRoot, "payload", "installer.exe"), "complete installer");
    return { complete: true };
  });
  const node = { id: "win.installer", key: "current", outputs: ["payload"], invalidate: async () => null, build };
  const target = join(root, "output");
  return { cache, node, target, materialize: [{ from: "payload", to: target }] };
}

describe("cache publication", () => {
  it.each(["EPERM", "EBUSY", "EACCES"])("publishes the original build after a transient Windows %s lock", async (code) => {
    const { cache, node, target, materialize } = fixture();
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("locked"), { code }));

    await cache.acquire({ node, materialize });
    const hit = await cache.readHit({ node, materialize });

    expect(await readFile(join(target, "installer.exe"), "utf8")).toBe("complete installer");
    expect(node.build).toHaveBeenCalledTimes(1);
    expect(hit?.payloadMetadata.complete).toBe(true);
    expect(cache.report().entries.map((entry) => entry.status)).toEqual(["miss", "hit"]);
    expect(vi.mocked(rename).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(vi.mocked(rename).mock.calls.length).toBeLessThanOrEqual(7);
  });

  it("preserves the original error and exposes no cache hit when Windows locks persist", async () => {
    const { cache, node, materialize } = fixture();
    const error = Object.assign(new Error("first lock"), { code: "EPERM" });
    vi.mocked(rename).mockRejectedValue(Object.assign(new Error("still locked"), { code: "EBUSY" }));
    vi.mocked(rename).mockRejectedValueOnce(error);

    await expect(cache.acquire({ node, materialize })).rejects.toBe(error);

    expect(await cache.readHit({ node, materialize })).toBeNull();
    expect(cache.report().entries).toEqual([]);
    expect(node.build).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(7);
    expect(setTimeout).toHaveBeenCalledTimes(6);
  });

  it.each([
    { platform: "win32", code: "ENOENT" },
    { platform: "linux", code: "EPERM" },
    { platform: "darwin", code: "EBUSY" },
  ])("fails immediately for $code on $platform outside the Windows lock policy", async ({ platform, code }) => {
    const { cache, node, materialize } = fixture();
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
    const error = Object.assign(new Error("rename failed"), { code });
    vi.mocked(rename).mockRejectedValue(error);

    await expect(cache.acquire({ node, materialize })).rejects.toBe(error);

    expect(rename).toHaveBeenCalledTimes(1);
    expect(setTimeout).not.toHaveBeenCalled();
    expect(await cache.readHit({ node, materialize })).toBeNull();
  });
});
