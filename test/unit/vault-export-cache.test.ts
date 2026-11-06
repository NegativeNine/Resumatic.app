import { describe, expect, it, vi } from "vitest";
import { cachedExport } from "../../src/worker/vault-export-cache";

const who = { userId: "u", gen: 1, epoch: "epoch" };
const text = (value: ArrayBuffer | Uint8Array) => new TextDecoder().decode(value);

describe("Vault export cache routing", () => {
  it("uses historical R2 entries without writing new objects", async () => {
    const vault = { readExportCache: vi.fn(async () => null), putExportCache: vi.fn(async () => true), checkSession: vi.fn(async () => {}) };
    const bucket = { get: vi.fn(async () => ({ arrayBuffer: async () => new TextEncoder().encode("old").buffer })) };
    const render = vi.fn(async () => new TextEncoder().encode("new"));
    expect(text(await cachedExport(vault, bucket as unknown as Pick<R2Bucket, "get">, who, "key", render))).toBe("old");
    expect(render).not.toHaveBeenCalled();
    expect(vault.putExportCache).not.toHaveBeenCalled();
    expect(vault.checkSession).toHaveBeenCalledOnce();
  });

  it("rechecks the session after a cache write failure before returning rendered output", async () => {
    const checkSession = vi.fn(async () => {});
    const vault = { readExportCache: vi.fn(async () => null), putExportCache: vi.fn(async () => { throw new Error("cache unavailable"); }), checkSession };
    const bucket = { get: vi.fn(async () => null) };
    const render = vi.fn(async () => new TextEncoder().encode("new"));
    expect(text(await cachedExport(vault, bucket, who, "key", render))).toBe("new");
    expect(checkSession).toHaveBeenCalledTimes(3);
    checkSession.mockReset().mockResolvedValueOnce().mockRejectedValueOnce(new Error("closed"));
    await expect(cachedExport(vault, bucket, who, "key", render)).rejects.toThrow("closed");
  });

  it("rechecks a failed cache read before attempting legacy data or rendering", async () => {
    const vault = { readExportCache: vi.fn(async () => { throw new Error("cache failure"); }), putExportCache: vi.fn(async () => true), checkSession: vi.fn(async () => { throw new Error("closed"); }) };
    const bucket = { get: vi.fn(async () => null) };
    const render = vi.fn(async () => new TextEncoder().encode("new"));
    await expect(cachedExport(vault, bucket, who, "key", render)).rejects.toThrow("closed");
    expect(bucket.get).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });
});
