import { describe, expect, it, vi } from "vitest";
import { deletionFenceReport } from "../../src/worker/deletion-fences";

const operation = "00000000-0000-4000-8000-000000000001";
const mappings = (token = `account:${operation}:deleting`) => [
  { status: "matched" as const, token, initializationPending: true },
  ...Array.from({ length: 16 }, () => ({ status: "absent" as const })),
];
const snapshot = () => ({
  status: "available" as const,
  workflow: { dispatches: { ids: [], truncated: false }, redispatches: { ids: [], truncated: false } },
  r2: { sourceWrites: { count: 0, truncated: false }, otherWrites: { count: 0, truncated: false } },
  billing: { customerCreation: "absent" as const, checkoutCreation: "absent" as const },
});

describe("deletion fence diagnostic", () => {
  it("returns a non-authoritative snapshot even when every observed count is zero", async () => {
    const result = await deletionFenceReport(async () => mappings(), async () => snapshot());
    expect(result).toMatchObject({ status: "pending", complete: false, scope: "observed_current_fences_only", directory: { initializationPending: true } });
    expect(result.limitations).toContain("provider_operations_and_retention");
    expect(JSON.stringify(result)).not.toContain(operation);
  });

  it("refuses an ABA incarnation change or lifecycle transition after the Vault read", async () => {
    for (const after of [
      mappings("account:00000000-0000-4000-8000-000000000002:deleting"),
      mappings(`account:${operation}:swept`),
    ]) {
      const read = vi.fn().mockResolvedValueOnce(mappings()).mockResolvedValueOnce(after);
      await expect(deletionFenceReport(read, async () => snapshot())).rejects.toThrow(/mapping changed/);
    }
  });

  it("refuses missing, ambiguous, unavailable, malformed or cross-directory mappings", async () => {
    const absent = Array.from({ length: 17 }, () => ({ status: "absent" as const }));
    const ambiguous = mappings();
    ambiguous[1] = { status: "matched", token: `account:${operation}:deleting`, initializationPending: false };
    const moved = vi.fn().mockResolvedValueOnce(mappings()).mockResolvedValueOnce([
      { status: "absent" }, { status: "matched", token: `account:${operation}:deleting`, initializationPending: true },
      ...Array.from({ length: 15 }, () => ({ status: "absent" })),
    ]);
    for (const bad of [absent, ambiguous, mappings("account:not-a-uuid:deleting"), [{ status: "unavailable" }, ...absent.slice(1)]]) {
      const readVault = vi.fn(async () => snapshot());
      await expect(deletionFenceReport(async () => bad as never, readVault)).rejects.toThrow(/mapping is unavailable/);
      expect(readVault).not.toHaveBeenCalled();
    }
    await expect(deletionFenceReport(moved, async () => snapshot())).rejects.toThrow(/mapping changed/);
  });

  it("does not return malformed Vault data or raw RPC error contents", async () => {
    const invalid = { ...snapshot(), workflow: { ...snapshot().workflow, dispatches: { ids: ["private-career-text"], truncated: false } } };
    await expect(deletionFenceReport(async () => mappings(), async () => invalid)).rejects.toThrow(/diagnostic is unavailable/);
    await expect(deletionFenceReport(async () => mappings(), async () => { throw new Error("private-career-text"); })).rejects.toThrow("deletion diagnostic is unavailable");
  });
});
