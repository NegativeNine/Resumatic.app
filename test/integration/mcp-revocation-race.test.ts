import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import type { McpClaims } from "../../src/shared/mcp";
import { vault } from "../../src/shared/stubs";

async function setup() {
  const id = env.VAULT.newUniqueId().toString();
  const stub = vault(env, id);
  const who = { userId: crypto.randomUUID(), gen: 1 };
  await stub.init(who.userId);
  const grant = await stub.createMcpGrant(who, {
    id: crypto.randomUUID(), clientId: "synthetic-client", clientName: "Synthetic client",
    scopes: ["vault:read", "vault:generate"], expiresAt: Date.now() + 60_000,
  });
  const claims: McpClaims = {
    uid: who.userId, vid: id, gen: grant.gen, epoch: grant.epoch,
    grantId: grant.id, clientId: grant.clientId, scopes: grant.scopes, expiresAt: grant.expiresAt,
  };
  await stub.bindMcpGrant(claims, "synthetic-oauth-grant");
  return { stub, who, claims };
}

it("permits an active connected app to start and safely retry a generation", async () => {
  const f = await setup();
  await runInDurableObject(f.stub, async (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const previous = local.TAILOR;
    const create = vi.fn(async () => ({}));
    local.TAILOR = { create } as unknown as Workflow;
    try {
      const { applicationId } = await instance.addApplication(f.who, "An engineering job description with enough detail for a new application.");
      const key = crypto.randomUUID();
      const started = await instance.mcpTailor(f.claims, applicationId, key);
      expect(await instance.mcpTailor(f.claims, applicationId, key)).toEqual(started);
      expect(create).toHaveBeenCalledOnce();
    } finally {
      local.TAILOR = previous;
    }
  });
});

it("does not start a connected-app generation after revocation during reconciliation", async () => {
  const f = await setup();
  await runInDurableObject(f.stub, async (instance, state) => {
    const { applicationId } = await instance.addApplication(f.who, "An engineering job description with enough detail for a new application.");
    let entered!: () => void, release!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const local = instance as unknown as { reconcileStaleRuns(): Promise<void> };
    const reconcile = vi.spyOn(local, "reconcileStaleRuns").mockImplementation(async () => { entered(); await held; });
    let running: Promise<unknown> | undefined;
    try {
      running = instance.mcpTailor(f.claims, applicationId, crypto.randomUUID());
      await paused;
      await instance.revokeMcpGrant(f.who, f.claims.grantId);
      release();
      await expect(running).rejects.toThrow("connected app access is no longer valid");
      expect(state.storage.sql.exec(`SELECT id FROM resumes`).toArray()).toHaveLength(0);
      expect(state.storage.sql.exec(`SELECT id FROM runs WHERE kind='tailor'`).toArray()).toHaveLength(0);
    } finally {
      release();
      await running?.catch(() => {});
      reconcile.mockRestore();
    }
  });
});

it.each(["resume", "render"] as const)("does not disclose a resume after revocation during %s lookup", async (phase) => {
  const f = await setup();
  await runInDurableObject(f.stub, async (instance) => {
    let entered!: () => void, release!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const get = vi.spyOn(instance, "getResume").mockImplementation(async () => {
      if (phase === "resume") { entered(); await held; }
      return { id: "resume", state: "ready", version: 1 } as Awaited<ReturnType<typeof instance.getResume>>;
    });
    const render = vi.spyOn(instance, "renderData").mockImplementation(async () => {
      if (phase === "render") { entered(); await held; }
      return { body: { sections: [] } } as unknown as Awaited<ReturnType<typeof instance.renderData>>;
    });
    let running: Promise<unknown> | undefined;
    try {
      running = instance.mcpResume(f.claims, crypto.randomUUID());
      await paused;
      await instance.revokeMcpGrant(f.who, f.claims.grantId);
      release();
      await expect(running).rejects.toThrow("connected app access is no longer valid");
      if (phase === "resume") expect(render).not.toHaveBeenCalled();
    } finally {
      release();
      await running?.catch(() => {});
      get.mockRestore();
      render.mockRestore();
    }
  });
});
