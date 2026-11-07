import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";

describe("Workflow run identity", () => {
  it("refuses unknown, wrong-kind, wrong-target, and stopped claims", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    await stub.init("claim-owner");
    await runInDurableObject(stub, async (instance, state) => {
      const runId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      const inner = instance as unknown as {
        runs: { begin(run: Record<string, unknown>, write: () => void): void };
      };
      inner.runs.begin({ id: runId, kind: "distill", targetId: sourceId, requestKey: runId, inputDigest: runId, steps: ["convert", "extract", "embed"] }, () => {});
      await expect(instance.claimRun(crypto.randomUUID(), { kind: "distill", targetId: sourceId })).rejects.toThrow(/no such run/);
      await expect(instance.claimRun(runId, { kind: "tailor", targetId: sourceId })).rejects.toThrow(/does not match/);
      await expect(instance.claimRun(runId, { kind: "distill", targetId: crypto.randomUUID() })).rejects.toThrow(/does not match/);
      await instance.claimRun(runId, { kind: "distill", targetId: sourceId });
      state.storage.sql.exec(`UPDATE runs SET state = 'cancel_requested' WHERE id = ?`, runId);
      await expect(instance.claimRun(runId, { kind: "distill", targetId: sourceId })).rejects.toThrow(/no longer accepts writes/);
    });
  });

  it("keeps legacy rows without a run ledger unchanged when a checkpoint or failure handler replays", async () => {
    const vaultId = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vaultId);
    await stub.init("legacy-owner");
    await runInDurableObject(stub, async (instance, state) => {
      const sourceId = crypto.randomUUID();
      const resumeId = crypto.randomUUID();
      const appId = crypto.randomUUID();
      state.storage.sql.exec(`INSERT INTO sources (id, filename, r2_key, state, run_id, created_at) VALUES (?, 'legacy.pdf', ?, 'queued', ?, 1)`, sourceId, `vaults/${vaultId}/sources/legacy`, sourceId);
      state.storage.sql.exec(`INSERT INTO applications (id, jd_text, created_at) VALUES (?, 'job', 1)`, appId);
      state.storage.sql.exec(`INSERT INTO resumes (id, application_id, state, run_id, created_at) VALUES (?, ?, 'running', ?, 1)`, resumeId, appId, resumeId);

      await expect(instance.claimRun(sourceId, { kind: "distill", targetId: sourceId })).rejects.toThrow(/no such run/);
      await expect(instance.sourceProgress(sourceId, sourceId)).rejects.toThrow(/no such run/);
      await expect(instance.saveSource(sourceId, { state: "failed", error: "bad" }, sourceId)).rejects.toThrow(/no such run/);
      await expect(instance.completeSourceStep(sourceId, "convert", sourceId)).rejects.toThrow(/no such run/);
      await expect(instance.saveExtraction(sourceId, { roles: [], facts: [] }, sourceId)).rejects.toThrow(/no such run/);
      await expect(instance.unembeddedFacts(sourceId, sourceId)).rejects.toThrow(/no such run/);
      await expect(instance.saveVectors([], undefined, { runId: sourceId, sourceId })).rejects.toThrow(/no such run/);
      await expect(instance.tailorInput(resumeId, resumeId)).rejects.toThrow(/no such run/);
      await expect(instance.saveStep(resumeId, "analyze", {}, resumeId)).rejects.toThrow(/no such run/);
      await expect(instance.saveAnalysis(appId, { company: "fabricated", title: "role", requirements: [] }, resumeId, resumeId)).rejects.toThrow(/no such run/);
      await instance.failResume(resumeId, "bad", resumeId);
      // Calls from Phase 1 Workflow code did not carry a run ID. After an
      // upgrade they must not bypass the ledger through a saved checkpoint.
      await expect(instance.saveSource(sourceId, { state: "failed" })).rejects.toThrow(/workflow identity is required/);
      await expect(instance.unembeddedFacts(sourceId)).rejects.toThrow(/workflow identity is required/);
      await expect(instance.saveVectors([])).rejects.toThrow(/workflow identity is required/);
      await expect(instance.tailorInput(resumeId)).rejects.toThrow(/workflow identity is required/);
      await expect(instance.saveStep(resumeId, "analyze", {})).rejects.toThrow(/workflow identity is required/);
      await expect(instance.saveAnalysis(appId, { company: "bad", title: "role", requirements: [] })).rejects.toThrow(/workflow identity is required/);

      expect(state.storage.sql.exec(`SELECT state, error, markdown FROM sources WHERE id = ?`, sourceId).one()).toMatchObject({ state: "queued", error: null, markdown: null });
      expect(state.storage.sql.exec(`SELECT state, error FROM resumes WHERE id = ?`, resumeId).one()).toMatchObject({ state: "running", error: null });
      expect(state.storage.sql.exec(`SELECT company, title, requirements FROM applications WHERE id = ?`, appId).one()).toMatchObject({ company: null, title: null, requirements: null });
    });
  });

  it("does not let failure handlers mutate runs belonging to another Workflow kind", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    await stub.init("wrong-kind-owner");
    await runInDurableObject(stub, async (instance) => {
      const runId = crypto.randomUUID();
      const inner = instance as unknown as {
        runs: { begin(run: Record<string, unknown>, write: () => void): void; get(id: string): { state: string } };
      };
      inner.runs.begin({ id: runId, kind: "tailor", targetId: runId, requestKey: runId, inputDigest: runId, steps: ["analyze"] }, () => {});
      await instance.failDocument(runId, "bad");
      await instance.failReembed(runId);
      expect(inner.runs.get(runId).state).toBe("starting");
      await expect(instance.documentInput(runId)).rejects.toThrow(/does not match/);
      await expect(instance.reembedBatch(runId)).rejects.toThrow(/does not match/);
    });
  });

  it("does not let a superseded analysis update the current application", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    await stub.init("superseded-owner");
    await runInDurableObject(stub, async (instance, state) => {
      const appId = crypto.randomUUID();
      const resumeId = crypto.randomUUID();
      const oldRun = crypto.randomUUID();
      const newRun = crypto.randomUUID();
      const inner = instance as unknown as { runs: { begin(run: Record<string, unknown>, write: () => void): void } };
      state.storage.sql.exec(`INSERT INTO applications (id, jd_text, created_at) VALUES (?, 'job', 1)`, appId);
      state.storage.sql.exec(`INSERT INTO resumes (id, application_id, state, run_id, created_at) VALUES (?, ?, 'running', ?, 1)`, resumeId, appId, newRun);
      for (const id of [oldRun, newRun])
        inner.runs.begin({ id, kind: "tailor", targetId: resumeId, requestKey: id, inputDigest: id, steps: ["analyze"] }, () => {});
      await expect(instance.saveAnalysis(appId, { company: "wrong", title: "role", requirements: [] }, resumeId, oldRun)).rejects.toThrow(/superseded/);
      expect(state.storage.sql.exec(`SELECT company FROM applications WHERE id = ?`, appId).one()).toMatchObject({ company: null });
    });
  });

  it("does not let a foreign Workflow instance act on its payload's document or reembed run", async () => {
    const vaultId = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vaultId);
    await stub.init("foreign-instance-owner");
    const documentId = crypto.randomUUID();
    const reembedId = crypto.randomUUID();
    await runInDurableObject(stub, async (instance) => {
      const inner = instance as unknown as {
        runs: { begin(run: Record<string, unknown>, write: () => void): void };
      };
      inner.runs.begin({ id: documentId, kind: "questions", targetId: documentId, requestKey: documentId, inputDigest: documentId, steps: ["plan"] }, () => {});
      inner.runs.begin({ id: reembedId, kind: "reembed", targetId: reembedId, requestKey: reembedId, inputDigest: reembedId, steps: [] }, () => {});
    });
    const document = await env.DOCUMENTS.create({ id: crypto.randomUUID(), params: { vaultId, runId: documentId } });
    const reembed = await env.REEMBED.create({ id: crypto.randomUUID(), params: { vaultId, runId: reembedId } });
    for (const instance of [document, reembed]) {
      const deadline = Date.now() + 15_000;
      let status = "";
      while (Date.now() < deadline) {
        status = (await instance.status()).status;
        if (["complete", "errored", "terminated"].includes(status)) break;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      expect(status).toBe("complete");
    }
    await runInDurableObject(stub, async (instance) => {
      const inner = instance as unknown as { runs: { get(id: string): { state: string } } };
      expect(inner.runs.get(documentId).state).toBe("starting");
      expect(inner.runs.get(reembedId).state).toBe("starting");
    });
  });
});
