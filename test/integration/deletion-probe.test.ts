import { describe, expect, it } from "vitest";
import { maintenance } from "../../src/worker/maintenance";

describe("deletion Workflow probe", () => {
  it.each([
    [Object.assign(new Error("workflow.not_found"), { code: 10200 }), null],
    [Object.assign(new Error("missing"), { status: 404 }), null],
    [new Error("instance.not_found"), 0],
  ])("only treats explicit instance absence as zero remaining", async (failure, expected) => {
    const mock = {
      DIRECTORY: {
        idFromName: (name: string) => name,
        get: () => ({ deletionProbe: async () => 0 }),
      },
      VAULT: {
        idFromString: (id: string) => id,
        get: () => ({ deletionProbe: async () => ({ rows: 0 }) }),
      },
      FILES: { list: async () => ({ objects: [], truncated: false }) },
      DISTILL: { get: async () => { throw failure; } },
    } as unknown as Env;
    const response = await maintenance.request(`/deletion-audits/${"a".repeat(64)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "synthetic", sources: [crypto.randomUUID()], resumes: [] }),
    }, mock);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      activeRuns: expected,
      workflowCoverage: { complete: false, scope: "supplied_ids_only" },
    });
  });

  it("does not report an empty prefix when R2 omits a required continuation", async () => {
    const mock = {
      DIRECTORY: { idFromName: (name: string) => name, get: () => ({ deletionProbe: async () => 0 }) },
      VAULT: { idFromString: (id: string) => id, get: () => ({ deletionProbe: async () => ({ rows: 0 }) }) },
      FILES: { list: async () => ({ objects: [], truncated: true, cursor: "" }) },
    } as unknown as Env;
    const response = await maintenance.request(`/deletion-audits/${"a".repeat(64)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "synthetic", sources: [], resumes: [] }),
    }, mock);
    expect(response.status).toBe(500);
  });

  it("normalizes uppercase vault IDs before probing the Directory, Vault and R2", async () => {
    const canonical = "ab".repeat(32);
    const directoryIds: string[] = [];
    const vaultIds: string[] = [];
    const prefixes: string[] = [];
    const mock = {
      DIRECTORY: {
        idFromName: (name: string) => name,
        get: () => ({ deletionProbe: async (_userId: string, vaultId: string) => { directoryIds.push(vaultId); return 0; } }),
      },
      VAULT: {
        idFromString: (vaultId: string) => { vaultIds.push(vaultId); return vaultId; },
        get: () => ({ deletionProbe: async () => ({ rows: 0 }) }),
      },
      FILES: {
        list: async ({ prefix }: { prefix: string }) => {
          prefixes.push(prefix);
          return { objects: prefix === `vaults/${canonical}/` ? [{ key: `${prefix}exports/resume.pdf` }] : [], truncated: false };
        },
      },
    } as unknown as Env;
    const response = await maintenance.request(`/deletion-audits/${canonical.toUpperCase()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "synthetic", sources: [], resumes: [] }),
    }, mock);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ vaultId: canonical, r2Objects: 1 });
    expect(prefixes).toEqual([`vaults/${canonical}/`]);
    expect(vaultIds).toEqual([canonical]);
    expect(directoryIds.length).toBeGreaterThan(0);
    expect(directoryIds.every((value) => value === canonical)).toBe(true);
  });
});
