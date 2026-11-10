import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { McpClaims, McpScope } from "../../src/shared/mcp";
import { vault } from "../../src/shared/stubs";

const POSTING = "Platform Engineer at Litware. Run our Kubernetes fleet and build the tools product teams ship with.";
const LINK = "https://jobs.example.com/litware/platform-engineer";

async function setup(scopes: McpScope[]) {
  const id = env.VAULT.newUniqueId().toString();
  const stub = vault(env, id);
  const who = { userId: crypto.randomUUID(), gen: 1 };
  await stub.init(who.userId);
  const grant = await stub.createMcpGrant(who, {
    id: crypto.randomUUID(), clientId: "synthetic-client", clientName: "Synthetic client",
    scopes, expiresAt: Date.now() + 60_000,
  });
  const claims: McpClaims = {
    uid: who.userId, vid: id, gen: grant.gen, epoch: grant.epoch,
    grantId: grant.id, clientId: grant.clientId, scopes: grant.scopes, expiresAt: grant.expiresAt,
  };
  await stub.bindMcpGrant(claims, "synthetic-oauth-grant");
  return { stub, who, claims };
}

type Job = { id: string; title: string | null; company: string | null; excerpt: string; url: string | null; status: string; addedAt: number; resumes: { id: string; state: string; createdAt: number }[] };

describe("connected apps and jobs", () => {
  it("adds a job once, however often the request is retried, and lists it without private notes", async () => {
    const f = await setup(["vault:read", "vault:jobs"]);
    await runInDurableObject(f.stub, async (instance, state) => {
      const key = crypto.randomUUID();
      const added = await instance.mcpAddJob(f.claims, { description: POSTING, url: LINK }, key);
      expect(added).toMatchObject({ alreadySaved: false });
      // A retry of the same request gets the same answer.
      expect(await instance.mcpAddJob(f.claims, { description: POSTING, url: LINK }, key)).toEqual(added);
      // So does another request for the same posting.
      expect(await instance.mcpAddJob(f.claims, { description: `  ${POSTING}\n`, url: null }, crypto.randomUUID())).toEqual({ id: added.id, alreadySaved: true });
      state.storage.sql.exec(`UPDATE applications SET notes = 'Recruiter: Dana. Private.', status = 'applied' WHERE id = ?`, added.id);
      state.storage.sql.exec(`INSERT INTO resumes (id, application_id, state, created_at) VALUES ('resume-1', ?, 'ready', 5)`, added.id);
      const jobs = (await instance.mcpJobs(f.claims, {})) as Job[];
      expect(jobs).toEqual([{
        id: added.id, title: null, company: null, excerpt: POSTING, url: LINK, status: "applied",
        addedAt: expect.any(Number), resumes: [{ id: "resume-1", state: "ready", createdAt: 5 }],
      }]);
      expect(JSON.stringify(jobs)).not.toContain("Recruiter");
      expect(state.storage.sql.exec(`SELECT id FROM applications`).toArray()).toHaveLength(1);
    });
  });

  it("limits the list, newest first", async () => {
    const f = await setup(["vault:read", "vault:jobs"]);
    await runInDurableObject(f.stub, async (instance, state) => {
      for (let i = 0; i < 3; i++) {
        const { id } = await instance.mcpAddJob(f.claims, { description: `${POSTING} Opening number ${i}.`, url: null }, crypto.randomUUID());
        state.storage.sql.exec(`UPDATE applications SET created_at = ? WHERE id = ?`, 100 + i, id);
      }
      const jobs = (await instance.mcpJobs(f.claims, { limit: 2 })) as Job[];
      expect(jobs.map((job) => job.addedAt)).toEqual([102, 101]);
    });
  });

  it("needs the jobs permission: reading facts or generating doesn't grant it", async () => {
    const f = await setup(["vault:read", "vault:generate"]);
    await runInDurableObject(f.stub, async (instance, state) => {
      await expect(instance.mcpJobs(f.claims, {})).rejects.toThrow("connected app permission is required");
      await expect(instance.mcpAddJob(f.claims, { description: POSTING, url: null }, crypto.randomUUID())).rejects.toThrow("connected app permission is required");
      // Claims that say more than the grant holds are refused too.
      const forged = { ...f.claims, scopes: [...f.claims.scopes, "vault:jobs"] as McpScope[] };
      await expect(instance.mcpJobs(forged, {})).rejects.toThrow("forbidden");
      expect(state.storage.sql.exec(`SELECT id FROM applications`).toArray()).toHaveLength(0);
    });
  });

  it("stops at once when access is revoked", async () => {
    const f = await setup(["vault:read", "vault:jobs"]);
    await runInDurableObject(f.stub, async (instance, state) => {
      await instance.revokeMcpGrant(f.who, f.claims.grantId);
      await expect(instance.mcpJobs(f.claims, {})).rejects.toThrow();
      await expect(instance.mcpAddJob(f.claims, { description: POSTING, url: null }, crypto.randomUUID())).rejects.toThrow();
      expect(state.storage.sql.exec(`SELECT id FROM applications`).toArray()).toHaveLength(0);
    });
  });

  it("refuses a link that isn't a web address", async () => {
    const f = await setup(["vault:read", "vault:jobs"]);
    await runInDurableObject(f.stub, async (instance, state) => {
      await expect(instance.mcpAddJob(f.claims, { description: POSTING, url: "javascript:alert(1)" }, crypto.randomUUID())).rejects.toThrow();
      expect(state.storage.sql.exec(`SELECT id FROM applications`).toArray()).toHaveLength(0);
    });
  });
});
