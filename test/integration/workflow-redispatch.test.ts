import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { vault } from "../../src/shared/stubs";

describe("uncertain Workflow redispatch", () => {
  it("keeps both fences if the original acknowledgement races a held same-ID retry", async () => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    const who = { userId: "redispatch-race", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.DISTILL;
      let releaseOriginal!: () => void, releaseRetry!: () => void;
      let enteredOriginal!: () => void, enteredRetry!: () => void;
      const originalHeld = new Promise<void>((resolve) => { releaseOriginal = resolve; });
      const retryHeld = new Promise<void>((resolve) => { releaseRetry = resolve; });
      const originalStarted = new Promise<void>((resolve) => { enteredOriginal = resolve; });
      const retryStarted = new Promise<void>((resolve) => { enteredRetry = resolve; });
      const calls: unknown[] = [];
      local.DISTILL = {
        async create(input: unknown) {
          calls.push(input);
          if (calls.length === 1) { enteredOriginal(); await originalHeld; }
          else { enteredRetry(); await retryHeld; }
          return {};
        },
        async get() { throw new Error("instance.not_found"); },
      } as unknown as Workflow;
      const add = instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${vid}/sources/file` });
      let alarm: Promise<void> | undefined;
      try {
        await originalStarted;
        expect(await state.storage.getAlarm()).not.toBeNull();
        alarm = instance.alarm();
        await retryStarted;
        expect(calls).toHaveLength(2);
        expect(calls[1]).toEqual(calls[0]);
        const row = state.storage.sql.exec<{ run_id: string; attempts: number }>(`SELECT run_id, attempts FROM workflow_redispatches`).one();
        expect(row.attempts).toBe(1);
        // Simulate an old deployment's unconditional successful-create cleanup.
        state.storage.sql.exec(`DELETE FROM workflow_dispatches WHERE run_id = ?`, row.run_id);
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches WHERE run_id = ?`, row.run_id).toArray()).toHaveLength(1);
        releaseOriginal();
        await add;
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches WHERE run_id = ?`, row.run_id).toArray()).toHaveLength(1);
        await expect(instance.close()).rejects.toThrow(/workflow creation is unresolved/);
        await expect(instance.destroy()).rejects.toThrow(/workflow creation is unresolved/);
        releaseRetry();
        await alarm;
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_redispatches WHERE run_id = ?`, row.run_id).toArray()).toHaveLength(1);
        await expect(instance.close()).rejects.toThrow(/workflow creation is unresolved/);
      } finally {
        releaseOriginal();
        releaseRetry();
        await add.catch(() => {});
        await alarm?.catch(() => {});
        local.DISTILL = previous;
      }
    });
  });

  it("bounds same-ID retries, keeps the sticky fence on errors, and survives eviction", async () => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    const who = { userId: "redispatch-limit", gen: 1 };
    await stub.init(who.userId);
    const runId = await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.DISTILL;
      const calls: unknown[] = [];
      local.DISTILL = {
        async create(input: unknown) { calls.push(input); throw new Error("unknown create outcome"); },
        async get() { throw new Error("instance.not_found"); },
      } as unknown as Workflow;
      try {
        const { sourceId } = await instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${vid}/sources/file` });
        await instance.alarm();
        await instance.alarm();
        expect(calls).toHaveLength(2); // backoff prevents an immediate second retry
        for (let i = 0; i < 6; i++) {
          state.storage.sql.exec(`UPDATE workflow_redispatches SET next_at = 0 WHERE run_id = ?`, sourceId);
          await instance.alarm();
        }
        expect(calls).toHaveLength(4); // original + three bounded retries
        expect(calls.every((call) => JSON.stringify(call) === JSON.stringify(calls[0]))).toBe(true);
        expect(state.storage.sql.exec<{ attempts: number }>(`SELECT attempts FROM workflow_redispatches WHERE run_id = ?`, sourceId).one().attempts).toBe(3);
        return sourceId;
      } finally { local.DISTILL = previous; }
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      expect(state.storage.sql.exec(`SELECT run_id FROM workflow_redispatches WHERE run_id = ?`, runId).toArray()).toHaveLength(1);
      await expect(instance.close()).rejects.toThrow(/workflow creation is unresolved/);
    });
  });

  it("can let the same run claim after retry without lifting its deletion fence", async () => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    const who = { userId: "redispatch-claim", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.DISTILL;
      let calls = 0;
      local.DISTILL = {
        async create(input: { id: string; params: { sourceId: string } }) {
          calls++;
          if (calls === 1) throw new Error("unknown create outcome");
          await instance.claimRun(input.id, { kind: "distill", targetId: input.params.sourceId });
          return {};
        },
        async get() { throw new Error("instance.not_found"); },
      } as unknown as Workflow;
      try {
        const { sourceId } = await instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${vid}/sources/file` });
        expect((await instance.listSources(who))[0]?.dispatchUncertain).toBe(true);
        await instance.alarm();
        expect(calls).toBe(2);
        expect((await instance.runInfo(who, sourceId)).state).toBe("running");
        expect((await instance.listSources(who))[0]?.dispatchUncertain).toBe(false);
        await instance.alarm();
        expect(calls).toBe(2);
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_redispatches WHERE run_id = ?`, sourceId).toArray()).toHaveLength(1);
        await expect(instance.close()).rejects.toThrow(/workflow creation is unresolved/);
      } finally { local.DISTILL = previous; }
    });
  });

  it.each(["cancel", "close", "maintenance"] as const)("does not issue a retry when %s occurs during scheduling", async (action) => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    const who = { userId: `redispatch-${action}`, gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.DISTILL;
      let calls = 0, entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      local.DISTILL = { async create() { calls++; throw new Error("unknown"); } } as unknown as Workflow;
      const internal = instance as unknown as { scheduleRunAlarm(at: number): Promise<void>; redispatchUncertain(id: string): Promise<void> };
      const schedule = internal.scheduleRunAlarm;
      const oldFence = local.RESTORE_FENCE_IDS;
      let retry: Promise<void> | undefined;
      try {
        const { sourceId } = await instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${vid}/sources/file` });
        internal.scheduleRunAlarm = async () => { entered(); await held; };
        retry = internal.redispatchUncertain(sourceId);
        await started;
        if (action === "cancel") await instance.cancelRun(who, sourceId);
        if (action === "close") await expect(instance.close()).rejects.toThrow(/workflow creation is unresolved/);
        if (action === "maintenance") local.RESTORE_FENCE_IDS = vid;
        release();
        await retry;
        expect(calls).toBe(1);
        expect(state.storage.sql.exec<{ attempts: number }>(`SELECT attempts FROM workflow_redispatches WHERE run_id = ?`, sourceId).one().attempts).toBe(0);
      } finally {
        release();
        await retry?.catch(() => {});
        internal.scheduleRunAlarm = schedule;
        local.RESTORE_FENCE_IDS = oldFence;
        local.DISTILL = previous;
      }
    });
  });

  it("does not install an alarm after closure while getAlarm is in flight", async () => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    await stub.init("alarm-get-race");
    await runInDurableObject(stub, async (instance, state) => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const get = vi.spyOn(state.storage, "getAlarm").mockImplementation(async () => { enter(); await held; return null; });
      const set = vi.spyOn(state.storage, "setAlarm");
      const internal = instance as unknown as { scheduleRunAlarm(at: number): Promise<void> };
      const scheduling = internal.scheduleRunAlarm(Date.now() + 60_000);
      try {
        await entered;
        await instance.close();
        await instance.destroy();
        release();
        await scheduling;
        expect(set).not.toHaveBeenCalled();
      } finally {
        release();
        await scheduling.catch(() => {});
        get.mockRestore();
        set.mockRestore();
      }
    });
  });

  it("removes an alarm if closure completes while setAlarm is in flight", async () => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    await stub.init("alarm-set-race");
    await runInDurableObject(stub, async (instance, state) => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const realSet = state.storage.setAlarm.bind(state.storage);
      const set = vi.spyOn(state.storage, "setAlarm").mockImplementation(async (at, options) => { enter(); await held; await realSet(at, options); });
      const internal = instance as unknown as { scheduleRunAlarm(at: number): Promise<void> };
      const scheduling = internal.scheduleRunAlarm(Date.now() + 60_000);
      try {
        await entered;
        await instance.close();
        await instance.destroy();
        release();
        await scheduling;
        expect(await state.storage.getAlarm()).toBeNull();
      } finally {
        release();
        await scheduling.catch(() => {});
        set.mockRestore();
      }
    });
  });
});
