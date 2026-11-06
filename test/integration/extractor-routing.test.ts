import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import { vault } from "../../src/shared/stubs";
import { readSession } from "../../src/worker/session";
import { fakeModels, RESUME, signIn, waitForSource } from "./support";

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => setModels(null));

it("pins a format strategy and preserves it on replay after configuration changes", async () => {
  const user = await signIn();
  const session = await readSession(
    env.SESSION_KEY,
    user.cookie.slice("__Host-session=".length),
  );
  expect(session).not.toBeNull();
  const { uid, vid, gen, epoch } = session!;
  const who = { userId: uid, gen, epoch };
  const stub = vault(env, vid);
  const prior = await runInDurableObject(stub, (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const value = local.EXTRACTOR_BY_FORMAT;
    local.EXTRACTOR_BY_FORMAT = JSON.stringify({
      pdf: "llm:@cf/openai/gpt-oss-120b",
      docx: "llm:@cf/openai/gpt-oss-20b",
    });
    return value;
  });
  const input = {
    requestKey: crypto.randomUUID(),
    descriptorDigest: "a".repeat(64),
    filename: "RESUME.PDF",
    byteLength: RESUME.length,
    contentType: "application/pdf",
    r2Key: `vaults/${vid}/sources/route-test`,
  };
  try {
    await stub.reserveUpload(who, input);
    await env.FILES.put(input.r2Key, RESUME);
    const { sourceId } = await stub.completeUpload(who, input);
    expect((await waitForSource(user, sourceId)).state).toBe("ready");
    expect((await stub.sourceProgress(sourceId, sourceId)).extractor).toBe(
      "llm:@cf/openai/gpt-oss-120b",
    );
    const longName = `${"🙂".repeat(110)}.docx`;
    const response = await user.upload(
      longName,
      RESUME,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(response.status).toBe(201);
    const { sourceId: docxId } = (await response.json()) as {
      sourceId: string;
    };
    expect((await waitForSource(user, docxId)).state).toBe("ready");
    const { sources } = await user.json<{
      sources: { id: string; filename: string; extractor: string }[];
    }>("/api/sources");
    const saved = sources.find((s) => s.id === docxId)!;
    expect(saved.filename.length).toBeLessThanOrEqual(200);
    expect(saved.filename.endsWith(".docx")).toBe(true);
    expect(
      Array.from(saved.filename).some((ch) => /^[\uD800-\uDFFF]$/.test(ch)),
    ).toBe(false);
    expect(saved.extractor).toBe("llm:@cf/openai/gpt-oss-20b");
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { env: Env }).env.EXTRACTOR_BY_FORMAT =
        "not-json";
    });
    expect(await stub.completeUpload(who, input)).toEqual({ sourceId });
    expect((await stub.reserveUpload(who, input)).intent.state).toBe(
      "complete",
    );
    const before = (await env.FILES.list({ prefix: `vaults/${vid}/sources/` }))
      .objects.length;
    const rejected = await user.upload("next.pdf", RESUME);
    expect(rejected.status).toBe(503);
    expect(
      (await env.FILES.list({ prefix: `vaults/${vid}/sources/` })).objects
        .length,
    ).toBe(before);
    expect((await stub.sourceProgress(sourceId, sourceId)).extractor).toBe(
      "llm:@cf/openai/gpt-oss-120b",
    );
  } finally {
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { env: Env }).env.EXTRACTOR_BY_FORMAT = prior;
    });
  }
});
