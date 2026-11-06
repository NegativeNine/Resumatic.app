import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";

describe("tailoring and document concurrency", () => {
  it.each(["terminated", "running"])("does not mutate a resume when a held %s status returns after vault closure", async (status) => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const who = { userId: "stale-resume-after-close", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.TAILOR;
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      local.TAILOR = {
        async create() { return {}; },
        async get() { return { async status() { entered(); await held; return { status }; } }; },
      } as unknown as Workflow;
      let pending: Promise<void> | undefined;
      try {
        const { applicationId } = await instance.addApplication(who, "A detailed description for an engineering position.");
        const { resumeId, runId } = await instance.tailor(who, applicationId);
        state.storage.sql.exec(`UPDATE resumes SET created_at=1 WHERE id=?`, resumeId);
        const internal = instance as unknown as { reconcileStaleRuns(): Promise<void> };
        pending = internal.reconcileStaleRuns();
        await started;
        await instance.close();
        release();
        await expect(pending).rejects.toThrow();
        expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM resumes WHERE id=?`, resumeId).one().state).toBe("running");
        expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM runs WHERE id=?`, runId).one().state).toBe("starting");
      } finally {
        release();
        await pending?.catch(() => {});
        local.TAILOR = previous;
      }
    });
  }, 30_000);

  it.each(["alarm", "stale reconciliation"] as const)("does not fail a replacement run when an old %s status returns", async (path) => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const who = { userId: `stale-resume-${path}`, gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.TAILOR;
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      local.TAILOR = {
        async create() { return {}; },
        async get() { return { async status() { entered(); await held; return { status: "terminated" }; } }; },
      } as unknown as Workflow;
      let pending: Promise<void> | undefined;
      try {
        const { applicationId } = await instance.addApplication(who, "A detailed description for an engineering position.");
        const { resumeId, runId } = await instance.tailor(who, applicationId);
        state.storage.sql.exec(`UPDATE resumes SET created_at=1 WHERE id=?`, resumeId);
        const internal = instance as unknown as { reconcileStaleRuns(): Promise<void> };
        pending = path === "alarm" ? instance.alarm() : internal.reconcileStaleRuns();
        await started;
        // Simulate a legacy/import recovery changing the referenced run while
        // the old Workflow status is in flight. The reservation now belongs
        // to the replacement; a stale response must not fail or refund it.
        const replacement = crypto.randomUUID();
        state.storage.transactionSync(() => {
          state.storage.sql.exec(`INSERT INTO runs(id,kind,target_id,request_key,input_digest,state,steps,next_step,bucket_key,credit_state,error_code,created_at,updated_at)
            SELECT ?,kind,target_id,?,input_digest,'starting',steps,next_step,bucket_key,'reserved',NULL,created_at,updated_at FROM runs WHERE id=?`, replacement, `recovered:${replacement}`, runId);
          state.storage.sql.exec(`UPDATE runs SET state='failed',credit_state='released' WHERE id=?`, runId);
          state.storage.sql.exec(`UPDATE resumes SET run_id=? WHERE id=?`, replacement, resumeId);
        });
        release();
        await pending;
        expect(state.storage.sql.exec<{ state: string; run_id: string }>(`SELECT state,run_id FROM resumes WHERE id=?`, resumeId).one()).toEqual({ state: "running", run_id: replacement });
        expect(state.storage.sql.exec<{ state: string; credit_state: string }>(`SELECT state,credit_state FROM runs WHERE id=?`, replacement).one()).toEqual({ state: "starting", credit_state: "reserved" });
        expect((await instance.me(who)).quota.reserved).toBe(1);
      } finally {
        release();
        await pending?.catch(() => {});
        local.TAILOR = previous;
      }
    });
  }, 30_000);

  it("waits for gap questions to finish before starting a resume", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const who = { userId: "question-concurrency-owner", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.DOCUMENTS;
      local.DOCUMENTS = { async create() { return {}; } } as unknown as Workflow;
      try {
        const { applicationId } = await instance.addApplication(who, "A detailed description for an engineering position.");
        const questionKey = crypto.randomUUID();
        const questions = await instance.startDocument(who, applicationId, { kind: "questions" }, questionKey);
        await expect(instance.tailor(who, applicationId)).rejects.toThrow(/document is already being generated/);
        // A genuine replay remains available even when the document is running.
        expect(await instance.startDocument(who, applicationId, { kind: "questions" }, questionKey)).toEqual(questions);
        expect((await instance.me(who)).quota).toMatchObject({ used: 0, reserved: 0 });
      } finally { local.DOCUMENTS = previous; }
    });
  });

  it("returns the original result for concurrent retries while stale runs are checked", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const who = { userId: "retry-concurrency-owner", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.TAILOR;
      let release!: () => void;
      let bothArrived!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { bothArrived = resolve; });
      let checks = 0;
      let creates = 0;
      local.TAILOR = {
        async create() { creates++; return {}; },
        async get() {
          return { async status() { if (++checks === 2) bothArrived(); await gate; return { status: "terminated" }; } };
        },
      } as unknown as Workflow;
      try {
        const { applicationId } = await instance.addApplication(who, "A detailed description for an engineering position.");
        // A legacy stale row forces both requests to yield to status I/O.
        state.storage.sql.exec(
          `INSERT INTO resumes (id, application_id, state, run_id, created_at) VALUES (?, ?, 'running', ?, 1)`,
          crypto.randomUUID(), applicationId, crypto.randomUUID(),
        );
        const key = crypto.randomUUID();
        const first = instance.tailor(who, applicationId, key);
        const second = instance.tailor(who, applicationId, key);
        await ready;
        release();
        const [a, b] = await Promise.all([first, second]);
        expect(b).toEqual(a);
        expect(creates).toBe(1);
        expect((await instance.me(who)).quota).toMatchObject({ used: 0, reserved: 1 });
      } finally { release(); local.TAILOR = previous; }
    });
  }, 30_000);

  it("rejects a concurrent reuse of the same key for a different application", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    const who = { userId: "retry-different-application", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.TAILOR;
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      let bothArrived!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
      const ready = new Promise<void>((resolve) => { bothArrived = resolve; });
      let checks = 0;
      let creates = 0;
      local.TAILOR = {
        async create() { creates++; return {}; },
        async get() {
          const index = checks++;
          if (checks === 2) bothArrived();
          return { async status() { await (index === 0 ? firstGate : secondGate); return { status: "terminated" }; } };
        },
      } as unknown as Workflow;
      try {
        const firstApp = (await instance.addApplication(who, "A detailed description for an engineering position.")).applicationId;
        const secondApp = (await instance.addApplication(who, "A detailed description for another engineering position.")).applicationId;
        state.storage.sql.exec(
          `INSERT INTO resumes (id, application_id, state, run_id, created_at) VALUES (?, ?, 'running', ?, 1)`,
          crypto.randomUUID(), firstApp, crypto.randomUUID(),
        );
        const key = crypto.randomUUID();
        const first = instance.tailor(who, firstApp, key);
        const second = instance.tailor(who, secondApp, key);
        const rejected = expect(second).rejects.toThrow(/request key was used for another application/);
        await ready;
        releaseFirst();
        await first;
        releaseSecond();
        await rejected;
        expect(creates).toBe(1);
        expect((await instance.me(who)).quota).toMatchObject({ used: 0, reserved: 1 });
      } finally { releaseFirst(); releaseSecond(); local.TAILOR = previous; }
    });
  }, 30_000);
});
