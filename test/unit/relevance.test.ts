import { describe, expect, it, vi } from "vitest";
import { relevanceScore, relevanceScores } from "../../src/ai/relevance";
import { rerankTexts } from "../../src/ai/vectors";
import { restModels } from "../evals/rest-models";
import { EvalBudget } from "../extract-evals/budget";

const response = (direct: number, partial = 0) => ({ answers: { relevance: { type: "choice", probabilities: { direct, partial, irrelevant: 1 - direct - partial } } }, usage: { input_tokens: 12, output_tokens: 0 } });
describe("Clef relevance ranking", () => {
  it("uses the same query/document and relevance contracts in the REST evaluation adapter", async () => {
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push(body);
      return globalThis.Response.json({ result: body.questions ? response(0.6, 0.3) : { data: [[1, 0]], usage: { input_tokens: 2 } } });
    }));
    try {
      const budget = new EvalBudget({ usd: 1, maxCalls: 24 });
      const pilot = { reserve: vi.fn(async () => {}), settle: vi.fn(async () => {}), freeze: vi.fn(async () => {}) };
      const m = restModels({ accountId: "example", token: "unused", gatewayId: "test" }, { EMBEDDING_MODEL: "@cf/qwen/qwen3-embedding-0.6b", RERANK_MODEL: "@cf/cloudflare/clef" }, { budget, pilot });
      await m.embed(["source fact"]);
      await m.embed(["requirement"], { purpose: "query" });
      expect(await m.rerank("requirement", ["source fact"])).toEqual([0.7]);
      expect(requests[0]).toEqual({ documents: ["source fact"] });
      expect(requests[1]).toMatchObject({ queries: ["requirement"], instruction: expect.any(String) });
      expect(requests[2].state).toEqual({ requirement: "requirement", candidateFact: "source fact" });
      expect(pilot.reserve).toHaveBeenCalledTimes(3);
    } finally { vi.unstubAllGlobals(); }
  });
  it("scores full and partial relevance without inventing a result for malformed responses", () => {
    expect(relevanceScore(response(0.6, 0.3))).toBeCloseTo(0.7);
    for (const raw of [{}, response(NaN), response(2), { answers: { relevance: { type: "choice", probabilities: { direct: 1, partial: 1, irrelevant: 1 } } } }])
      expect(() => relevanceScore(raw)).toThrow("unavailable");
  });

  it("keeps input order, isolates candidates, limits concurrency, and meters every call", async () => {
    let pending = 0, peak = 0;
    const run = vi.fn(async (_model: string, request: { state: { candidateFact: string } }) => {
      peak = Math.max(peak, ++pending);
      await new Promise(resolve => setTimeout(resolve, request.state.candidateFact === "0" ? 10 : 0));
      pending--;
      return response(Number(request.state.candidateFact) / 10);
    });
    const start = vi.fn(), usage = vi.fn();
    const env = { AI: { run }, AI_GATEWAY_ID: "test", RERANK_MODEL: "@cf/cloudflare/clef" } as unknown as Env;
    const scores = await rerankTexts(env, "requirement", ["0", "1", "2", "3", "4"], { onAttemptStart: start, onUsage: usage });
    expect(scores).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(peak).toBe(4);
    expect(run.mock.calls[0]).toEqual(["@cf/cloudflare/clef", expect.objectContaining({ state: { requirement: "requirement", candidateFact: "0" } }), { gateway: { id: "test", collectLog: false, skipCache: true } }]);
    expect(start).toHaveBeenCalledTimes(5);
    expect(start.mock.calls[0]![0]).toMatchObject({ route: "rerank", model: "@cf/cloudflare/clef", maxOutputTokens: 0 });
    expect(usage).toHaveBeenCalledTimes(5);
  });

  it("waits for in-flight settlements after a failure and does not dispatch the next wave", async () => {
    let finished = 0;
    const run = vi.fn(async (_model: string, request: { state: { candidateFact: string } }) => {
      if (request.state.candidateFact === "bad") throw new Error("private data");
      await new Promise(resolve => setTimeout(resolve, 5));
      finished++;
      return response(0.5);
    });
    const env = { AI: { run } } as unknown as Env;
    await expect(relevanceScores(env, "requirement", ["bad", "one", "two", "three", "never dispatched"]))
      .rejects.toThrow("model provider network failure");
    expect(finished).toBe(3);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("validates the complete batch and spending reservation before dispatch", async () => {
    const run = vi.fn(async () => response(1));
    const env = { AI: { run } } as unknown as Env;
    await expect(relevanceScores(env, "requirement", ["valid", "x".repeat(12_000)])).rejects.toThrow("unavailable");
    await expect(relevanceScores(env, "requirement", ["valid"], { onAttemptStart: () => { throw new Error("no budget"); } })).rejects.toThrow("no budget");
    expect(run).not.toHaveBeenCalled();
  });
});
