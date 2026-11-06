import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { signIn } from "./support";

const uncertainWorkflow = () => ({
  async create() { throw new Error("synthetic uncertain create"); },
  async get() { throw new Error("instance.not_found"); },
}) as unknown as Workflow;

describe("uncertain workflow starts", () => {
  it("lets the owner request resume cancellation over HTTP while preserving an unresolved dispatch", async () => {
    const user = await signIn();
    const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
    const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { uid: string; vid: string; gen: number; epoch?: string };
    const stub = vault(env, session.vid);
    const { resumeId, runId } = await runInDurableObject(stub, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.TAILOR;
      local.TAILOR = uncertainWorkflow();
      try {
        const who = { userId: session.uid, gen: session.gen, epoch: session.epoch };
        const { applicationId } = await instance.addApplication(who, "An engineering role with a detailed job description.");
        return await instance.tailor(who, applicationId);
      } finally { local.TAILOR = original; }
    });
    const stranger = await signIn();
    expect((await stranger.send("POST", `/api/resumes/${resumeId}/cancel`)).status).toBe(404);
    expect((await user.send("POST", `/api/resumes/${resumeId}/cancel`)).status).toBe(202);
    await runInDurableObject(stub, async (instance, state) => {
      const who = { userId: session.uid, gen: session.gen, epoch: session.epoch };
      expect(await instance.runInfo(who, runId)).toMatchObject({ state: "cancel_requested", creditState: "reserved" });
      expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches WHERE run_id = ?`, runId).toArray()).toHaveLength(1);
    });
  });
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
        await instance.claimRun(sourceId, { kind: "distill", targetId: sourceId });
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
        await instance.claimRun(resumeId, { kind: "tailor", targetId: resumeId });
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
        await instance.claimRun(documentId, { kind: "document", targetId: documentId });
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
        await expect(instance.cancelResume({ userId: "someone-else", gen: 1 }, resumeId)).rejects.toThrow();
        await instance.cancelResume(who, resumeId);
        await instance.alarm();
        expect(await instance.runInfo(who, runId)).toMatchObject({
          state: "cancel_requested", creditState: "reserved",
        });
        expect(await instance.getResume(who, resumeId)).toMatchObject({ state: "running" });
        expect(await instance.getResume(who, resumeId)).toMatchObject({ cancellationPending: true });
        expect((await instance.listApplications(who))[0]?.resumes[0]).toMatchObject({ cancellationPending: true });
        expect((await instance.me(who)).quota.reserved).toBe(before.reserved);
        expect(state.storage.sql.exec(`SELECT run_id FROM workflow_dispatches WHERE run_id = ?`, runId).toArray()).toHaveLength(1);
        // The target-specific UI action keeps the original dispatch fence;
        // neither deletion nor another generation may proceed while it is unresolved.
        await expect(instance.tailor(who, applicationId)).rejects.toThrow();
        await expect(instance.close()).rejects.toThrow(/workflow creation is unresolved/);
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

  it("does not publish a resume failure after cancellation is requested", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "resume-failure-after-cancel", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.TAILOR;
      local.TAILOR = uncertainWorkflow();
      try {
        const { applicationId } = await instance.addApplication(who, "An engineering role with a detailed job description.");
        const { resumeId, runId } = await instance.tailor(who, applicationId);
        await instance.cancelRun(who, runId);
        await instance.failResume(resumeId, "A model call failed.", runId);
        expect(await instance.runInfo(who, runId)).toMatchObject({ state: "cancel_requested", creditState: "reserved" });
        expect(await instance.getResume(who, resumeId)).toMatchObject({ state: "running", error: null, cancellationPending: true });
        expect((await instance.me(who)).quota.reserved).toBe(1);
      } finally { local.TAILOR = original; }
    });
  });

  it("does not publish a document failure after cancellation is requested", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "document-failure-after-cancel", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.DOCUMENTS;
      local.DOCUMENTS = uncertainWorkflow();
      try {
        const { applicationId } = await instance.addApplication(who, "An engineering role with a detailed job description.");
        const { documentId, runId } = await instance.startDocument(who, applicationId, { kind: "letter" }, crypto.randomUUID());
        await instance.cancelRun(who, runId);
        await instance.failDocument(runId, "A model call failed.");
        expect(await instance.runInfo(who, runId)).toMatchObject({ state: "cancel_requested", creditState: "reserved" });
        expect(await instance.getDocument(who, documentId)).toMatchObject({ state: "running", error: null, cancellationPending: true });
        expect((await instance.me(who)).quota.reserved).toBe(1);
      } finally { local.DOCUMENTS = original; }
    });
  });

  it("does not publish a source failure from a stale alarm after cancellation", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "source-alarm-after-cancel", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.DISTILL;
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      local.DISTILL = {
        async create() { return {}; },
        async get() { return { async status() { entered(); await hold; return { status: "errored" }; } }; },
      } as unknown as Workflow;
      let alarm: Promise<void> | undefined;
      try {
        const { sourceId } = await instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${id}/sources/file` });
        alarm = instance.alarm();
        await ready;
        await instance.cancelRun(who, sourceId);
        release();
        await alarm;
        expect(await instance.runInfo(who, sourceId)).toMatchObject({ state: "cancel_requested" });
        expect((await instance.listSources(who))[0]).toMatchObject({ state: "queued", error: null, cancellationPending: true });
      } finally {
        release();
        await alarm?.catch(() => {});
        local.DISTILL = original;
      }
    });
  });

  it("does not dispatch another workflow when cancellation races a not-found lookup", async () => {
    const id = env.VAULT.newUniqueId().toString();
    const stub = vault(env, id);
    const who = { userId: "source-cancel-before-retry", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.DISTILL;
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      let creates = 0;
      local.DISTILL = {
        async create() { creates++; return {}; },
        async get() { entered(); await hold; throw new Error("instance.not_found"); },
      } as unknown as Workflow;
      let alarm: Promise<void> | undefined;
      try {
        const { sourceId } = await instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${id}/sources/file` });
        expect(creates).toBe(1);
        alarm = instance.alarm();
        await ready;
        await instance.cancelRun(who, sourceId);
        release();
        await alarm;
        expect(creates).toBe(1);
        expect(await instance.runInfo(who, sourceId)).toMatchObject({ state: "cancel_requested" });
      } finally {
        release();
        await alarm?.catch(() => {});
        local.DISTILL = original;
      }
    });
  });
});
