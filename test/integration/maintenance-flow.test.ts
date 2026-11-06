import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import { directory, vault } from "../../src/shared/stubs";
import { vaultPrefix } from "../../src/shared/r2";
import type { TransferManifest } from "../../src/shared/operations";
import { RunStore } from "../../src/vault/runs";
import { readSession } from "../../src/worker/session";
import {
  eventually,
  fakeModels,
  JOB_DESCRIPTION,
  RESUME,
  signIn,
  topicVector,
  waitForResume,
  waitForSource,
} from "./support";

type VaultStub = ReturnType<typeof vault>;
const cleanup: (() => Promise<unknown>)[] = [];
beforeEach(() => setModels(() => fakeModels()));
afterEach(async () => {
  setModels(null);
  for (const restore of cleanup.splice(0).reverse()) await restore();
});

async function setFence(
  target: VaultStub | ReturnType<typeof directory>,
  ids: string[],
): Promise<void> {
  const prior = await runInDurableObject(target, (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const before = local.RESTORE_FENCE_IDS;
    local.RESTORE_FENCE_IDS = ids.join(",");
    return before;
  });
  cleanup.push(() =>
    runInDurableObject(target, (instance) => {
      (instance as unknown as { env: Env }).env.RESTORE_FENCE_IDS = prior;
    }),
  );
}

async function transfer(
  source: VaultStub,
  destination: VaultStub,
  operationId: string,
): Promise<TransferManifest> {
  const manifest = await source.transferManifest(operationId);
  await destination.importManifest(manifest);
  for (const table of manifest.tables) {
    let after = 0;
    for (;;) {
      const page = await source.transferPage(operationId, table.name, after, 2);
      await destination.importPage(page);
      if (page.done) break;
      after = page.lastRowid;
    }
  }
  return manifest;
}

async function session(user: Awaited<ReturnType<typeof signIn>>) {
  const session = await readSession(
    env.SESSION_KEY,
    user.cookie.slice("__Host-session=".length),
  );
  if (!session) throw new Error("test session is missing");
  return session;
}

