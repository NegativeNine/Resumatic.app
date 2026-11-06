import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";

describe("tailoring and document concurrency", () => {
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
