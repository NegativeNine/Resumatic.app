import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { runModels } from "../../src/workflows/models";
import { PILOT_LEDGER_NAME } from "../../src/worker/pilot/ledger";
import { app } from "../../src/worker/routes";

const key = "test-pilot-key-for-local-only-1234567890";
const version = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const versionBinding = { id: version, tag: "", timestamp: "" };
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const base = () => ({ ...env, PILOT_SHARED_BUDGET: "true", PILOT_VERSION_METADATA: versionBinding } as Env);
const post = (bindings: Env, path: string, body: unknown, suppliedKey = key) => app.fetch(
  new Request(`https://resumatic.test/auth/test/pilot-budget/identity/${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-pilot-budget-key": suppliedKey }, body: JSON.stringify(body),
  }), bindings, context,
);

describe("staging pilot identity diagnostic", () => {
  it("observes only a matching real model-attempt wrapper; consumes once and never dispatches", async () => {
    const bindings = base();
    const vaultId = env.VAULT.newUniqueId().toString();
    const ai = { toMarkdown: vi.fn(), run: vi.fn() };
    bindings.AI = ai as unknown as Ai;
    const ledger = env.PILOT_BUDGET!.getByName(PILOT_LEDGER_NAME);
    const initial = await ledger.status();
    expect((await post(bindings, "begin", { path: "distill", vaultId }, "wrong")).status).toBe(403);
    for (const mode of [undefined, "false", "invalid"]) {
      const inactive = { ...bindings, PILOT_SHARED_BUDGET: mode } as Env;
      expect((await post(inactive, "begin", { path: "distill", vaultId })).status).toBe(503);
    }
    expect((await post(bindings, "begin", { path: "distill", vaultId, nonce: crypto.randomUUID() })).status).toBe(422);
    expect((await post({ ...bindings, PILOT_VERSION_METADATA: undefined } as Env, "begin", { path: "distill", vaultId })).status).toBe(503);
    const started = await post(bindings, "begin", { path: "distill", vaultId });
    expect(started.status).toBe(201);
    const { nonce } = await started.json() as { nonce: string };
    expect((await post(bindings, "begin", { path: "distill", vaultId })).status).toBe(409);
    expect(await (await post(bindings, "status", { nonce })).json()).toEqual({ state: "waiting" });
    await expect(runModels(bindings, vaultId, "wrong-path", "convert", "tailor").toMarkdown("test.pdf", new Blob(["synthetic"])))
      .rejects.toThrow("shared pilot identity and provider bounds are not verified");
    const other = env.VAULT.newUniqueId().toString();
    await expect(runModels(bindings, other, "wrong-vault", "convert", "distill").toMarkdown("test.pdf", new Blob(["synthetic"])))
      .rejects.toThrow("shared pilot identity and provider bounds are not verified");
    expect(await (await post(bindings, "status", { nonce })).json()).toEqual({ state: "waiting" });
    await expect(runModels(bindings, vaultId, "observed-run", "convert", "distill").toMarkdown("test.pdf", new Blob(["synthetic"])))
      .rejects.toThrow("pilot identity observation complete");
    expect(await (await post(bindings, "status", { nonce })).json()).toEqual({ state: "observed" });
    expect((await post(bindings, "consume", { nonce, runId: "other-run" })).status).toBe(409);
    const consumed = await post(bindings, "consume", { nonce, runId: "observed-run" });
    expect(await consumed.json()).toEqual({ path: "distill", vaultId, runId: "observed-run", step: "convert", workerVersion: version, runtimeVersion: version });
    expect((await post(bindings, "consume", { nonce, runId: "observed-run" })).status).toBe(410);
    expect(ai.toMarkdown).not.toHaveBeenCalled();
    expect(ai.run).not.toHaveBeenCalled();
    expect(await ledger.status()).toEqual(initial);
  });

  it("does not mistake a different ledger for the one reached by the HTTP endpoint", async () => {
    const bindings = base();
    const vaultId = env.VAULT.newUniqueId().toString();
    const started = await post(bindings, "begin", { path: "tailor", vaultId });
    const { nonce } = await started.json() as { nonce: string };
    const different = env.PILOT_BUDGET!.getByName("different-ledger");
    const otherBindings = { ...bindings, PILOT_BUDGET: { getByName: () => different } } as unknown as Env;
    await expect(runModels(otherBindings, vaultId, "different-run", "analyze", "tailor").toMarkdown("test.pdf", new Blob(["synthetic"])))
      .rejects.toThrow("shared pilot identity and provider bounds are not verified");
    expect(await (await post(bindings, "status", { nonce })).json()).toEqual({ state: "waiting" });
    const ledger = env.PILOT_BUDGET!.getByName(PILOT_LEDGER_NAME);
    await runInDurableObject(ledger, (_instance, state) => { state.storage.sql.exec("UPDATE pilot_identity_probe SET expires_at=0"); });
    expect((await post(bindings, "status", { nonce })).status).toBe(410);
    expect((await post(bindings, "consume", { nonce, runId: "different-run" })).status).toBe(410);
    expect((await post(bindings, "begin", { path: "tailor", vaultId })).status).toBe(201);
  });
});
