import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { vault } from "../../src/shared/stubs";
import { nowSeconds, rsaSigner } from "../support/keys";
import { call } from "./support";

describe("reselecting a failed upload's extractor", () => {
  it("preserves ordinary pins, updates only on request, and binds the request key to that choice", async () => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    const who = { userId: "source-retry-extractor-owner", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = { workflow: local.DISTILL, model: local.MODEL_EXTRACT, extractor: local.EXTRACTOR };
      local.DISTILL = { async create() { return {}; }, async get() { return { async status() { return { status: "running" }; } }; } } as unknown as Workflow;
      local.MODEL_EXTRACT = "anthropic/claude-haiku-5.5";
      local.EXTRACTOR = "";
      try {
        const { sourceId } = await instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${vid}/sources/test` });
        const current = () => state.storage.sql.exec<{ extractor: string; run_id: string }>(`SELECT extractor,run_id FROM sources WHERE id=?`, sourceId).one();
        expect(current().extractor).toBe("llm:anthropic/claude-haiku-5.5");
        await instance.saveSource(sourceId, { state: "failed" }, sourceId);
        const expected = "llm:@cf/openai/gpt-oss-120b";
        // The caller and this Vault may temporarily run different deployments.
        await expect(instance.retryRunCurrentExtractorV1(who, sourceId, "stale", expected)).rejects.toThrow(/not consistent/);
        expect(current().run_id).toBe(sourceId);
        local.MODEL_EXTRACT = "@cf/openai/gpt-oss-120b";
        const ordinary = await instance.retryRun(who, sourceId, "ordinary");
        expect(current().extractor).toBe("llm:anthropic/claude-haiku-5.5");
        await expect(instance.retryRunCurrentExtractorV1(who, sourceId, "ordinary", expected)).rejects.toThrow(/retry options changed/);
        await instance.saveSource(sourceId, { state: "failed" }, ordinary.runId);
        const switched = await instance.retryRunCurrentExtractorV1(who, ordinary.runId, "switch", expected);
        expect(current()).toEqual({ extractor: expected, run_id: switched.runId });
        local.MODEL_EXTRACT = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
        expect(await instance.retryRunCurrentExtractorV1(who, ordinary.runId, "switch", expected)).toEqual(switched);
        await expect(instance.retryRunCurrentExtractorV1(who, ordinary.runId, "switch", `llm:${local.MODEL_EXTRACT}`)).rejects.toThrow(/retry options changed/);
        expect(current().extractor).toBe(expected);
        await expect(instance.retryRun(who, ordinary.runId, "switch")).rejects.toThrow(/retry options changed/);
      } finally {
        local.DISTILL = previous.workflow;
        local.MODEL_EXTRACT = previous.model;
        local.EXTRACTOR = previous.extractor;
      }
    });
  });

  it("rejects reselecting a source with a committed extraction and checks ownership", async () => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    const who = { userId: "source-retry-committed-owner", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.DISTILL;
      local.DISTILL = { async create() { return {}; } } as unknown as Workflow;
      try {
        const { sourceId } = await instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${vid}/sources/test` });
        await instance.saveSource(sourceId, { state: "failed" }, sourceId);
        state.storage.sql.exec(`INSERT INTO extraction_commits(source_id,roles,facts,dropped) VALUES (?,0,0,0)`, sourceId);
        const expected = `llm:${local.MODEL_EXTRACT}`;
        await expect(instance.retryRunCurrentExtractorV1({ userId: "other", gen: 1 }, sourceId, "switch", expected)).rejects.toThrow();
        await expect(instance.retryRunCurrentExtractorV1(who, sourceId, "switch", expected)).rejects.toThrow(/already committed/);
        expect((await instance.retryRun(who, sourceId, "ordinary")).targetId).toBe(sourceId);

        // Evidence from older schemas may exist even without a commit marker.
        const legacy = await instance.addSource(who, { filename: "legacy.pdf", r2Key: `vaults/${vid}/sources/legacy` });
        await instance.saveSource(legacy.sourceId, { state: "failed" }, legacy.sourceId);
        state.storage.sql.exec(`INSERT INTO evidence(id,source_id,quote) VALUES (?,?,?)`, crypto.randomUUID(), legacy.sourceId, "synthetic legacy evidence");
        await expect(instance.retryRunCurrentExtractorV1(who, legacy.sourceId, "switch", expected)).rejects.toThrow(/already committed/);
      } finally { local.DISTILL = previous; }
    });
  });

  it("exposes the versioned admin retry only behind Access and pins the Worker's expected model", async () => {
    const vid = env.VAULT.newUniqueId().toString();
    const stub = vault(env, vid);
    const who = { userId: "source-retry-admin-owner", gen: 1 };
    await stub.init(who.userId);
    const signer = await rsaSigner();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      String(input instanceof Request ? input.url : input) === `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`
        ? Response.json(signer.jwks) : new Response("unexpected", { status: 599 }));
    let previous: Workflow | undefined;
    try {
      const sourceId = await runInDurableObject(stub, async (instance, state) => {
        const local = (instance as unknown as { env: Env }).env;
        previous = local.DISTILL;
        local.DISTILL = { async create() { return {}; } } as unknown as Workflow;
        const created = await instance.addSource(who, { filename: "resume.pdf", r2Key: `vaults/${vid}/sources/test` });
        await instance.saveSource(created.sourceId, { state: "failed" }, created.sourceId);
        state.storage.sql.exec(`UPDATE sources SET extractor=? WHERE id=?`, "llm:@cf/openai/gpt-oss-120b", created.sourceId);
        return created.sourceId;
      });
      const path = `/admin/vaults/${vid}/runs/${sourceId}/retry-current-extractor`;
      expect((await call(path, { method: "POST" })).status).toBe(403);
      const token = await signer.sign({ iss: env.ACCESS_TEAM_DOMAIN, aud: [env.ACCESS_AUD], email: "admin@example.com", exp: nowSeconds() + 600 });
      const response = await call(path, { method: "POST", headers: { "cf-access-jwt-assertion": token, "idempotency-key": "admin-switch" } });
      expect(response.status).toBe(202);
      const result = await response.json() as { runId: string; targetId: string };
      expect(result.targetId).toBe(sourceId);
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec<{ extractor: string }>(`SELECT extractor FROM sources WHERE id=?`, sourceId).one().extractor).toBe(`llm:${env.MODEL_EXTRACT}`);
      });
    } finally {
      if (previous) await runInDurableObject(stub, (instance) => { (instance as unknown as { env: Env }).env.DISTILL = previous!; });
      vi.unstubAllGlobals();
    }
  });
});
