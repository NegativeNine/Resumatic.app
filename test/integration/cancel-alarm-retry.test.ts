import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { vault } from "../../src/shared/stubs";

describe("cancellation alarm failure", () => {
  it("retains the reservation after an alarm error and rearms when cancellation is retried", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "cancel-alarm-retry", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.TAILOR;
      local.TAILOR = {
        async create() { return {}; },
        async get() { return { async status() { return { status: "terminated" }; } }; },
      } as unknown as Workflow;
      try {
        const { applicationId } = await instance.addApplication(who, "An engineering role with a detailed job description.");
        const { resumeId, runId } = await instance.tailor(who, applicationId);
        await state.storage.deleteAlarm();
        const scheduling = vi.spyOn(state.storage, "setAlarm").mockRejectedValueOnce(new Error("synthetic alarm outage"));
        try {
          await expect(instance.cancelRun(who, runId)).rejects.toThrow(/synthetic alarm outage/);
          expect(await state.storage.getAlarm()).toBeNull();
          expect(state.storage.sql.exec<{ state: string; credit_state: string }>(`SELECT state, credit_state FROM runs WHERE id = ?`, runId).one()).toEqual({ state: "cancel_requested", credit_state: "reserved" });
          await instance.cancelRun(who, runId);
          expect(await state.storage.getAlarm()).not.toBeNull();
          await instance.alarm();
          expect(await instance.runInfo(who, runId)).toMatchObject({ state: "cancelled", creditState: "released" });
          expect((await instance.me(who)).quota.reserved).toBe(0);
        } finally { scheduling.mockRestore(); }
      } finally { local.TAILOR = original; }
    });
  });

  it("rearms a lost cancellation alarm on a later status poll without settling an uncertain create", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "cancel-alarm-poll", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.TAILOR;
      local.TAILOR = {
        async create() { throw new Error("synthetic unknown create outcome"); },
        async get() { throw new Error("instance.not_found"); },
      } as unknown as Workflow;
      try {
        const { applicationId } = await instance.addApplication(who, "An engineering role with a detailed job description.");
        const { resumeId, runId } = await instance.tailor(who, applicationId);
        await state.storage.deleteAlarm();
        const scheduling = vi.spyOn(state.storage, "setAlarm")
          .mockRejectedValueOnce(new Error("synthetic alarm outage"))
          .mockRejectedValueOnce(new Error("synthetic alarm outage"));
        try {
          await expect(instance.cancelRun(who, runId)).rejects.toThrow(/synthetic alarm outage/);
          expect(await instance.getResume(who, resumeId)).toMatchObject({ state: "running", cancellationPending: true });
          expect(await state.storage.getAlarm()).toBeNull();
          expect(await instance.getResume(who, resumeId)).toMatchObject({ state: "running", cancellationPending: true });
          expect(await state.storage.getAlarm()).not.toBeNull();
          await instance.alarm();
          expect(await instance.runInfo(who, runId)).toMatchObject({ state: "cancel_requested", creditState: "reserved" });
          expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches WHERE run_id = ?`, runId).toArray()).toHaveLength(1);
        } finally { scheduling.mockRestore(); }
      } finally { local.TAILOR = original; }
    });
  });

  it("rearms once for a document list and independently for an individual document", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "cancel-document-list", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.DOCUMENTS;
      local.DOCUMENTS = { async create() { return {}; } } as unknown as Workflow;
      try {
        const { applicationId } = await instance.addApplication(who, "An engineering role with a detailed job description.");
        const { documentId, runId } = await instance.startDocument(who, applicationId, { kind: "questions" }, crypto.randomUUID());
        for (let i = 0; i < 2; i++)
          state.storage.sql.exec(`INSERT INTO documents (id, application_id, kind, state, created_at) VALUES (?, ?, 'letter', 'ready', ?)`, crypto.randomUUID(), applicationId, i + 1);
        await instance.cancelRun(who, runId);
        const alarm = vi.spyOn(state.storage, "getAlarm");
        try {
          const docs = await instance.listDocuments(who, applicationId);
          expect(docs).toHaveLength(3);
          expect(docs.find((item) => item.id === documentId)).toMatchObject({ cancellationPending: true });
          expect(alarm).toHaveBeenCalledTimes(1);
          expect(await instance.getDocument(who, documentId)).toMatchObject({ cancellationPending: true });
          expect(alarm).toHaveBeenCalledTimes(2);
          await expect(instance.listDocuments({ userId: "other", gen: 1 }, applicationId)).rejects.toThrow();
          expect(alarm).toHaveBeenCalledTimes(2);
        } finally { alarm.mockRestore(); }
      } finally { local.DOCUMENTS = original; }
    });
  });
});
