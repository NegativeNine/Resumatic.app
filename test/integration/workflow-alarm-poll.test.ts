import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { vault } from "../../src/shared/stubs";

describe("Workflow status polling after an interrupted alarm", () => {
  it("rearms an uncertain source start without clearing its dispatch fence", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "source-alarm-poll", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.DISTILL;
      const create = vi.fn(async () => { throw new Error("synthetic unknown create outcome"); });
      local.DISTILL = { create } as unknown as Workflow;
      try {
        const { sourceId } = await instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${id}/sources/file` });
        await state.storage.deleteAlarm();
        await expect(instance.listSources({ userId: "other", gen: 1 })).rejects.toThrow();
        expect(await state.storage.getAlarm()).toBeNull();
        expect((await instance.listSources(who))[0]).toMatchObject({ id: sourceId, state: "queued" });
        expect(await state.storage.getAlarm()).not.toBeNull();
        expect(create).toHaveBeenCalledTimes(1); // polling itself must not redispatch
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches WHERE run_id=?`, sourceId).toArray()).toHaveLength(1);
        await expect(instance.close()).rejects.toThrow(/workflow creation is unresolved/);
      } finally { local.DISTILL = original; }
    });
  });

  it("rearms before a stale source lookup stalls and rechecks the session afterward", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "source-stalled-lookup", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.DISTILL;
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      local.DISTILL = {
        async create() { return {}; },
        async get() { entered(); await held; return { async status() { return { status: "running" }; } }; },
      } as unknown as Workflow;
      try {
        const { sourceId } = await instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${id}/sources/file` });
        state.storage.sql.exec(`UPDATE sources SET created_at=0 WHERE id=?`, sourceId);
        await state.storage.deleteAlarm();
        const pending = instance.listSources(who);
        try {
          await started;
          expect(await state.storage.getAlarm()).not.toBeNull();
          await instance.signOutEverywhere(who);
          release();
          await expect(pending).rejects.toThrow(/session was signed out/);
        } finally { release(); await pending.catch(() => {}); }
      } finally { local.DISTILL = original; }
    });
  });

  it("retries alarm setup on a later resume poll and leaves a failed attempt fenced", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "resume-alarm-poll", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.TAILOR;
      const create = vi.fn(async () => { throw new Error("synthetic unknown create outcome"); });
      local.TAILOR = { create } as unknown as Workflow;
      try {
        const { applicationId } = await instance.addApplication(who, "An engineering role with a detailed job description.");
        const { resumeId } = await instance.tailor(who, applicationId);
        await state.storage.deleteAlarm();
        const schedule = vi.spyOn(state.storage, "setAlarm").mockRejectedValueOnce(new Error("synthetic storage outage"));
        try {
          expect(await instance.getResume(who, resumeId)).toMatchObject({ state: "running", dispatchUncertain: true });
          expect(await state.storage.getAlarm()).toBeNull();
          expect((await instance.listApplications(who))[0]?.resumes[0]).toMatchObject({ id: resumeId, state: "running" });
          expect(await state.storage.getAlarm()).not.toBeNull();
          expect(create).toHaveBeenCalledTimes(1);
          expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches WHERE run_id=?`, resumeId).toArray()).toHaveLength(1);
        } finally { schedule.mockRestore(); }
      } finally { local.TAILOR = original; }
    });
  });

  it("rearms active document work on a run or document poll and leaves inactive vaults alone", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "document-alarm-poll", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.DOCUMENTS;
      const create = vi.fn(async () => ({}));
      local.DOCUMENTS = { create } as unknown as Workflow;
      try {
        const { applicationId } = await instance.addApplication(who, "An engineering role with a detailed job description.");
        await state.storage.deleteAlarm();
        await instance.listRuns(who);
        expect(await state.storage.getAlarm()).toBeNull();
        const { documentId, runId } = await instance.startDocument(who, applicationId, { kind: "questions" }, crypto.randomUUID());
        for (const poll of [
          () => instance.getDocument(who, documentId),
          () => instance.listDocuments(who, applicationId),
          () => instance.runInfo(who, runId),
          () => instance.listRuns(who),
          () => instance.adminRuns(),
        ]) {
          await state.storage.deleteAlarm();
          await poll();
          expect(await state.storage.getAlarm()).not.toBeNull();
        }
        expect(create).toHaveBeenCalledTimes(1);
      } finally { local.DOCUMENTS = original; }
    });
  });

  it.each(["signout", "close"] as const)("rechecks access when %s occurs during alarm scheduling", async (action) => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: `alarm-access-${action}`, gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.TAILOR;
      local.TAILOR = { async create() { return {}; } } as unknown as Workflow;
      try {
        const { applicationId } = await instance.addApplication(who, "An engineering role with a detailed job description.");
        const { resumeId } = await instance.tailor(who, applicationId);
        let release!: (value: number | null) => void;
        let entered!: () => void;
        const held = new Promise<number | null>((resolve) => { release = resolve; });
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const alarm = vi.spyOn(state.storage, "getAlarm").mockImplementationOnce(() => { entered(); return held; });
        const pending = instance.getResume(who, resumeId).then(() => null, (error: Error) => error);
        try {
          await started;
          if (action === "signout") await instance.signOutEverywhere(who);
          else await instance.close();
          release(null);
          expect((await pending)?.message).toMatch(action === "signout" ? /session was signed out/ : /account is being deleted/);
        } finally { release(null); await pending; alarm.mockRestore(); }
      } finally { local.TAILOR = original; }
    });
  });
});
