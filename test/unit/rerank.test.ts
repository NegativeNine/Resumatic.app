import { afterEach, describe, expect, it, vi } from "vitest";
import { rerankScores } from "../../src/ai/rerank";
import { rerankTexts } from "../../src/ai/vectors";
import { restModels } from "../evals/rest-models";
import { EvalBudget } from "../extract-evals/budget";

afterEach(() => vi.unstubAllGlobals());

describe("reranker response validation", () => {
  it("restores input order without constraining valid negative scores", () => {
    expect(rerankScores({ response: [{ id: 1, score: -0.5 }, { id: 0, score: 0.8 }] }, 2))
      .toEqual([0.8, -0.5]);
  });

  it.each([
    ["missing response", {}],
    ["partial response", { response: [{ id: 0, score: 0.1 }] }],
    ["duplicate id", { response: [{ id: 0, score: 0.1 }, { id: 0, score: 0.2 }] }],
    ["negative id", { response: [{ id: -1, score: 0.1 }, { id: 1, score: 0.2 }] }],
    ["out of bounds id", { response: [{ id: 2, score: 0.1 }, { id: 1, score: 0.2 }] }],
    ["fractional id", { response: [{ id: 0.5, score: 0.1 }, { id: 1, score: 0.2 }] }],
    ["non-finite score", { response: [{ id: 0, score: Number.NaN }, { id: 1, score: 0.2 }] }],
    ["string score", { response: [{ id: 0, score: "0.1" }, { id: 1, score: 0.2 }] }],
  ])("rejects %s rather than assigning an invented score", (_name, response) => {
    expect(() => rerankScores(response, 2)).toThrow("rerank_response_shape");
  });

  it("makes the Worker and eval adapters reject the same incomplete result", async () => {
    const incomplete = { response: [{ id: 0, score: 0.1 }], usage: { input_tokens: 10 } };
    const env = { AI_GATEWAY_ID: "test", AI: { run: vi.fn(async () => incomplete) } } as unknown as Env;
    await expect(rerankTexts(env, "query", ["first", "second"]))
      .rejects.toThrow("rerank_response_shape");
    expect(env.AI.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ top_k: 2 }), expect.anything());

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ result: incomplete })));
    const budget = new EvalBudget({ usd: 1, maxCalls: 6 });
    const pilot = { reserve: vi.fn(async () => {}), settle: vi.fn(async () => {}), freeze: vi.fn(async () => {}) };
    const models = restModels({ accountId: "example", token: "unused", gatewayId: "test" }, {}, { budget, pilot });
    await expect(models.rerank("query", ["first", "second"]))
      .rejects.toThrow("rerank_response_shape");
    const request = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(JSON.parse(request.body as string)).toMatchObject({ top_k: 2 });
    expect(request.headers).toMatchObject({ "cf-aig-gateway-id": "test", "cf-aig-collect-log-payload": "false", "cf-aig-skip-cache": "true", "cf-aig-max-attempts": "1" });
    // The provider call was still made and its known usage is accounted for.
    expect(budget.calls).toBe(6);
    expect(pilot.settle).toHaveBeenCalledOnce();
  });
});
