import { describe, expect, it, vi } from "vitest";
import { correlateCacheWrites } from "../../src/worker/cache-correlation";
import { sha256 } from "../../src/worker/crypto";

const vid = "a".repeat(64);
const prefix = `vaults/${vid}/exports/`;
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const digest = async (key: string) => Array.from(new Uint8Array(await sha256(key)), (v) => v.toString(16).padStart(2, "0")).join("");
const marker = (index: number, keyDigest: string | null) => ({ id: uuid(index), kind: "pdf", createdAt: 1, keyDigest });
const bucket = (list: unknown, head: unknown) => ({ list, head } as unknown as Pick<R2Bucket, "list" | "head">);

describe("cache-write correlation", () => {
  it("reports only opaque hints while retaining every marker", async () => {
    const key = `${prefix}private-resume.pdf`;
    const hash = await digest(key);
    const list = vi.fn(async () => ({ objects: [{ key }], truncated: false }));
    const head = vi.fn(async () => ({ key, customMetadata: { resumatic_cache_attempt: uuid(1), other: "private-career-text" } }));
    const snapshot = { status: "available" as const, total: 3, attempts: [marker(1, hash), marker(2, hash), marker(3, null)] };
    const report = await correlateCacheWrites(bucket(list, head), vid, snapshot);
    expect(report).toMatchObject({ status: "pending", scan: "exhausted", scanned: 1, total: 3, omitted: 0 });
    expect(report.observations.map((item) => item.observation)).toEqual(["current-match", "current-other", "no-digest"]);
    expect(list).toHaveBeenCalledWith({ prefix, limit: 100, cursor: undefined });
    expect(head).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain("private-resume");
    expect(JSON.stringify(report)).not.toContain("private-career-text");
    expect(snapshot.attempts).toHaveLength(3);
  });

  it("bounds pagination and labels a non-observation as non-final", async () => {
    const list = vi.fn(async ({ cursor }: { cursor?: string }) => ({
      objects: Array.from({ length: 100 }, (_, i) => ({ key: `${prefix}${cursor ?? "first"}-${i}` })),
      truncated: true, cursor: cursor ? "third" : "second",
    }));
    const head = vi.fn();
    const report = await correlateCacheWrites(bucket(list, head), vid, { status: "available", total: 1, attempts: [marker(1, await digest(`${prefix}unseen`))] });
    expect(report).toMatchObject({ status: "pending", scan: "limited", scanned: 200, observations: [{ observation: "not-observed" }] });
    expect(list).toHaveBeenCalledTimes(2);
    expect(head).not.toHaveBeenCalled();
  });

  it("never calls a malformed or failed listing complete", async () => {
    const hash = await digest(`${prefix}one`);
    for (const list of [
      vi.fn(async () => { throw new Error("provider detail must not leak"); }),
      vi.fn(async () => ({ objects: [{ key: "other-prefix/private" }], truncated: false })),
      vi.fn(async () => ({ objects: [], truncated: true })),
    ]) {
      const head = vi.fn();
      const report = await correlateCacheWrites(bucket(list, head), vid, { status: "available", total: 1, attempts: [marker(1, hash)] });
      expect(report).toMatchObject({ status: "pending", scan: "unavailable", observations: [{ observation: "not-observed" }] });
      expect(head).not.toHaveBeenCalled();
      expect(JSON.stringify(report)).not.toContain("provider detail");
      expect(JSON.stringify(report)).not.toContain("other-prefix");
    }
  });

  it("stops at a repeated continuation cursor", async () => {
    const list = vi.fn(async () => ({ objects: [], truncated: true, cursor: "same" }));
    const head = vi.fn();
    const report = await correlateCacheWrites(bucket(list, head), vid, {
      status: "available", total: 1, attempts: [marker(1, await digest(`${prefix}unseen`))],
    });
    expect(report).toMatchObject({ status: "pending", scan: "unavailable", observations: [{ observation: "not-observed" }] });
    expect(list).toHaveBeenCalledTimes(2);
    expect(head).not.toHaveBeenCalled();
  });

  it("caps head requests and reports individual head failures without releasing anything", async () => {
    const keys = Array.from({ length: 18 }, (_, i) => `${prefix}file-${i}`);
    const attempts = await Promise.all(keys.map(async (key, i) => marker(i + 1, await digest(key))));
    const list = vi.fn(async () => ({ objects: keys.map((key) => ({ key })), truncated: false }));
    const head = vi.fn(async (key: string) => {
      if (key === keys[0]) throw new Error("private provider error");
      return { key, customMetadata: { resumatic_cache_attempt: "unrelated" } };
    });
    const report = await correlateCacheWrites(bucket(list, head), vid, { status: "available", total: attempts.length, attempts });
    expect(report.status).toBe("pending");
    expect(head).toHaveBeenCalledTimes(16);
    expect(report.observations[0]!.observation).toBe("head-unavailable");
    expect(report.observations.slice(16).map((item) => item.observation)).toEqual(["head-limit", "head-limit"]);
    expect(JSON.stringify(report)).not.toContain("private provider error");
  });

  it("performs no storage reads for unavailable, empty or corrupt fence snapshots", async () => {
    const list = vi.fn();
    const head = vi.fn();
    for (const snapshot of [
      { status: "unavailable" as const },
      { status: "available" as const, total: 0, attempts: [] },
      { status: "available" as const, total: 1, attempts: [{ ...marker(1, null), kind: "private-text" }] },
      { status: "available" as const, total: 2, attempts: [marker(1, null), marker(1, null)] },
    ]) {
      const report = await correlateCacheWrites(bucket(list, head), vid, snapshot);
      expect(report).toMatchObject({ status: "pending", scan: "not-scanned", observations: [] });
      expect(JSON.stringify(report)).not.toContain("private-text");
    }
    expect(list).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
  });
});
