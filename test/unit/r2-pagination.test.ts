import { describe, expect, it, vi } from "vitest";
import { deletePrefix, docxKey, pdfKey } from "../../src/shared/r2";

describe("R2 prefix deletion", () => {
  it("keeps legacy export keys stable and isolates unknown-end date variants", () => {
    expect(pdfKey("vault", "resume", 3)).toBe("vaults/vault/exports/resume-3.pdf");
    expect(docxKey("vault", "resume", 3)).toBe("vaults/vault/exports/resume-3-word1.docx");
    expect(pdfKey("vault", "resume", 3, true)).toBe("vaults/vault/exports/resume-3-dates-v2.pdf");
    expect(docxKey("vault", "resume", 3, true)).toBe("vaults/vault/exports/resume-3-word1-dates-v2.docx");
  });
  it("deletes all pages before reporting completion", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ objects: [{ key: "vaults/v/one" }], truncated: true, cursor: "next" })
      .mockResolvedValueOnce({ objects: [{ key: "vaults/v/two" }], truncated: false })
      .mockResolvedValueOnce({ objects: [], truncated: false });
    const remove = vi.fn();
    const bucket = { list, delete: remove } as unknown as R2Bucket;
    await expect(deletePrefix(bucket, "vaults/v/")).resolves.toBe(2);
    expect(list.mock.calls[1]?.[0].cursor).toBe("next");
    expect(list.mock.calls[2]?.[0]).toEqual({ prefix: "vaults/v/", limit: 1 });
    expect(remove.mock.calls.map(([keys]) => keys)).toEqual([["vaults/v/one"], ["vaults/v/two"]]);
  });

  it("does not report completion when paging over a changing listing leaves a visible object", async () => {
    const keys = ["vaults/v/one", "vaults/v/two"];
    // An offset-style opaque cursor can skip an object after the first page
    // is deleted. A new sweep starts from the beginning and can remove it.
    const list = vi.fn(async ({ cursor }: { cursor?: string }) => {
      const offset = Number(cursor ?? 0);
      const objects = keys.slice(offset, offset + 1).map((key) => ({ key }));
      const truncated = offset + 1 < keys.length;
      return { objects, truncated, ...(truncated ? { cursor: String(offset + 1) } : {}) };
    });
    const remove = vi.fn(async (deleted: string[]) => {
      for (const key of deleted) {
        const index = keys.indexOf(key);
        if (index >= 0) keys.splice(index, 1);
      }
    });
    const bucket = { list, delete: remove } as unknown as R2Bucket;
    await expect(deletePrefix(bucket, "vaults/v/")).rejects.toThrow("r2_prefix_not_empty");
    expect(keys).toEqual(["vaults/v/two"]);
    await expect(deletePrefix(bucket, "vaults/v/")).resolves.toBe(1);
    expect(keys).toEqual([]);
  });

  it.each([
    { objects: [], truncated: true, cursor: "more" },
    { objects: [] },
    { truncated: false },
  ])("does not accept an incomplete fresh listing as proof of an empty prefix", async (confirmation) => {
    const list = vi.fn()
      .mockResolvedValueOnce({ objects: [{ key: "vaults/v/one" }], truncated: false })
      .mockResolvedValueOnce(confirmation);
    const bucket = { list, delete: vi.fn() } as unknown as R2Bucket;
    await expect(deletePrefix(bucket, "vaults/v/")).rejects.toThrow("r2_incomplete_verification");
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
