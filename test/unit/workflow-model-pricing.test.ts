import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runModels } from "../../src/workflows/models";

const model = "openai/gpt-5.6-sol";

afterEach(() => vi.unstubAllGlobals());

describe("workflow model spending bounds", () => {
  it.each([[0, 30], [10, 0], [0, 0]])(
    "rejects incomplete generative model prices %j before a request",
    async (inputPrice, outputPrice) => {
      const reserve = vi.fn();
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const env = {
        DAILY_SPEND_CAP_USD: "10",
        MODEL_PRICES_JSON: JSON.stringify({ [model]: [inputPrice, outputPrice] }),
        MODEL_JUDGE: model,
        VAULT: { idFromString: () => "id", get: () => ({ reserveModelAttempt: reserve }) },
      } as unknown as Env;
      await expect(runModels(env, "id", "run", "verify").complete(
        "judge", [], z.object({ answer: z.number() }),
      )).rejects.toThrow("this model has no configured cost bound");
      expect(reserve).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("reserves and settles a generative request with positive prices", async () => {
    const reserve = vi.fn();
    const settle = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      status: "completed", usage: { input_tokens: 17, output_tokens: 9 },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"answer":42}' }] }],
    }));
    vi.stubGlobal("fetch", fetcher);
    const env = {
      DAILY_SPEND_CAP_USD: "10", MODEL_PRICES_JSON: JSON.stringify({ [model]: [10, 30] }),
      MODEL_JUDGE: model,
      VAULT: { idFromString: () => "id", get: () => ({ reserveModelAttempt: reserve, settleModelAttempt: settle }) },
    } as unknown as Env;
    await expect(runModels(env, "id", "run", "verify").complete(
      "judge", [], z.object({ answer: z.number() }),
    )).resolves.toEqual({ answer: 42 });
    expect(reserve).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(expect.any(String), 440, 17, 9);
  });

  it.each([
    ["embed", "@cf/baai/bge-m3", { data: [[0.1, 0.2]], usage: { input_tokens: 3 } }, 6],
    ["rerank", "@cf/baai/bge-reranker-base", { response: [{ id: 0, score: 0.9 }], usage: { input_tokens: 3 } }, 9],
  ])("allows input-only %s prices and accounts for usage", async (route, modelId, response, cost) => {
    const reserve = vi.fn();
    const settle = vi.fn();
    const run = vi.fn().mockResolvedValue(response);
    const env = {
      DAILY_SPEND_CAP_USD: "10",
      MODEL_PRICES_JSON: JSON.stringify({ [modelId]: [cost / 3, 0] }),
      AI: { run },
      VAULT: { idFromString: () => "id", get: () => ({ reserveModelAttempt: reserve, settleModelAttempt: settle, embeddingModel: () => modelId }) },
    } as unknown as Env;
    const models = runModels(env, "id", "run", "step");
    if (route === "embed") await expect(models.embed(["source"])).resolves.toEqual([[0.1, 0.2]]);
    else await expect(models.rerank("query", ["source"])).resolves.toEqual([0.9]);
    expect(reserve).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(expect.any(String), cost, 3, null);
  });

  it("refuses an unbounded output price on an input-only model call", async () => {
    const modelId = "@cf/baai/bge-m3";
    const reserve = vi.fn();
    const settle = vi.fn();
    const run = vi.fn().mockResolvedValue({ data: [[0.1, 0.2]], usage: { input_tokens: 3 } });
    const env = {
      DAILY_SPEND_CAP_USD: "10",
      // The default output price is zero; this override is not.
      MODEL_PRICES_JSON: JSON.stringify({ [modelId]: [100, 50] }),
      AI: { run },
      VAULT: { idFromString: () => "id", get: () => ({ reserveModelAttempt: reserve, settleModelAttempt: settle, embeddingModel: () => modelId }) },
    } as unknown as Env;
    await expect(runModels(env, "id", "run", "step").embed(["source"]))
      .rejects.toThrow("this model has no configured cost bound");
    expect(reserve).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("does not settle missing usage with the built-in price when an override differs", async () => {
    const modelId = "@cf/baai/bge-m3"; // Built-in output price is zero.
    const reserve = vi.fn();
    const settle = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      usage: { input_tokens: 3 },
      choices: [{ message: { content: '{"answer":42}' } }],
    }));
    vi.stubGlobal("fetch", fetcher);
    const env = {
      DAILY_SPEND_CAP_USD: "10",
      MODEL_PRICES_JSON: JSON.stringify({ [modelId]: [100, 50] }),
      MODEL_JUDGE: modelId,
      VAULT: { idFromString: () => "id", get: () => ({ reserveModelAttempt: reserve, settleModelAttempt: settle }) },
    } as unknown as Env;
    await expect(runModels(env, "id", "run", "step").complete("judge", [], z.object({ answer: z.number() })))
      .resolves.toEqual({ answer: 42 });
    expect(reserve).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(expect.any(String), null, 3, null);
  });

  it("reserves a configured flat bound for an unknown model", async () => {
    const reserve = vi.fn();
    const settle = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      usage: { input_tokens: 17, output_tokens: 9 },
      choices: [{ message: { content: '{"answer":42}' } }],
    }));
    vi.stubGlobal("fetch", fetcher);
    const env = {
      DAILY_SPEND_CAP_USD: "10", MODEL_MAX_CALL_USD: "0.25", MODEL_JUDGE: "openai/unknown-model",
      VAULT: { idFromString: () => "id", get: () => ({ reserveModelAttempt: reserve, settleModelAttempt: settle }) },
    } as unknown as Env;
    await expect(runModels(env, "id", "run", "verify").complete(
      "judge", [], z.object({ answer: z.number() }),
    )).resolves.toEqual({ answer: 42 });
    expect(reserve).toHaveBeenCalledWith("run", "verify", expect.objectContaining({ model: "openai/unknown-model" }), 250_000, 10_000_000);
    expect(settle).toHaveBeenCalledWith(expect.any(String), null, 17, 9);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects an unknown model without a flat bound before dispatch", async () => {
    const reserve = vi.fn();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const env = {
      DAILY_SPEND_CAP_USD: "10", MODEL_JUDGE: "openai/unknown-model",
      VAULT: { idFromString: () => "id", get: () => ({ reserveModelAttempt: reserve }) },
    } as unknown as Env;
    await expect(runModels(env, "id", "run", "verify").complete(
      "judge", [], z.object({ answer: z.number() }),
    )).rejects.toThrow("this model has no configured cost bound");
    expect(reserve).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
