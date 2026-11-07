import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { signIn } from "./support";

function session(cookie: string) {
  const payload = cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { uid: string; vid: string; gen: number; epoch?: string };
}

describe("document retry", () => {
  it("retries the stopped document with the same request key and preserves its quota reservation", async () => {
    const user = await signIn();
    const s = session(user.cookie);
    const who = { userId: s.uid, gen: s.gen, epoch: s.epoch };
    const stub = vault(env, s.vid);
    let stoppedRunId = "";
    await runInDurableObject(stub, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.DOCUMENTS;
      local.DOCUMENTS = { async create() { return {}; } } as unknown as Workflow;
      try {
        const { applicationId } = await instance.addApplication(who, "A detailed engineering role with experience in building software.");
        const started = await instance.startDocument(who, applicationId, { kind: "letter" }, crypto.randomUUID());
        stoppedRunId = started.runId;
        expect((await instance.getDocument(who, started.documentId)).retryRunId).toBeUndefined();
        await instance.failDocument(started.runId, "synthetic failure");
        expect(await instance.getDocument(who, started.documentId)).toMatchObject({ state: "failed", retryRunId: started.runId });
        const key = crypto.randomUUID();
        await expect(instance.retryRun({ userId: "someone-else", gen: s.gen }, started.runId, key)).rejects.toThrow();
        const retried = await instance.retryRun(who, started.runId, key);
        expect(retried.runId).not.toBe(started.runId);
        expect(await instance.retryRun(who, started.runId, key)).toEqual(retried);
        expect(await instance.getDocument(who, retried.targetId)).toMatchObject({ state: "running" });
        expect((await instance.me(who)).quota.reserved).toBe(1);
        expect((await instance.listDocuments(who, applicationId)).find((doc) => doc.id === started.documentId)?.retryRunId).toBe(started.runId);
      } finally { local.DOCUMENTS = original; }
    });
    const stranger = await signIn();
    const forbidden = await stranger.fetch(`/api/runs/${stoppedRunId}/retry`, {
      method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
    });
    expect(forbidden.ok).toBe(false);
  });
});
