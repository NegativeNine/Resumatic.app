import { describe, expect, it, vi } from "vitest";
import { cacheFenceEnabled, putExportCache } from "../../src/worker/cache-write";

const who = { userId: "user", gen: 1 };
const bytes = new Uint8Array([1, 2, 3]);

describe("export cache write dispatch", () => {
  it("keeps the opt-in limited to staging bindings and rejects malformed configuration", () => {
    expect(cacheFenceEnabled({} as Env)).toBe(false);
    expect(cacheFenceEnabled({ R2_CACHE_FENCE_ENABLED: "false" } as Env)).toBe(false);
    expect(cacheFenceEnabled({ R2_CACHE_FENCE_ENABLED: "true", ALLOW_TEST_SIGNIN: "true", PILOT_BUDGET: {} } as Env)).toBe(true);
    expect(() => cacheFenceEnabled({ R2_CACHE_FENCE_ENABLED: "true" } as Env)).toThrow("restricted to staging");
    expect(() => cacheFenceEnabled({ R2_CACHE_FENCE_ENABLED: "yes", ALLOW_TEST_SIGNIN: "true", PILOT_BUDGET: {} } as Env)).toThrow("restricted to staging");
  });
  it("fences before dispatch and settles only an acknowledged put", async () => {
    const order: string[] = [];
    let recorded = "";
    const vault = {
      checkSession: vi.fn(async () => { order.push("check"); }),
      beginCacheWrite: vi.fn(async (_who: typeof who, id: string, kind: string, digest: string) => {
        expect(kind).toBe("pdf");
        expect(digest).toBe("2c70e12b7a0646f92279f427c7b38e7334d8e5389cff167a1dc30e73f826b683");
        recorded = id; order.push("begin");
      }),
      finishCacheWrite: vi.fn(async (_owner: string, id: string) => { expect(id).toBe(recorded); order.push("finish"); }),
    };
    const bucket = { put: vi.fn(async (_key: string, _bytes: unknown, options: R2PutOptions) => {
      expect(options.customMetadata).toEqual({ resumatic_cache_attempt: recorded });
      order.push("put"); return null;
    }) } as unknown as Pick<R2Bucket, "put">;
    await putExportCache(bucket, vault, who, "key", bytes, "pdf", true);
    expect(order).toEqual(["begin", "put", "finish"]);
    expect(vault.finishCacheWrite).toHaveBeenCalledWith(who.userId, recorded);
  });

  it("retains the marker when a put fails with an unknown outcome", async () => {
    const vault = { checkSession: vi.fn(), beginCacheWrite: vi.fn(async () => {}), finishCacheWrite: vi.fn(async () => {}) };
    const bucket = { put: vi.fn(async () => { throw new Error("unknown"); }) } as unknown as Pick<R2Bucket, "put">;
    await expect(putExportCache(bucket, vault, who, "key", bytes, "docx", true)).rejects.toThrow("unknown");
    expect(vault.beginCacheWrite).toHaveBeenCalledOnce();
    expect(vault.finishCacheWrite).not.toHaveBeenCalled();
  });

  it("does not send a put if fencing or the opt-out session check fails", async () => {
    for (const enabled of [false, true]) {
      const vault = {
        checkSession: vi.fn(async () => { throw new Error("closed"); }),
        beginCacheWrite: vi.fn(async () => { throw new Error("closed"); }),
        finishCacheWrite: vi.fn(async () => {}),
      };
      const bucket = { put: vi.fn(async () => null) } as unknown as Pick<R2Bucket, "put">;
      await expect(putExportCache(bucket, vault, who, "key", bytes, "pdf", enabled)).rejects.toThrow("closed");
      expect(bucket.put).not.toHaveBeenCalled();
    }
  });
});
