import { describe, expect, it } from "vitest";
import { embedTexts } from "../../src/ai/vectors";
import { packVector, toUnit, topMatches } from "../../src/vault/search";
import { vi } from "vitest";
import { runModels } from "../../src/workflows/models";

describe("embedding model selection", () => {
  it("uses task-aware Qwen document and query inputs without applying query instructions to facts", async () => {
    const run = vi.fn(async () => ({ data: [[1, 0]] }));
    const env = { EMBEDDING_MODEL: "@cf/qwen/qwen3-embedding-0.6b", AI: { run }, AI_GATEWAY_ID: "test" } as unknown as Env;
    await embedTexts(env, ["career evidence"]);
    await embedTexts(env, ["job requirement"], {}, { purpose: "query" });
    expect(run.mock.calls[0]).toEqual([env.EMBEDDING_MODEL, { documents: ["career evidence"] }, expect.anything()]);
    expect(run.mock.calls[1]).toEqual([env.EMBEDDING_MODEL, { queries: ["job requirement"], instruction: "Given a job requirement, retrieve career facts that provide supporting experience." }, expect.anything()]);
  });

  it("preserves the active or snapshot model and forwards query purpose through the Workflow adapter", async () => {
    const run = vi.fn(async () => ({ data: [[1, 0]], usage: { input_tokens: 2 } }));
    let active = "@cf/baai/bge-m3";
    const env = { EMBEDDING_MODEL: "@cf/qwen/qwen3-embedding-0.6b", DAILY_SPEND_CAP_USD: "1", AI: { run },
      VAULT: { idFromString: () => "id", get: () => ({ embeddingModel: async () => active, reserveModelAttempt: async () => {}, settleModelAttempt: async () => {} }) },
    } as unknown as Env;
    const m = runModels(env, "id", "run", "search");
    await m.embed(["job requirement"], { purpose: "query" });
    expect(run.mock.calls[0]).toEqual(["@cf/baai/bge-m3", { text: ["job requirement"] }, expect.anything()]);
    active = "@cf/qwen/qwen3-embedding-0.6b";
    await m.embed(["job requirement"], { purpose: "query" });
    expect(run.mock.calls[1]).toEqual([active, expect.objectContaining({ queries: ["job requirement"] }), expect.anything()]);
  });
  it("uses the per-call snapshot model before the current deployment default and meters that identity", async () => {
    const requested: string[] = [];
    const metered: string[] = [];
    const env = {
      EMBEDDING_MODEL: "embedding-new",
      AI_GATEWAY_ID: "test",
      AI: {
        run: async (model: string, input: { text: string[] }) => {
          requested.push(model);
          return {
            data: input.text.map(() => [1, 0]),
            usage: { input_tokens: input.text.length, output_tokens: 0 },
          };
        },
      },
    } as unknown as Env;
    await embedTexts(
      env,
      ["Synthetic fact"],
      {
        onUsage: (usage) => {
          metered.push(usage.model);
        },
      },
      { model: "embedding-snapshot" },
    );
    await embedTexts(env, ["Synthetic fact"]);
    expect(requested).toEqual(["embedding-snapshot", "embedding-new"]);
    expect(metered).toEqual(["embedding-snapshot"]);
  });
  it("rejects invalid vectors and dimension drift between batches", async () => {
    let batch = 0;
    const env = {
      AI: {
        run: async (_model: string, input: { text: string[] }) => ({
          data: input.text.map(() => (batch++ < 50 ? [1, 0] : [1, 0, 0])),
        }),
      },
    } as unknown as Env;
    await expect(
      embedTexts(env, Array(51).fill("Synthetic fact")),
    ).rejects.toThrow("wrong shape");
    for (const vector of [[], [NaN], [Infinity], [0, 0], [1e300], [1e-100], Array(16_385).fill(1)]) {
      const malformed = {
        AI: { run: async () => ({ data: [vector] }) },
      } as unknown as Env;
      await expect(embedTexts(malformed, ["Synthetic fact"])).rejects.toThrow(
        "wrong shape",
      );
    }
  });

  it("rejects embeddings that cannot be represented or searched as float32", () => {
    for (const vector of [[0, 0], [1e300], [1e-100]]) {
      expect(() => packVector(vector)).toThrow("invalid_embedding_vector");
      expect(() => toUnit(vector)).toThrow("invalid_embedding_vector");
      expect(() => topMatches([vector], new Map(), 1)).toThrow("invalid_embedding_vector");
    }
    expect(Array.from(toUnit([3, 4]))).toEqual([0.6000000238418579, 0.800000011920929]);
  });

  it("reports provider usage even when an unusable vector is rejected", async () => {
    const usage: unknown[] = [];
    const env = { AI: { run: async () => ({ data: [[1e300]], usage: { input_tokens: 5 } }) } } as unknown as Env;
    await expect(embedTexts(env, ["Synthetic"], { onUsage: (entry) => { usage.push(entry); } })).rejects.toThrow("wrong shape");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 5 });
  });
});
