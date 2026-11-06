import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chatComplete } from "../../src/ai/llm";
import type { ModelAttempt, Usage } from "../../src/ai/usage";
import { EvalBudget } from "../extract-evals/budget";

const cfg = {
  accountId: "acct",
  token: "token",
  gatewayId: "gateway",
  model: "openai/gpt-5.6-sol",
  temperature: 0,
  route: "judge",
};
const schema = z.object({ answer: z.number() });
const completed = (text: string) => ({
  status: "completed",
  error: null,
  usage: { input_tokens: 17, output_tokens: 9 },
  output: [
    { type: "reasoning", id: "reasoning-1" },
    { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] },
  ],
});

describe("Responses-only model adapter", () => {
  it("uses the Responses wire contract, disables storage and accounts for usage", async () => {
    const calls: { url: string; init: RequestInit; body: any }[] = [];
    const started: ModelAttempt[] = [];
    const usage: Usage[] = [];
    const result = await chatComplete(
      { ...cfg, onAttemptStart: (a) => { started.push(a); }, onUsage: (u) => { usage.push(u); } },
      [{ role: "user", content: "synthetic request" }],
      schema,
      async (url, init) => {
        calls.push({ url, init, body: JSON.parse(String(init.body)) });
        return Response.json(completed('{"answer":42}'));
      },
    );
    expect(result).toEqual({ answer: 42 });
    expect(calls).toHaveLength(1);
    const [{ url, init, body }] = calls;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/responses");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get("cf-aig-gateway-id")).toBe("gateway");
    expect(headers.get("cf-aig-collect-log-payload")).toBe("false");
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(headers.get("cf-aig-max-attempts")).toBe("1");
    expect(body).toMatchObject({ model: cfg.model, store: false, prompt_cache_options: { mode: "explicit" }, max_output_tokens: 8192, text: { format: { type: "json_object" } } });
    expect(JSON.stringify(body)).not.toContain("prompt_cache_breakpoint");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("messages");
    expect(body.input[0]).toEqual({ role: "user", content: "synthetic request" });
    expect(body.input.at(-1).content).toContain('"answer"');
    expect(started).toHaveLength(1);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ attemptId: started[0]!.attemptId, inputTokens: 17, outputTokens: 9, costUsd: null });
  });

  it("retries invalid schema output and accounts for both attempts", async () => {
    const responses = [completed('{"answer":"wrong"}'), completed('{"answer":42}')];
    const sent: any[] = [];
    const usage: Usage[] = [];
    const out = await chatComplete({ ...cfg, onUsage: (u) => { usage.push(u); } }, [], schema, async (_url, init) => {
      sent.push(JSON.parse(String(init.body)));
      return Response.json(responses.shift());
    });
    expect(out).toEqual({ answer: 42 });
    expect(usage).toHaveLength(2);
    expect(usage[0]!.attemptId).not.toBe(usage[1]!.attemptId);
    expect(sent[1].input.at(-1).content).toMatch(/^That reply was not valid/);
  });

  it.each([
    ["incomplete", { ...completed('{"answer":42}'), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }],
    ["failed", { ...completed('{"answer":42}'), status: "failed", error: { message: "private career text" } }],
    ["refusal", { ...completed('{"answer":42}'), output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "private career text" }] }] }],
    ["missing content", { ...completed('{"answer":42}'), output: [{ type: "reasoning" }] }],
    ["tool call", { ...completed('{"answer":42}'), output: [...completed('{"answer":42}').output, { type: "function_call" }] }],
    ["multiple messages", { ...completed('{"answer":42}'), output: [completed('{"answer":42}').output[1], completed('{"answer":42}').output[1]] }],
  ])("fails closed for %s without exposing output", async (_label, response) => {
    const usage: Usage[] = [];
    const error = await chatComplete({ ...cfg, onUsage: (u) => { usage.push(u); } }, [], schema, async () => Response.json(response)).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected model call to fail");
    expect(error.message).not.toContain("private career text");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 17, outputTokens: 9 });
  });

  it("accounts for an HTTP failure as an unknown-spend attempt", async () => {
    const failed: ModelAttempt[] = [];
    await expect(chatComplete({ ...cfg, onAttemptError: (a) => { failed.push(a); } }, [], schema, async () => new Response("secret", { status: 503 }))).rejects.toThrow("HTTP 503");
    expect(failed).toHaveLength(1);
  });

  it("reserves and settles the Responses request through the evaluation budget", async () => {
    const budget = new EvalBudget({ usd: 5, maxCalls: 6, prices: { [cfg.model]: [10, 30] } });
    const out = await chatComplete({
      ...cfg,
      beforeAttempt: (model, input, maxTokens, attemptId) => { budget.reserve(model, input, maxTokens, 6, 6, attemptId); },
      onUsage: (usage) => { budget.observe(usage); },
      onAttemptError: ({ attemptId }) => { budget.failAttempt(attemptId); },
    }, [], schema, async () => Response.json(completed('{"answer":42}')));
    expect(out).toEqual({ answer: 42 });
    expect(budget.calls).toBe(6);
    expect(budget.measuredUsd).toBeCloseTo((17 * 10 + 9 * 30) / 1_000_000);
  });
});
