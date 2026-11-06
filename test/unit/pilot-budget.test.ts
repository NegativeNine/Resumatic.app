import { describe, expect, it } from "vitest";
import { EvalBudget } from "../extract-evals/budget";
import { reportUsage } from "../../src/ai/usage";

describe("pilot cost reservations", () => {
  it("prices the reranker at the reviewed rate", () => {
    expect(reportUsage("rerank", "@cf/baai/bge-reranker-base", { input_tokens: 1_000_000 }).costUsd).toBeCloseTo(0.00311, 10);
  });
  it("reserves the full serialized UTF-8 payload with fourfold and fixed overhead", () => {
    const budget = new EvalBudget({
      usd: 1,
      maxCalls: 1,
      prices: { "fake/model": [1, 2] },
    });
    budget.reserve(
      "fake/model",
      JSON.stringify({ prompt: "café", schema: { type: "object" } }),
      100,
    );
    const bytes = new TextEncoder().encode(
      JSON.stringify({ prompt: "café", schema: { type: "object" } }),
    ).length;
    expect(budget.reservedUsd).toBeCloseTo(
      (bytes * 4 + 4096 + 200) / 1_000_000,
      10,
    );
  });
  it("refuses unbounded output pricing and invalid pass counts before any attempt", () => {
    const budget = new EvalBudget({
      usd: 1,
      maxCalls: 2,
      prices: { "fake/model": [1, 0] },
    });
    expect(() => budget.reserve("fake/model", "input", 1)).toThrow(
      "live_eval_cost_bound_invalid",
    );
    expect(() => budget.reserve("fake/model", "input", 0, 0)).toThrow(
      "live_eval_cost_bound_invalid",
    );
    expect(() => budget.reserve("fake/model", "input", 0, 101)).toThrow(
      "live_eval_cost_bound_invalid",
    );
    expect(budget.calls).toBe(0);
  });
});

it("charges a conservative attempt weight before dispatch and refuses an oversized weight", () => {
  const budget = new EvalBudget({
    usd: 1,
    maxCalls: 3,
    prices: { "fake/model": [1, 1] },
  });
  budget.reserve("fake/model", "input", 100, 2, 2);
  expect(budget.calls).toBe(2);
  const reserved = budget.reservedUsd;
  expect(() => budget.reserve("fake/model", "input", 100, 2, 2)).toThrow(
    "live_eval_budget_exhausted",
  );
  expect(budget.calls).toBe(2);
  expect(budget.reservedUsd).toBe(reserved);
});

it("reserves six upstream calls for a gateway request before dispatch", async () => {
  const { vi } = await import("vitest");
  const { z } = await import("zod");
  const { restModels } = await import("../evals/rest-models");
  const budget = new EvalBudget({ usd: 1, maxCalls: 10 });
  const fetcher = vi.fn(async () =>
    Response.json({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  try {
    const model = restModels(
      { accountId: "example", token: "unused", gatewayId: "test" },
      { MODEL_WRITE: "@cf/openai/gpt-oss-20b" },
      { budget },
    );
    await model.complete("write", [], z.object({ ok: z.boolean() }));
    expect(budget.calls).toBe(6);
    await expect(
      model.complete("write", [], z.object({ ok: z.boolean() })),
    ).rejects.toThrow("live_eval_budget_exhausted");
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("does not follow a Workers AI redirect or issue another request", async () => {
  const { vi } = await import("vitest");
  const { restModels } = await import("../evals/rest-models");
  const budget = new EvalBudget({ usd: 1, maxCalls: 10 });
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 307, headers: { location: "https://other.example/model" } }));
  vi.stubGlobal("fetch", fetcher);
  try {
    const model = restModels({ accountId: "example", token: "unused", gatewayId: "test" }, {}, { budget });
    await expect(model.embed(["test"])).rejects.toThrow(/HTTP 307/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]!.redirect).toBe("error");
    expect(budget.calls).toBe(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(["overrun", "unknown", "failed"])(
  "stops further requests after %s",
  async (mode) => {
    const { vi } = await import("vitest");
    const { z } = await import("zod");
    const { restModels } = await import("../evals/rest-models");
    const budget = new EvalBudget({ usd: 10, maxCalls: 50 });
    const fetcher = vi.fn(async () => {
      if (mode === "failed") throw new Error("network failure");
      return Response.json({
        choices: [{ message: { content: '{"ok":true}' } }],
        ...(mode === "overrun"
          ? { usage: { prompt_tokens: 50_000_000, completion_tokens: 1 } }
          : {}),
      });
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const model = restModels(
        { accountId: "example", token: "unused", gatewayId: "test" },
        { MODEL_WRITE: "@cf/openai/gpt-oss-20b" },
        { budget },
      );
      await expect(
        model.complete("write", [], z.object({ ok: z.boolean() })),
      ).rejects.toThrow();
      await expect(
        model.complete("write", [], z.object({ ok: z.boolean() })),
      ).rejects.toThrow("live_eval_campaign_frozen");
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
