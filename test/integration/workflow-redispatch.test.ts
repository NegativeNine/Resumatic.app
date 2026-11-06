import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { vault } from "../../src/shared/stubs";

describe("uncertain Workflow redispatch", () => {
  it.each(["getAlarm", "setAlarm"] as const)("reports a definite start failure when %s rejects before create", async (method) => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    const who = { userId: `alarm-failure-${method}`, gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.DISTILL;
      const create = vi.fn(async () => ({}));
      local.DISTILL = { create } as unknown as Workflow;
      const fail = vi.spyOn(state.storage, method).mockRejectedValueOnce(new Error("synthetic alarm failure"));
      try {
        const { sourceId } = await instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${vid}/sources/file` });
        expect(create).not.toHaveBeenCalled();
        expect(await instance.runInfo(who, sourceId)).toMatchObject({ state: "failed", errorCode: "dispatch_not_started" });
        expect((await instance.listSources(who))[0]).toMatchObject({ id: sourceId, state: "failed", error: "Could not start this request. Please try again." });
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches`).toArray()).toHaveLength(0);
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_redispatches`).toArray()).toHaveLength(0);
        await expect(instance.close()).resolves.toEqual({ distill: [sourceId], tailor: [] });
      } finally {
        fail.mockRestore();
        local.DISTILL = previous;
      }
    });
  });

  it("releases a reserved resume credit when scheduling fails before create", async () => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    const who = { userId: "alarm-failure-resume", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.TAILOR;
      const create = vi.fn(async () => ({}));
      local.TAILOR = { create } as unknown as Workflow;
      const { applicationId } = await instance.addApplication(who, "An engineering role with a detailed job description.");
      const fail = vi.spyOn(state.storage, "getAlarm").mockRejectedValueOnce(new Error("synthetic alarm failure"));
      try {
        const { resumeId } = await instance.tailor(who, applicationId);
        expect(create).not.toHaveBeenCalled();
        expect(await instance.runInfo(who, resumeId)).toMatchObject({ state: "failed", creditState: "released", errorCode: "dispatch_not_started" });
        expect(await instance.getResume(who, resumeId)).toMatchObject({ state: "failed", error: "Could not start this request. Please try again." });
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches`).toArray()).toHaveLength(0);
      } finally {
        fail.mockRestore();
        local.TAILOR = previous;
      }
    });
  });

  it("fails a document request without leaving an unresolved dispatch when scheduling fails", async () => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    const who = { userId: "alarm-failure-document", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.DOCUMENTS;
      const create = vi.fn(async () => ({}));
      local.DOCUMENTS = { create } as unknown as Workflow;
      const { applicationId } = await instance.addApplication(who, "An engineering role with a detailed job description.");
      const fail = vi.spyOn(state.storage, "getAlarm").mockRejectedValueOnce(new Error("synthetic alarm failure"));
      try {
        const { documentId } = await instance.startDocument(who, applicationId, { kind: "questions" }, crypto.randomUUID());
        expect(create).not.toHaveBeenCalled();
        expect(await instance.getDocument(who, documentId)).toMatchObject({ state: "failed", error: "Could not start this request. Please try again." });
        expect(await instance.runInfo(who, documentId)).toMatchObject({ state: "failed", errorCode: "dispatch_not_started" });
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches`).toArray()).toHaveLength(0);
      } finally { fail.mockRestore(); local.DOCUMENTS = previous; }
    });
  });

  it("cancels an undispatched rebuild after scheduling fails", async () => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    const who = { userId: "alarm-failure-reembed", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.REEMBED;
      const create = vi.fn(async () => ({}));
      local.REEMBED = { create } as unknown as Workflow;
      const fail = vi.spyOn(state.storage, "getAlarm").mockRejectedValueOnce(new Error("synthetic alarm failure"));
      try {
        const { runId } = await instance.startReembed("@cf/baai/bge-m3", 8);
        expect(create).not.toHaveBeenCalled();
        expect(await instance.runInfo(who, runId)).toMatchObject({ state: "failed", errorCode: "dispatch_not_started" });
        expect(await instance.reembedStatus(runId)).toMatchObject({ state: "cancelled" });
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches`).toArray()).toHaveLength(0);
      } finally { fail.mockRestore(); local.REEMBED = previous; }
    });
  });

  it("finalizes a cancellation that occurs while pre-dispatch scheduling fails", async () => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    const who = { userId: "alarm-failure-cancel", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.DISTILL;
      let rejectAlarm!: (error: Error) => void, entered!: () => void;
      const held = new Promise<null>((_resolve, reject) => { rejectAlarm = reject; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const create = vi.fn(async () => ({}));
      local.DISTILL = { create } as unknown as Workflow;
      const alarm = vi.spyOn(state.storage, "getAlarm").mockImplementationOnce(() => { entered(); return held; });
      const add = instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${vid}/sources/file` });
      try {
        await started;
        const runId = state.storage.sql.exec<{ run_id: string }>(`SELECT run_id FROM workflow_dispatches`).one().run_id;
        await instance.cancelRun(who, runId);
        rejectAlarm(new Error("synthetic alarm failure"));
        await add;
        expect(create).not.toHaveBeenCalled();
        expect(await instance.runInfo(who, runId)).toMatchObject({ state: "cancelled" });
        expect((await instance.listSources(who))[0]).toMatchObject({ state: "failed", error: "Cancelled." });
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches`).toArray()).toHaveLength(0);
      } finally {
        await add.catch(() => {});
        alarm.mockRestore();
        local.DISTILL = previous;
      }
    });
  });

  it("keeps the original fence and run pending when a concurrent retry exists", async () => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    const who = { userId: "alarm-failure-sticky", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.DISTILL;
      let rejectAlarm!: (error: Error) => void, entered!: () => void, release!: () => void, retryStarted!: () => void;
      const heldAlarm = new Promise<null>((_resolve, reject) => { rejectAlarm = reject; });
      const alarmEntered = new Promise<void>((resolve) => { entered = resolve; });
      const heldRetry = new Promise<void>((resolve) => { release = resolve; });
      const retryEntered = new Promise<void>((resolve) => { retryStarted = resolve; });
      local.DISTILL = { create: async () => { retryStarted(); await heldRetry; return {}; } } as unknown as Workflow;
      const originalGet = state.storage.getAlarm.bind(state.storage);
      const alarm = vi.spyOn(state.storage, "getAlarm").mockImplementationOnce(() => { entered(); return heldAlarm; }).mockImplementation(originalGet);
      const add = instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${vid}/sources/file` });
      let retry: Promise<void> | undefined;
      try {
        await alarmEntered;
        const runId = state.storage.sql.exec<{ run_id: string }>(`SELECT run_id FROM workflow_dispatches`).one().run_id;
        const internal = instance as unknown as { redispatchUncertain(id: string): Promise<void> };
        retry = internal.redispatchUncertain(runId);
        await retryEntered;
        rejectAlarm(new Error("synthetic alarm failure"));
        await add;
        expect(await instance.runInfo(who, runId)).toMatchObject({ state: "starting", errorCode: "dispatch_uncertain" });
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches WHERE run_id=?`, runId).toArray()).toHaveLength(1);
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_redispatches WHERE run_id=?`, runId).toArray()).toHaveLength(1);
        await expect(instance.close()).rejects.toThrow(/workflow creation is unresolved/);
      } finally {
        release();
        await retry?.catch(() => {});
        await add.catch(() => {});
        alarm.mockRestore();
        local.DISTILL = previous;
      }
    });
  });

  it.each(["running", "succeeded", "failed", "cancelled", "missing"] as const)("preserves a fence if the ledger becomes %s during scheduling", async (runState) => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    const who = { userId: `alarm-failure-${runState}`, gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.DISTILL;
      let rejectAlarm!: (error: Error) => void, entered!: () => void;
      const held = new Promise<null>((_resolve, reject) => { rejectAlarm = reject; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const create = vi.fn(async () => ({}));
      local.DISTILL = { create } as unknown as Workflow;
      const alarm = vi.spyOn(state.storage, "getAlarm").mockImplementationOnce(() => { entered(); return held; });
      const add = instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${vid}/sources/file` });
      try {
        await started;
        const runId = state.storage.sql.exec<{ run_id: string }>(`SELECT run_id FROM workflow_dispatches`).one().run_id;
        if (runState === "missing") state.storage.sql.exec(`DELETE FROM runs WHERE id=?`, runId);
        else state.storage.sql.exec(`UPDATE runs SET state=? WHERE id=?`, runState, runId);
        rejectAlarm(new Error("synthetic alarm failure"));
        await add;
        expect(create).not.toHaveBeenCalled();
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches WHERE run_id=?`, runId).toArray()).toHaveLength(1);
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_redispatches WHERE run_id=?`, runId).toArray()).toHaveLength(1);
        await expect(instance.close()).rejects.toThrow(/workflow creation is unresolved/);
      } finally {
        await add.catch(() => {});
        alarm.mockRestore();
        local.DISTILL = previous;
      }
    });
  });

  it("does not let a stale cancellation alarm fail a newer source attempt", async () => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    const who = { userId: "stale-cancel-alarm", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.DISTILL;
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      let statusCalls = 0;
      local.DISTILL = {
        async create() { return {}; },
        async get() {
          return { async status() { statusCalls++; if (statusCalls === 1) { enter(); await held; } return { status: "terminated" }; } };
        },
      } as unknown as Workflow;
      let firstAlarm: Promise<void> | undefined;
      try {
        const { sourceId } = await instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${vid}/sources/file` });
        await instance.cancelRun(who, sourceId);
        firstAlarm = instance.alarm();
        await entered;
        await instance.alarm();
        expect(await instance.runInfo(who, sourceId)).toMatchObject({ state: "cancelled" });
        const retry = await instance.retryRun(who, sourceId, crypto.randomUUID());
        expect(retry.targetId).toBe(sourceId);
        expect(retry.runId).not.toBe(sourceId);
        release();
        await firstAlarm;
        expect((await instance.listSources(who))[0]).toMatchObject({ id: sourceId, state: "queued", error: null });
        expect(await instance.runInfo(who, retry.runId)).toMatchObject({ state: "starting" });
      } finally {
        release();
        await firstAlarm?.catch(() => {});
        local.DISTILL = previous;
      }
    });
  });

  it("keeps a sticky fence when an acknowledged create is subsequently not found", async () => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    const who = { userId: "acknowledged-but-not-visible", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.DISTILL;
      const calls: unknown[] = [];
      local.DISTILL = {
        async create(input: unknown) { calls.push(input); return {}; },
        async get() { throw new Error("instance.not_found"); },
      } as unknown as Workflow;
      try {
        const { sourceId } = await instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${vid}/sources/file` });
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches`).toArray()).toHaveLength(0);
        await instance.alarm();
        expect(calls).toHaveLength(2);
        expect(calls[1]).toEqual(calls[0]);
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches WHERE run_id=?`, sourceId).toArray()).toHaveLength(1);
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_redispatches WHERE run_id=?`, sourceId).toArray()).toHaveLength(1);
        await expect(instance.close()).rejects.toThrow(/workflow creation is unresolved/);
      } finally { local.DISTILL = previous; }
    });
  });

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
