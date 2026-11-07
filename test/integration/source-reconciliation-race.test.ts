import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";

describe("source status reconciliation", () => {
  it("does not fail a newer source attempt after an old status request returns", async () => {
    const vaultId = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vaultId);
    const who = { userId: "source-reconcile-owner", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.DISTILL;
      let release!: () => void;
      let observed!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { observed = resolve; });
      let creates = 0;
      local.DISTILL = {
        async create() { creates++; return {}; },
        async get() { return { async status() { observed(); await gate; return { status: "terminated" }; } }; },
      } as unknown as Workflow;
      try {
        const { sourceId } = await instance.addSource(who, {
          filename: "resume.pdf", r2Key: `vaults/${vaultId}/sources/test`,
        });
        state.storage.sql.exec(`UPDATE sources SET created_at=1 WHERE id=?`, sourceId);
        const oldRun = state.storage.sql.exec<{ run_id: string }>(`SELECT run_id FROM sources WHERE id=?`, sourceId).one().run_id;
        const listing = instance.listSources(who);
        await ready;
        // Another operation settles the original run, then a user starts a retry
        // while the listing still waits on the original status response.
        await instance.saveSource(sourceId, { state: "failed", error: "Previous attempt failed" }, oldRun);
        const retried = await instance.retryRun(who, oldRun, crypto.randomUUID());
        expect(retried.runId).not.toBe(oldRun);
        release();
        const sources = await listing;
        expect(sources.find((source) => source.id === sourceId)).toMatchObject({ state: "queued", error: null });
        expect(state.storage.sql.exec(`SELECT state,run_id,error FROM sources WHERE id=?`, sourceId).one()).toEqual({ state: "queued", run_id: retried.runId, error: null });
        expect(await instance.runInfo(who, oldRun)).toMatchObject({ state: "failed" });
        expect(await instance.runInfo(who, retried.runId)).toMatchObject({ state: "starting", errorCode: null });
        expect(creates).toBe(2);
      } finally { release(); local.DISTILL = previous; }
    });
  }, 30_000);

  it("does not settle an attempt whose cancellation was requested while status was pending", async () => {
    const vaultId = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vaultId);
    const who = { userId: "source-cancel-reconcile-owner", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.DISTILL;
      let release!: () => void;
      let observed!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { observed = resolve; });
      local.DISTILL = {
        async create() { return {}; },
        async get() { return { async status() { observed(); await gate; return { status: "terminated" }; } }; },
      } as unknown as Workflow;
      try {
        const { sourceId } = await instance.addSource(who, {
          filename: "resume.pdf", r2Key: `vaults/${vaultId}/sources/test`,
        });
        state.storage.sql.exec(`UPDATE sources SET created_at=1 WHERE id=?`, sourceId);
        const runId = state.storage.sql.exec<{ run_id: string }>(`SELECT run_id FROM sources WHERE id=?`, sourceId).one().run_id;
        const listing = instance.listSources(who);
        await ready;
        await instance.cancelSource(who, sourceId);
        release();
        expect((await listing).find((source) => source.id === sourceId)).toMatchObject({ state: "queued", error: null, cancellationPending: true });
        expect(await instance.runInfo(who, runId)).toMatchObject({ state: "cancel_requested" });
      } finally { release(); local.DISTILL = previous; }
    });
  }, 30_000);

  it("settles the matching stopped run and makes it retryable", async () => {
    const vaultId = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vaultId);
    const who = { userId: "source-stopped-owner", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.DISTILL;
      local.DISTILL = {
        async create() { return {}; },
        async get() { return { async status() { return { status: "errored" }; } }; },
      } as unknown as Workflow;
      try {
        const { sourceId } = await instance.addSource(who, {
          filename: "resume.pdf", r2Key: `vaults/${vaultId}/sources/test`,
        });
        state.storage.sql.exec(`UPDATE sources SET created_at=1 WHERE id=?`, sourceId);
        const original = state.storage.sql.exec<{ run_id: string }>(`SELECT run_id FROM sources WHERE id=?`, sourceId).one().run_id;
        expect((await instance.listSources(who)).find((source) => source.id === sourceId)).toMatchObject({ state: "failed" });
        expect(await instance.runInfo(who, original)).toMatchObject({ state: "failed", errorCode: "execution_failed" });
        const retried = await instance.retryRun(who, original, crypto.randomUUID());
        expect(retried.targetId).toBe(sourceId);
        expect(await instance.runInfo(who, retried.runId)).toMatchObject({ state: "starting" });
      } finally { local.DISTILL = previous; }
    });
  });

  it("still reconciles a legacy source without a workflow ID", async () => {
    const vaultId = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vaultId);
    const who = { userId: "source-legacy-owner", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const sourceId = crypto.randomUUID();
      state.storage.sql.exec(`INSERT INTO sources (id, filename, r2_key, state, run_id, created_at) VALUES (?, 'legacy.pdf', ?, 'queued', NULL, 1)`, sourceId, `vaults/${vaultId}/sources/legacy`);
      expect((await instance.listSources(who)).find((source) => source.id === sourceId)).toMatchObject({ state: "failed" });
    });
  });
});
