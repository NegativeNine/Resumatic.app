import { describe, expect, it } from "vitest";
import { EvalBudget } from "../extract-evals/budget";
import { reportUsage } from "../../src/ai/usage";
import { createPilotLedger } from "../extract-evals/budget-ledger.mjs";
import { chmodSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testPilot = {
  async reserve() {}, async settle() {}, async freeze() {},
};

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
  it("does not settle shared usage against a missing or different model reservation", () => {
    const budget = new EvalBudget({ usd: 1, maxCalls: 2, prices: { "fake/a": [1, 1], "fake/b": [1, 1] } });
    const attemptId = budget.reserve("fake/a", "input", 1);
    const usage = { attemptId, route: "write", model: "fake/a", inputTokens: 1, outputTokens: 1, costUsd: null };
    expect(budget.actualMicros(usage)).toBe(2);
    expect(budget.actualMicros({ ...usage, model: "fake/b" })).toBeNull();
    expect(budget.actualMicros({ ...usage, attemptId: "not-reserved" })).toBeNull();
    expect(budget.actualMicros({ ...usage, attemptId: undefined })).toBeNull();
  });
  it("freezes an in-memory budget when a usage report has no reservation", () => {
    const budget = new EvalBudget({ usd: 1, maxCalls: 2, prices: { "fake/model": [1, 1] } });
    expect(() => budget.observe({ route: "write", model: "fake/model", inputTokens: 1, outputTokens: 1, costUsd: null })).toThrow("live_eval_ledger_unavailable");
    expect(() => budget.reserve("fake/model", "input", 1)).toThrow("live_eval_campaign_frozen");
  });
  it("charges each in-memory reservation in whole microdollars", () => {
    const budget = new EvalBudget({ usd: 0.000001, maxCalls: 2, prices: { "fake/model": [0.00001, 0] } });
    budget.reserve("fake/model", "input", 0);
    expect(budget.reservedUsd).toBe(0.000001);
    expect(() => budget.reserve("fake/model", "input", 0)).toThrow("live_eval_budget_exhausted");
  });
  it("rejects a duplicate in-memory attempt identifier", () => {
    const budget = new EvalBudget({ usd: 1, maxCalls: 2, prices: { "fake/model": [1, 1] } });
    expect(() => budget.reserve("fake/model", "input", 1, 1, 1, "invalid id")).toThrow("live_eval_attempt_invalid");
    const attempt = budget.reserve("fake/model", "input", 1, 1, 1, "same-attempt");
    expect(() => budget.reserve("fake/model", "input", 1, 1, 1, attempt)).toThrow("live_eval_attempt_duplicate");
    expect(budget.calls).toBe(1);
    budget.observe({ attemptId: attempt, route: "write", model: "fake/model", inputTokens: 1, outputTokens: 1, costUsd: null });
    expect(() => budget.reserve("fake/model", "input", 1, 1, 1, attempt)).toThrow("live_eval_attempt_duplicate");
    expect(budget.calls).toBe(1);
  });
  it.each(["settle", "failed attempt"])("freezes locally if the persistent ledger disappears during %s", (action) => {
    const root = mkdtempSync(join(tmpdir(), "resumatic-pilot-test-"));
    chmodSync(root, 0o700);
    try {
      const ledger = createPilotLedger(root, 1_000_000, 2, 1);
      const budget = new EvalBudget({ usd: 0.5, maxCalls: 1, prices: { "fake/model": [1, 1] }, ledger: { file: ledger.file, suite: "extraction" } });
      const attemptId = budget.reserve("fake/model", "input", 1);
      renameSync(ledger.file, `${ledger.file}.unavailable`);
      const settle = () => action === "settle"
        ? budget.observe({ attemptId, route: "write", model: "fake/model", inputTokens: 1, outputTokens: 1, costUsd: null })
        : budget.failAttempt(attemptId);
      expect(settle).toThrow("live_eval_ledger_unavailable");
      renameSync(`${ledger.file}.unavailable`, ledger.file);
      expect(() => budget.reserve("fake/model", "input", 1)).toThrow("live_eval_campaign_frozen");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(["missing", "unknown", "different model"])("freezes locally before an unavailable ledger during %s usage", (kind) => {
    const root = mkdtempSync(join(tmpdir(), "resumatic-pilot-test-"));
    chmodSync(root, 0o700);
    try {
      const ledger = createPilotLedger(root, 1_000_000, 4, 2);
      const budget = new EvalBudget({ usd: 0.5, maxCalls: 2, prices: { "fake/model": [1, 1], "fake/other": [1, 1] }, ledger: { file: ledger.file, suite: "extraction" } });
      const attemptId = budget.reserve("fake/model", "input", 1);
      renameSync(ledger.file, `${ledger.file}.unavailable`);
      const usage = { route: "write", model: kind === "different model" ? "fake/other" : "fake/model", inputTokens: 1, outputTokens: 1, costUsd: null, ...(kind === "missing" ? {} : { attemptId: kind === "unknown" ? "not-reserved" : attemptId }) };
      expect(() => budget.observe(usage)).toThrow("live_eval_ledger_unavailable");
      renameSync(`${ledger.file}.unavailable`, ledger.file);
      expect(() => budget.reserve("fake/model", "input", 1)).toThrow("live_eval_campaign_frozen");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([
    [-1, 100],
    [0.5, 100],
    [100, -1],
    [100, 0.5],
  ])("freezes on malformed token counts (%s input, %s output)", (inputTokens, outputTokens) => {
    const budget = new EvalBudget({ usd: 1, maxCalls: 2, prices: { "fake/model": [1, 1] } });
    const attemptId = budget.reserve("fake/model", "input", 100);
    const usage = { attemptId, route: "write", model: "fake/model", inputTokens, outputTokens, costUsd: null };
    expect(budget.actualMicros(usage)).toBeNull();
    expect(() => budget.observe(usage)).toThrow("live_eval_campaign_frozen");
    expect(() => budget.reserve("fake/model", "another input", 100)).toThrow("live_eval_campaign_frozen");
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
  it("rejects a zero input rate even when a generative output rate is configured", async () => {
    const { vi } = await import("vitest");
    const { z } = await import("zod");
    const { restModels } = await import("../evals/rest-models");
    const modelId = "fake/model";
    const budget = new EvalBudget({
      usd: 10,
      maxCalls: 50,
      prices: { [modelId]: [0, 1] },
    });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    try {
      const models = restModels(
        { accountId: "example", token: "unused", gatewayId: "test" },
        { MODEL_WRITE: modelId },
        { budget, pilot: testPilot },
      );
      await expect(models.complete("write", [], z.object({ ok: z.boolean() })))
        .rejects.toThrow("live_eval_cost_bound_invalid");
      expect(budget.calls).toBe(0);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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
      { budget, pilot: testPilot },
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

it("freezes the shared coordinator when local settlement fails after shared settlement", async () => {
  const { vi } = await import("vitest");
  const { z } = await import("zod");
  const { restModels } = await import("../evals/rest-models");
  const budget = new EvalBudget({ usd: 1, maxCalls: 10 });
  const localFailure = new Error("local ledger unavailable");
  vi.spyOn(budget, "observe").mockImplementation(() => { throw localFailure; });
  const pilot = { reserve: vi.fn(async () => {}), settle: vi.fn(async () => {}), freeze: vi.fn(async () => {}) };
  const fetcher = vi.fn(async () => Response.json({
    choices: [{ message: { content: '{"ok":true}' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }));
  vi.stubGlobal("fetch", fetcher);
  try {
    const model = restModels(
      { accountId: "example", token: "unused", gatewayId: "test" },
      { MODEL_WRITE: "@cf/openai/gpt-oss-20b" },
      { budget, pilot },
    );
    await expect(model.complete("write", [], z.object({ ok: z.boolean() }))).rejects.toBe(localFailure);
    expect(pilot.settle).toHaveBeenCalledOnce();
    expect(pilot.freeze).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
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
    const model = restModels({ accountId: "example", token: "unused", gatewayId: "test" }, {}, { budget, pilot: testPilot });
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
        { budget, pilot: testPilot },
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