describe("maintenance replacement lifecycle", () => {
  it("copies files and immutable versions, preserves current ledgers and switches the Directory under a fresh epoch", async () => {
    const user = await signIn();
    const oldSession = await session(user);
    const uploaded = await user.upload(
      "resume.docx",
      RESUME,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const { sourceId } = (await uploaded.json()) as { sourceId: string };
    await waitForSource(user, sourceId);
    const { facts } = await user.json("/api/facts");
    const { roles } = await user.json("/api/roles");
    await user.send("POST", "/api/review", {
      confirm: [...facts, ...roles].map((item: { id: string }) => item.id),
      reject: [],
    });
    const { applicationId } = (await (
      await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION })
    ).json()) as { applicationId: string };
    const { resumeId } = (await (
      await user.send("POST", `/api/applications/${applicationId}/resumes`)
    ).json()) as { resumeId: string };
    const original = await waitForResume(user, resumeId);
    const line = original.body.sections[0].lines[0];
    expect(
      (
        await user.send("PATCH", `/api/resumes/${resumeId}/lines/${line.id}`, {
          text: "My own edited description",
          expectedVersion: original.version,
        })
      ).status,
    ).toBe(204);
    const current = await user.json(`/api/resumes/${resumeId}`);
    const initialQuota = (await user.json("/api/me")).quota;
    const savedVersions = await user.json(`/api/resumes/${resumeId}/versions`);
    expect(initialQuota.used).toBe(1);

    const questionStart = await user.send(
      "POST",
      `/api/applications/${applicationId}/documents`,
      { kind: "questions" },
    );
    const { documentId } = (await questionStart.json()) as {
      documentId: string;
    };
    const interview = await eventually(async () => {
      const doc = await user.json(`/api/documents/${documentId}`);
      return doc.state === "ready" ? doc : null;
    }, "questions for transfer");
    const question = interview.result.questions[0];
    const answerResponse = await user.send(
      "POST",
      `/api/documents/${documentId}/questions/${question.id}/answer`,
      { roleId: null, answer: "I used Go for internal services." },
    );
    expect(answerResponse.status).toBe(201);
    const { factId: answerId } = (await answerResponse.json()) as {
      factId: string;
    };
    expect((await user.json("/api/me")).quota).toEqual(initialQuota);

    const op = crypto.randomUUID();
    const { targetVaultId } = await directory(env).prepareReplacement(
      oldSession.vid,
      op,
    );
    expect(await directory(env).prepareReplacement(oldSession.vid, op)).toEqual(
      { targetVaultId },
    );
    const source = vault(env, oldSession.vid);
    const target = vault(env, targetVaultId);
    const unfenced = await runInDurableObject(source, async (instance) => {
      try {
        await instance.transferManifest(op);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(unfenced).toContain("fenced");
    const ids = [oldSession.vid, targetVaultId];
    await setFence(source, ids);
    await setFence(target, ids);
    await setFence(directory(env), ids);
    await transfer(source, target, op);

    // The spend checkpoint is captured at finalization, after the content manifest was created.
    await runInDurableObject(source, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO meta (key,value) VALUES ('billing_checkout_sessions', ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value`, JSON.stringify(["cs_test_transfer"]));
      const runs = new RunStore(state.storage.sql, (callback) =>
        state.storage.transactionSync(callback),
      );
      runs.begin({
        id: "late-checkpoint",
        kind: "embed",
        targetId: "fact",
        requestKey: "late-checkpoint",
        inputDigest: "digest",
        steps: [],
      });
      runs.claim("late-checkpoint");
      runs.reserveAttempt(
        {
          id: "unknown-charge",
          runId: "late-checkpoint",
          step: "embed",
          attempt: 1,
          model: "test-model",
          maxCostMicros: 37,
        },
        100,
      );
      runs.markAttemptUnknown("unknown-charge");
      runs.fail("late-checkpoint", "response_lost");
    });
    expect(await target.finishImport(op, oldSession.vid)).toMatchObject({
      state: "ready",
    });
    expect(await target.billingCheckoutSessionsForDeletion()).toEqual(["cs_test_transfer"]);
    expect(await target.finishImport(op, oldSession.vid)).toMatchObject({
      state: "ready",
    });
    const copiedKey = await runInDurableObject(
      target,
      (_instance, state) =>
        state.storage.sql
          .exec<{ r2_key: string }>(
            `SELECT r2_key FROM sources WHERE id = ?`,
            sourceId,
          )
          .one().r2_key,
    );
    expect(copiedKey.startsWith(vaultPrefix(targetVaultId))).toBe(true);
    const targetFile = await env.FILES.get(copiedKey);
    expect(await targetFile?.text()).toBe(RESUME);
    const charge = await runInDurableObject(target, (_instance, state) =>
      state.storage.sql
        .exec<{ state: string; max_cost_micros: number }>(
          `SELECT state, max_cost_micros FROM model_attempts WHERE id = 'unknown-charge'`,
        )
        .one(),
    );
    expect(charge).toEqual({ state: "unknown", max_cost_micros: 37 });
    await directory(env).cutover(oldSession.vid, targetVaultId, op);
    await directory(env).cutover(oldSession.vid, targetVaultId, op);
    expect(await directory(env).existingIdentity("test", user.email)).toEqual({
      userId: oldSession.uid,
      vaultId: targetVaultId,
    });
    expect((await user.fetch("/api/me")).ok).toBe(false);

    // Removing the replacement fence does not make old-generation credentials valid there.
    await setFence(target, [oldSession.vid]);
    const oldCredential = await runInDurableObject(target, async (instance) => {
      try {
        await instance.getProfile({
          userId: oldSession.uid,
          gen: oldSession.gen,
          epoch: oldSession.epoch,
        });
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(oldCredential).toContain("session");
    const replacement = await signIn(user.email);
    const nextSession = await session(replacement);
    expect(nextSession.vid).toBe(targetVaultId);
    expect(nextSession.epoch).not.toBe(oldSession.epoch ?? "legacy");
    expect((await replacement.json("/api/me")).quota).toEqual(initialQuota);
    expect(await replacement.json(`/api/resumes/${resumeId}/versions`)).toEqual(
      savedVersions,
    );
    expect((await replacement.json(`/api/resumes/${resumeId}`)).body).toEqual(
      current.body,
    );
    expect(
      (
        await replacement.json(
          `/api/resumes/${resumeId}?version=${original.version}`,
        )
      ).body,
    ).toEqual(original.body);
    expect(
      (await replacement.json("/api/facts")).facts
        .map((fact: { id: string }) => fact.id)
        .sort(),
    ).toEqual(
      [...facts.map((fact: { id: string }) => fact.id), answerId].sort(),
    );
    const answerFact = (await replacement.json("/api/facts")).facts.find(
      (fact: { id: string }) => fact.id === answerId,
    );
    expect(answerFact.interview).toMatchObject({
      documentId,
      questionId: question.id,
      question: question.question,
      quote: "I used Go for internal services.",
    });
  });

  it("refuses publication when a source object is missing and keeps the original account pointer", async () => {
    const user = await signIn();
    const who = await session(user);
    const source = vault(env, who.vid);
    const sourceId = crypto.randomUUID();
    await runInDurableObject(source, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO sources (id,filename,r2_key,markdown,state,created_at) VALUES (?, 'missing.docx', ?, 'A source', 'ready', ?)`,
        sourceId,
        `${vaultPrefix(who.vid)}sources/${sourceId}`,
        Date.now(),
      );
    });
    const op = crypto.randomUUID();
    const { targetVaultId } = await directory(env).prepareReplacement(
      who.vid,
      op,
    );
    const target = vault(env, targetVaultId);
    const ids = [who.vid, targetVaultId];
    await setFence(source, ids);
    await setFence(target, ids);
    await setFence(directory(env), ids);
    await transfer(source, target, op);
    const failed = await runInDurableObject(target, async (instance) => {
      try {
        await instance.finishImport(op, who.vid);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(failed).toContain("source file is missing");
    const unready = await runInDurableObject(target, async (instance) => {
      try {
        await instance.activateImport(op, who.uid);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(unready).toContain("not ready");
    expect(
      await directory(env).existingIdentity("test", user.email),
    ).toMatchObject({ vaultId: who.vid });
    await env.FILES.put(
      `${vaultPrefix(who.vid)}sources/${sourceId}`,
      "A source",
    );
    expect(await target.finishImport(op, who.vid)).toMatchObject({
      state: "ready",
    });
  });

  it("rebuilds vectors through the durable workflow without consuming an output unit", async () => {
    const user = await signIn();
    const who = await session(user);
    expect(
      (
        await user.send("POST", "/api/facts", {
          roleId: null,
          kind: "skill",
          text: "Go",
          level: null,
        })
      ).status,
    ).toBe(201);
    const source = vault(env, who.vid);
    const before = (await user.json("/api/me")).quota;
    const { runId } = await source.startReembed(
      "@cf/baai/bge-m3",
      topicVector("Go").length,
    );
    const done = await eventually(async () => {
      const result = await source.reembedStatus(runId);
      return result.state !== "building" ? result : null;
    }, "re-embedding publication");
    expect(done).toMatchObject({
      state: "active",
      totalFacts: 1,
      pendingFacts: 0,
    });
    expect((await user.json("/api/me")).quota).toEqual(before);
    const vectorState = await runInDurableObject(
      source,
      (_instance, state) => ({
        generation: state.storage.sql
          .exec<{ value: string }>(
            `SELECT value FROM meta WHERE key = 'embedding_generation'`,
          )
          .one().value,
        dimensions: state.storage.sql
          .exec<{ value: string }>(
            `SELECT value FROM meta WHERE key = 'embedding_dimensions'`,
          )
          .one().value,
      }),
    );
    expect(vectorState).toEqual({
      generation: runId,
      dimensions: String(topicVector("Go").length),
    });
  });
});
