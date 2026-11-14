import { describe, expect, it, vi } from "vitest";
import { cachedExport, snapshotCacheKey } from "../../src/worker/vault-export-cache";
import type { RenderData } from "../../src/shared/types";

const who = { userId: "u", gen: 1, epoch: "epoch" };
const text = (value: ArrayBuffer | Uint8Array) => new TextDecoder().decode(value);

describe("Vault export cache routing", () => {
  it("refuses changed publication authority before using any cached bytes", async () => {
    const vault = { readExportCache: vi.fn(async () => new Uint8Array([1])), putExportCache: vi.fn(async () => true), checkSession: vi.fn(async () => {}) };
    const render = vi.fn(async () => new Uint8Array([2]));
    await expect(cachedExport(() => vault, who, "key", render, async () => { throw Error("private"); })).rejects.toThrow("private");
    expect(vault.readExportCache).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
  });

  it("refuses privacy changes during rendering before storing or returning bytes", async () => {
    let privateNow = false;
    const vault = { readExportCache: vi.fn(async () => null), putExportCache: vi.fn(async () => true), checkSession: vi.fn(async () => {}) };
    const authorize = async () => { if (privateNow) throw Error("private"); };
    await expect(cachedExport(() => vault, who, "key", async () => { privateNow = true; return new Uint8Array([1]); }, authorize)).rejects.toThrow("private");
    expect(vault.putExportCache).not.toHaveBeenCalled();
  });

  it("rechecks publication authority after successful cache writes and cache hits", async () => {
    for (const hit of [false, true]) {
      let privateNow = false;
      const vault = { readExportCache: async () => { if (hit) privateNow = true; return hit ? new Uint8Array([1]) : null; },
        putExportCache: async () => { privateNow = true; return true; }, checkSession: async () => {} };
      await expect(cachedExport(() => vault, who, "key", async () => new Uint8Array([2]), async () => { if (privateNow) throw Error("private"); })).rejects.toThrow("private");
    }
  });

  it("renders fresh when the snapshot-bound cache is empty", async () => {
    const vault = { readExportCache: vi.fn(async () => null), putExportCache: vi.fn(async () => true), checkSession: vi.fn(async () => {}) };
    const render = vi.fn(async () => new TextEncoder().encode("new"));
    expect(text(await cachedExport(() => vault, who, "key", render, async () => {}))).toBe("new");
    expect(render).toHaveBeenCalledOnce();
    expect(vault.putExportCache).toHaveBeenCalledOnce();
    expect(vault.checkSession).toHaveBeenCalledTimes(2);
  });

  it("rechecks the session after a cache write failure before returning rendered output", async () => {
    const checkSession = vi.fn(async () => {});
    const vault = { readExportCache: vi.fn(async () => null), putExportCache: vi.fn(async () => { throw new Error("cache unavailable"); }), checkSession };
    const render = vi.fn(async () => new TextEncoder().encode("new"));
    expect(text(await cachedExport(() => vault, who, "key", render, async () => {}))).toBe("new");
    expect(checkSession).toHaveBeenCalledTimes(3);
    checkSession.mockReset().mockResolvedValueOnce().mockRejectedValueOnce(new Error("closed"));
    await expect(cachedExport(() => vault, who, "key", render, async () => {})).rejects.toThrow("closed");
  });

  it("rechecks a failed cache read before rendering", async () => {
    const vault = { readExportCache: vi.fn(async () => { throw new Error("cache failure"); }), putExportCache: vi.fn(async () => true), checkSession: vi.fn(async () => { throw new Error("closed"); }) };
    const render = vi.fn(async () => new TextEncoder().encode("new"));
    await expect(cachedExport(() => vault, who, "key", render, async () => {})).rejects.toThrow("closed");
    expect(render).not.toHaveBeenCalled();
  });

  it("recreates a broken stub after a cache read fails before regenerating", async () => {
    let stubs = 0;
    const check = vi.fn(async () => {});
    const fresh = () => {
      stubs++;
      let broken = false;
      return {
        readExportCache: async () => { broken = true; throw new Error("old cache RPC unavailable"); },
        putExportCache: async () => true,
        checkSession: async () => { if (broken) throw new Error("broken stub"); await check(); },
      };
    };
    const render = vi.fn(async () => new TextEncoder().encode("new"));
    expect(text(await cachedExport(fresh, who, "key", render, async () => {}))).toBe("new");
    expect(stubs).toBeGreaterThanOrEqual(2);
    expect(check).toHaveBeenCalledTimes(3);
    expect(render).toHaveBeenCalledOnce();
  });

  it("binds the cache key to the complete render snapshot and format", async () => {
    const data = { profile: { name: "Avery", email: "a@example.test", phone: "", location: "", links: [] },
      company: "Example", title: "Engineer", version: 1,
      body: { summary: null, sections: [], skills: ["TypeScript"] } } as RenderData;
    const base = "vaults/v/exports/r-1.pdf";
    const first = await snapshotCacheKey(base, data);
    expect(first).toMatch(/^vaults\/v\/exports\/r-1-snapshot-v3-[a-f0-9]{64}\.pdf$/);
    expect(await snapshotCacheKey(base, structuredClone(data))).toBe(first);
    expect(await snapshotCacheKey(base, { ...data, profile: { ...data.profile, name: "Blair" } })).not.toBe(first);
    expect(await snapshotCacheKey(base, { ...data, body: { ...data.body, skills: ["Go"] } })).not.toBe(first);
    expect(await snapshotCacheKey("vaults/v/exports/r-1.docx", data)).not.toBe(first);
  });

  it("supports an older Vault without cache methods without reusing a broken stub or retrying a write", async () => {
    const check = vi.fn(async () => {});
    const write = vi.fn(async () => { throw new Error("method unavailable"); });
    let stubs = 0;
    const fresh = () => {
      stubs++;
      let broken = false;
      return {
        readExportCache: async () => { broken = true; throw new Error("method unavailable"); },
        putExportCache: async () => { broken = true; return write(); },
        checkSession: async () => { if (broken) throw new Error("broken stub"); await check(); },
      };
    };
    const render = vi.fn(async () => new TextEncoder().encode("new"));
    expect(text(await cachedExport(fresh, who, "key", render, async () => {}))).toBe("new");
    expect(render).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledTimes(4);
    expect(stubs).toBeGreaterThanOrEqual(3);
  });

  it("fails closed when a session recheck fails, without retrying it", async () => {
    const check = vi.fn(async () => { throw new Error("closed"); });
    const fresh = () => ({
      readExportCache: async () => new TextEncoder().encode("cached"),
      putExportCache: vi.fn(async () => true),
      checkSession: check,
    });
    const render = vi.fn(async () => new TextEncoder().encode("new"));
    await expect(cachedExport(fresh, who, "key", render, async () => {})).rejects.toThrow("closed");
    expect(check).toHaveBeenCalledOnce();
    expect(render).not.toHaveBeenCalled();
  });
});
