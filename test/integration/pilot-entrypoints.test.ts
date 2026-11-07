import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { DistillWorkflow } from "../../src/workflows/distill";
import { TailorWorkflow } from "../../src/workflows/tailor";
import { DocumentWorkflow } from "../../src/workflows/documents";
import { ReembedWorkflow } from "../../src/workflows/reembed";
import { Vault } from "../../src/vault/vault";
import { PILOT_LEDGER_NAME, type PilotIdentityPath } from "../../src/worker/pilot/ledger";
import { app } from "../../src/worker/routes";

const key = "test-pilot-key-for-local-only-1234567890";
const version = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ctx = createExecutionContext();
const step = {
  async do(_name: string, configOrFn: unknown, fn?: () => Promise<unknown>) {
    return await (fn ?? configOrFn as () => Promise<unknown>)();
  },
} as unknown as WorkflowStep;
const post = (bindings: Env, path: string, body: unknown) => app.fetch(
  new Request(`https://resumatic.test/auth/test/pilot-budget/identity/${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-pilot-budget-key": key }, body: JSON.stringify(body),
  }), bindings, ctx,
);

/** Direct invocation keeps real Workflow code but replaces unrelated Vault and R2 work. */
function workflowFixture() {
  const vaultId = env.VAULT.newUniqueId().toString();
  const stub = {
    claimRun: vi.fn(async () => {}),
    sourceProgress: vi.fn(async () => ({ convertedChars: null })),
    sourceInfo: vi.fn(async () => ({ r2Key: "synthetic-source", filename: "resume.pdf", origin: "upload" })),
    saveSource: vi.fn(async () => {}),
    tailorInput: vi.fn(async () => ({ analysis: null, jdText: "Synthetic role description" })),
    failResume: vi.fn(async () => {}),
    documentInput: vi.fn(async () => ({ kind: "letter", analysis: null, jdText: "Synthetic role description", facts: [], roles: [] })),
    failDocument: vi.fn(async () => {}),
    reembedBatch: vi.fn(async () => ({ model: "@cf/baai/bge-m3", items: [{ id: "fact", text: "Synthetic fact" }] })),
    embeddingModel: vi.fn(async () => "@cf/baai/bge-m3"),
    failReembed: vi.fn(async () => {}),
  };
  const ai = { run: vi.fn(), toMarkdown: vi.fn() };
  const bindings = {
    ...env,
    PILOT_SHARED_BUDGET: "true",
    PILOT_VERSION_METADATA: { id: version, tag: "", timestamp: "" },
    VAULT: { idFromString: (id: string) => id, get: () => stub },
    FILES: { get: vi.fn(async () => ({ blob: async () => new Blob(["synthetic"]) })) },
    AI: ai,
  } as unknown as Env;
  return { bindings, vaultId, stub, ai };
}

const cases: { path: PilotIdentityPath; expectedStep: string; run: (env: Env, vaultId: string, runId: string) => Promise<unknown> }[] = [
  { path: "distill", expectedStep: "convert", run: (e, vaultId, runId) => DistillWorkflow.prototype.run.call({ env: e } as unknown as DistillWorkflow, { instanceId: runId, payload: { vaultId, sourceId: "source" }, timestamp: new Date() } as WorkflowEvent<{ vaultId: string; sourceId: string }>, step) },
  { path: "tailor", expectedStep: "analyze", run: (e, vaultId, runId) => TailorWorkflow.prototype.run.call({ env: e } as unknown as TailorWorkflow, { instanceId: runId, payload: { vaultId, resumeId: "resume" }, timestamp: new Date() } as WorkflowEvent<{ vaultId: string; resumeId: string }>, step) },
  { path: "document", expectedStep: "plan", run: (e, vaultId, runId) => DocumentWorkflow.prototype.run.call({ env: e } as unknown as DocumentWorkflow, { instanceId: runId, payload: { vaultId, runId }, timestamp: new Date() } as WorkflowEvent<{ vaultId: string; runId: string }>, step) },
  { path: "reembed", expectedStep: "batch 0", run: (e, vaultId, runId) => ReembedWorkflow.prototype.run.call({ env: e } as unknown as ReembedWorkflow, { instanceId: runId, payload: { vaultId, runId }, timestamp: new Date() } as WorkflowEvent<{ vaultId: string; runId: string }>, step) },
];

describe("pilot identity through workflow entrypoints", () => {
  it.each(cases)("observes $path before any external model call", async ({ path, expectedStep, run }) => {
    const { bindings, vaultId, ai } = workflowFixture();
    const ledger = env.PILOT_BUDGET!.getByName(PILOT_LEDGER_NAME);
    const before = await ledger.status();
    const begun = await post(bindings, "begin", { path, vaultId });
    expect(begun.status).toBe(201);
    const { nonce } = await begun.json() as { nonce: string };
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network call"));
    try {
      const runId = `run-${path}`;
      expect(await run(bindings, vaultId, runId)).toEqual({ failed: true });
      expect(await (await post(bindings, "status", { nonce })).json()).toEqual({ state: "observed" });
      const consumed = await post(bindings, "consume", { nonce, runId });
      expect(await consumed.json()).toEqual({ path, vaultId, runId, step: expectedStep, workerVersion: version, runtimeVersion: version });
      expect(ai.run).not.toHaveBeenCalled();
      expect(ai.toMarkdown).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
      expect(await ledger.status()).toEqual(before);
    } finally {
      network.mockRestore();
      await runInDurableObject(ledger, (_instance, state) => {
        state.storage.sql.exec("DELETE FROM pilot_identity_probe WHERE nonce=?", nonce);
      });
    }
  });

  it("observes the Vault fact-embedding path before any external model call", async () => {
    const { bindings, vaultId, ai } = workflowFixture();
    const ledger = env.PILOT_BUDGET!.getByName(PILOT_LEDGER_NAME);
    const before = await ledger.status();
    const begun = await post(bindings, "begin", { path: "vault", vaultId });
    expect(begun.status).toBe(201);
    const { nonce } = await begun.json() as { nonce: string };
    let runId = "";
    const proto = Vault.prototype as unknown as {
      addFact(this: unknown, who: unknown, fact: unknown): Promise<unknown>;
      embedOne(this: unknown, text: string): Promise<number[]>;
    };
    const fakeVault = {
      env: bindings, vaultId, initialised: true, gone: false,
      requireOwner() {}, requireOpen() {}, meta: () => "open",
      activeEmbeddingModel: () => "@cf/baai/bge-m3",
      scheduleRunAlarm: async () => {},
      runs: {
        begin: (run: { id: string }) => { runId = run.id; },
        claim() {}, fail() {},
      },
      embedOne(text: string) { return proto.embedOne.call(fakeVault, text); },
    };
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network call"));
    try {
      await expect(proto.addFact.call(fakeVault, {}, { roleId: null, kind: "accomplishment", level: null, text: "Synthetic fact" }))
        .rejects.toThrow("could not save that fact");
      expect(runId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(await (await post(bindings, "status", { nonce })).json()).toEqual({ state: "observed" });
      const consumed = await post(bindings, "consume", { nonce, runId });
      expect(await consumed.json()).toEqual({ path: "vault", vaultId, runId, step: "embed", workerVersion: version, runtimeVersion: version });
      expect(ai.run).not.toHaveBeenCalled();
      expect(ai.toMarkdown).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
      expect(await ledger.status()).toEqual(before);
    } finally {
      network.mockRestore();
      await runInDurableObject(ledger, (_instance, state) => {
        state.storage.sql.exec("DELETE FROM pilot_identity_probe WHERE nonce=?", nonce);
      });
    }
  });
});
