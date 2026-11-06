import { describe, expect, it, vi } from "vitest";
import { deletePrefix } from "../../src/shared/r2";

describe("R2 prefix deletion", () => {
  it("deletes all pages before reporting completion", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ objects: [{ key: "vaults/v/one" }], truncated: true, cursor: "next" })
      .mockResolvedValueOnce({ objects: [{ key: "vaults/v/two" }], truncated: false });
    const remove = vi.fn();
    const bucket = { list, delete: remove } as unknown as R2Bucket;
    await expect(deletePrefix(bucket, "vaults/v/")).resolves.toBe(2);
    expect(list.mock.calls[1]?.[0].cursor).toBe("next");
    expect(remove.mock.calls.map(([keys]) => keys)).toEqual([["vaults/v/one"], ["vaults/v/two"]]);
  });

  it.each([undefined, ""])("fails closed on a missing truncated-page cursor", async (cursor) => {
    const bucket = { list: vi.fn().mockResolvedValue({ objects: [], truncated: true, cursor }), delete: vi.fn() } as unknown as R2Bucket;
    await expect(deletePrefix(bucket, "vaults/v/")).rejects.toThrow("r2_incomplete_pagination");
  });

  it("fails rather than loop or claim success on a repeated cursor", async () => {
    const list = vi.fn().mockResolvedValue({ objects: [], truncated: true, cursor: "same" });
    const bucket = { list, delete: vi.fn() } as unknown as R2Bucket;
    await expect(deletePrefix(bucket, "vaults/v/")).rejects.toThrow("r2_incomplete_pagination");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("rejects a page with no truncation indicator", async () => {
    const bucket = { list: vi.fn().mockResolvedValue({ objects: [] }), delete: vi.fn() } as unknown as R2Bucket;
    await expect(deletePrefix(bucket, "vaults/v/")).rejects.toThrow("r2_incomplete_pagination");
  });
});
