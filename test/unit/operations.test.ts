import { describe, expect, it } from "vitest";
import {
  contentDigest,
  directoryNameForUser,
  identityShard,
  isMaintenanceFenced,
  requireMaintenanceFence,
  shardedUserId,
} from "../../src/shared/operations";

describe("maintenance configuration", () => {
  it("requires an explicit external fence for the exact vault", () => {
    expect(() => requireMaintenanceFence("vault-a", undefined)).toThrow(
      "fenced",
    );
    expect(() =>
      requireMaintenanceFence("vault-a", "vault-ab,vault-b"),
    ).toThrow("fenced");
    expect(() =>
      requireMaintenanceFence("vault-a", " vault-b, vault-a "),
    ).not.toThrow();
    expect(isMaintenanceFenced("ab".repeat(32), ` ${"AB".repeat(32)} `)).toBe(true);
    expect(isMaintenanceFenced("ab".repeat(32), `${"AB".repeat(32)}0`)).toBe(false);
    expect(isMaintenanceFenced("", ", ")).toBe(false);
  });

  it("routes legacy accounts to the existing Directory and keeps assigned homes stable", async () => {
    const uuid = "f7a7728c-423c-4d4d-9a94-c33fc8374f2a";
    expect(directoryNameForUser(uuid)).toBe("global");
    const shard = await identityShard("google", "provider-subject");
    expect(await identityShard("google", "provider-subject")).toBe(shard);
    expect(directoryNameForUser(shardedUserId(shard, uuid))).toBe(
      `directory-${shard}`,
    );
    expect(() => directoryNameForUser(`s99:${uuid}`)).toThrow("invalid");
    expect(() => directoryNameForUser("s1:not-a-uuid")).toThrow("invalid");
    expect(() => shardedUserId(16)).toThrow("invalid");
  });

  it("detects a changed transfer payload", async () => {
    const first = await contentDigest({ text: "original", count: 1 });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await contentDigest({ text: "original", count: 1 })).toBe(first);
    expect(await contentDigest({ text: "changed", count: 1 })).not.toBe(first);
  });
});
