import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";

const uncertainWorkflow = () => ({
  async create() { throw new Error("synthetic uncertain create"); },
  async get() { throw new Error("instance.not_found"); },
}) as unknown as Workflow;

describe("uncertain workflow starts", () => {
  it("shows saved uploads as unconfirmed without treating a missing instance as failure", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "uncertain-source", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.DISTILL;
      local.DISTILL = uncertainWorkflow();
      try {
        const { sourceId } = await instance.addSource(who, {
          filename: "resume.pdf", r2Key: `vaults/${id}/sources/file`,
        });
        state.storage.sql.exec(`UPDATE sources SET created_at = 1 WHERE id = ?`, sourceId);
        expect((await instance.listSources(who))[0]).toMatchObject({
          id: sourceId, state: "queued", dispatchUncertain: true,
        });
        await instance.alarm();
        expect((await instance.listSources(who))[0]).toMatchObject({
          state: "queued", dispatchUncertain: true,
        });
        // An eviction before create settles can leave a marker without an error.
        // It appears unconfirmed after the grace period, even without an alarm.
        state.storage.sql.exec(`UPDATE runs SET error_code = NULL, updated_at = ? WHERE id = ?`, Date.now(), sourceId);
        expect((await instance.listSources(who))[0]).toMatchObject({ dispatchUncertain: false });
        state.storage.sql.exec(`UPDATE runs SET updated_at = ? WHERE id = ?`, Date.now() - 31_000, sourceId);
        expect((await instance.listSources(who))[0]).toMatchObject({ dispatchUncertain: true });
        await instance.claimRun(sourceId);
        expect((await instance.listSources(who))[0]).toMatchObject({ dispatchUncertain: false });
        // A late create rejection cannot make an already-started run unconfirmed.
        const inner = instance as unknown as { runs: { noteUncertain(id: string, code: string): void } };
        inner.runs.noteUncertain(sourceId, "dispatch_uncertain");
        expect((await instance.listSources(who))[0]).toMatchObject({ dispatchUncertain: false });
      } finally { local.DISTILL = original; }
    });
  });

  it("surfaces an uncertain resume start in both views and preserves its reservation", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "uncertain-resume", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.TAILOR;
      local.TAILOR = uncertainWorkflow();
      try {
        const { applicationId } = await instance.addApplication(who, "An engineering role with a detailed job description.");
        const { resumeId } = await instance.tailor(who, applicationId);
        state.storage.sql.exec(`UPDATE resumes SET created_at = 1 WHERE id = ?`, resumeId);
        expect(await instance.getResume(who, resumeId)).toMatchObject({ state: "running", dispatchUncertain: true });
        expect((await instance.listApplications(who))[0]?.resumes[0]).toMatchObject({ id: resumeId, dispatchUncertain: true });
        await expect(instance.tailor(who, applicationId)).rejects.toThrow(/already being generated/);
        expect(await instance.getResume(who, resumeId)).toMatchObject({ state: "running", dispatchUncertain: true });
        await instance.claimRun(resumeId);
        expect(await instance.getResume(who, resumeId)).toMatchObject({ dispatchUncertain: false });
      } finally { local.TAILOR = original; }
    });
  });

  it("surfaces uncertain document creation and clears the message on claim", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "uncertain-document", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.DOCUMENTS;
      local.DOCUMENTS = uncertainWorkflow();
      try {
        const { applicationId } = await instance.addApplication(who, "An engineering role with a detailed job description.");
        const { documentId } = await instance.startDocument(who, applicationId, { kind: "questions" }, crypto.randomUUID());
        expect(await instance.getDocument(who, documentId)).toMatchObject({ state: "running", dispatchUncertain: true });
        expect((await instance.listDocuments(who, applicationId))[0]).toMatchObject({ id: documentId, dispatchUncertain: true });
        await instance.claimRun(documentId);
        expect(await instance.getDocument(who, documentId)).toMatchObject({ dispatchUncertain: false });
      } finally { local.DOCUMENTS = original; }
    });
  });

  it("does not report cancellation or refund when an unresolved create is not found", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "uncertain-cancel", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.TAILOR;
      local.TAILOR = uncertainWorkflow();
      try {
        const { applicationId } = await instance.addApplication(who, "An engineering role with a detailed job description.");
        const { resumeId, runId } = await instance.tailor(who, applicationId);
        const before = (await instance.me(who)).quota;
        expect(before.reserved).toBe(1);
        await instance.cancelRun(who, runId);
        await instance.alarm();
        expect(await instance.runInfo(who, runId)).toMatchObject({
          state: "cancel_requested", creditState: "reserved",
        });
        expect(await instance.getResume(who, resumeId)).toMatchObject({ state: "running" });
        expect(await instance.getResume(who, resumeId)).toMatchObject({ cancellationPending: true });
        expect((await instance.listApplications(who))[0]?.resumes[0]).toMatchObject({ cancellationPending: true });
        expect((await instance.me(who)).quota.reserved).toBe(before.reserved);
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches WHERE run_id = ?`, runId).toArray()).toHaveLength(1);
      } finally { local.TAILOR = original; }
    });
  });

  it("does not finalize cancellation if an instance is terminal while create is still unresolved", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "uncertain-cancel-terminal", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.TAILOR;
      local.TAILOR = {
        async create() { throw new Error("synthetic uncertain create"); },
        async get() { return { async status() { return { status: "terminated" }; } }; },
      } as unknown as Workflow;
      try {
        const { applicationId } = await instance.addApplication(who, "An engineering role with a detailed job description.");
        const { resumeId, runId } = await instance.tailor(who, applicationId);
        await instance.cancelRun(who, runId);
        await instance.alarm();
        expect(await instance.runInfo(who, runId)).toMatchObject({ state: "cancel_requested", creditState: "reserved" });
        expect(await instance.getResume(who, resumeId)).toMatchObject({ state: "running", cancellationPending: true });
        expect((await instance.me(who)).quota.reserved).toBe(1);
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches WHERE run_id = ?`, runId).toArray()).toHaveLength(1);
      } finally { local.TAILOR = original; }
    });
  });
});
