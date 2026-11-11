import { describe, expect, it, vi } from "vitest";
import { CLEF_MODEL, decisionJudge } from "../../src/ai/decision-judge";
import { AppError } from "../../src/shared/errors";
import { models } from "../../src/ai/models";
import { offers } from "../../src/pipeline/match";
import { splitLines } from "../../src/pipeline/split";
import { restModels, wranglerVars } from "../evals/rest-models";
import { EvalBudget } from "../extract-evals/budget";

const item = { alias: "L1", text: "Built a reporting tool", facts: [{ text: "Built a reporting tool", quote: null }] };
const answer = (choice = "supported", p = { supported: 0.98, unsupported: 0.01, overstated: 0.01 }) => ({ answers: { verdict: { type: "choice", choice, probabilities: p } }, usage: { input_tokens: 100, output_tokens: 0 } });
const setup = (response: unknown) => {
  const run = vi.fn(async (..._args: unknown[]) => response);
  return { run, env: { AI: { run }, AI_GATEWAY_ID: "gw", MODEL_JUDGE: CLEF_MODEL } as unknown as Env };
};

describe("Clef decision judge", () => {
  it("uses isolated typed decisions, suppressed gateway logs and per-call spending observers", async () => {
    const { run, env } = setup(answer());
    const start = vi.fn(), usage = vi.fn();
    const result = await decisionJudge(env, [item, { ...item, alias: "L2", text: "another line" }], { onAttemptStart: start, onUsage: usage });
    expect(result.verdicts.map(v => v.verdict)).toEqual(["supported", "supported"]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]).toEqual([CLEF_MODEL, expect.objectContaining({ state: { line: item.text, facts: item.facts }, questions: { verdict: expect.objectContaining({ type: "choice" }) } }), { gateway: { id: "gw", collectLog: false, skipCache: true } }]);
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[0]![0]).toMatchObject({ model: CLEF_MODEL, route: "judge", maxOutputTokens: 0 });
    expect(usage).toHaveBeenCalledTimes(2);
    expect(models(env).judge).toBeTypeOf("function");
  });

  it("does not accept uncertain or unsupported decisions", async () => {
    const { env } = setup(answer("supported", { supported: 0.6, unsupported: 0.3, overstated: 0.1 }));
    expect((await decisionJudge(env, [item])).verdicts[0]!.verdict).toBe("unsupported");
    const other = setup(answer("overstated", { supported: 0.01, unsupported: 0.1, overstated: 0.89 }));
    expect((await decisionJudge(other.env, [item])).verdicts[0]!.verdict).toBe("overstated");
  });

  it.each([{}, { answers: {} }, answer("supported", { supported: 1, unsupported: 1, overstated: 1 }), answer("supported", { supported: NaN, unsupported: 0, overstated: 0 })])("rejects incomplete and malformed results", async (response) => {
    const { env } = setup(response);
    await expect(decisionJudge(env, [item])).rejects.toThrow("unavailable");
  });

  it("reserves before dispatch and refuses input that could be truncated", async () => {
    const { run, env } = setup(answer());
    await expect(decisionJudge(env, [item], { onAttemptStart: () => { throw new Error("budget exhausted"); } })).rejects.toThrow("budget exhausted");
    await expect(decisionJudge(env, [{ ...item, text: "x".repeat(12_000) }])).rejects.toThrow("unavailable");
    expect(run).not.toHaveBeenCalled();
  });

  // The reservation runs before the call, outside the catch that replaces a provider's failure, so a
  // usage limit reaches the person as the usage limit it is and never as a network failure.
  it.each([
    new AppError("quota", "the configured model spend budget is exhausted"),
    new AppError("unavailable", "this model has no configured cost bound"),
  ])("lets a refusal by the budget out as itself: $message", async (refusal) => {
    const { run, env } = setup(answer());
    const thrown = await decisionJudge(env, [item], { onAttemptStart: () => { throw refusal; } }).catch((error: unknown) => error);
    expect(thrown).toBe(refusal);
    expect(run).not.toHaveBeenCalled();
  });

  // The binding's run is asynchronous, so a provider's failure arrives as a rejection.
  it.each([
    ["a provider error", async () => { throw new Error("upstream said: private provider text"); }, "model provider network failure"],
    ["a thrown string", async () => { throw "private provider text"; }, "model provider network failure"],
    ["a malformed answer", async () => ({ answers: { verdict: "private provider text" } }), "model provider HTTP error"],
  ])("replaces %s with a fixed sentence", async (_case, reply, sentence) => {
    const env = { AI: { run: vi.fn(reply) }, AI_GATEWAY_ID: "gw", MODEL_JUDGE: CLEF_MODEL } as unknown as Env;
    const thrown = await decisionJudge(env, [item]).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).message).toBe(`unavailable: ${sentence}`);
    expect(String((thrown as AppError).message)).not.toContain("private");
  });
});

// The live evals run the pipelines in Node, on models reached over Cloudflare's REST API. They
// measure the judge only if that adapter asks it as the Worker does.
describe("the judge in the REST evaluation adapter", () => {
  const creds = { accountId: "example", token: "unused", gatewayId: "test" };
  const CLEF_URL = "https://api.cloudflare.com/client/v4/accounts/example/ai/run/@cf/cloudflare/clef";
  const relevance = { answers: { relevance: { type: "choice", probabilities: { direct: 0.6, partial: 0.3, irrelevant: 0.1 } } }, usage: { input_tokens: 12, output_tokens: 0 } };
  /** Answers every request as the provider would, and keeps what was sent. */
  const provider = (verdict: unknown = answer()) => {
    const requests: { url: string; body: any; headers: Headers }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push({ url: String(url), body, headers: new Headers(init.headers) });
      await new Promise((resolve) => setTimeout(resolve, 1));
      return globalThis.Response.json({ result: body.questions?.relevance ? relevance : verdict });
    }));
    return requests;
  };
  const quietPilot = () => ({ reserve: vi.fn(async () => {}), settle: vi.fn(async () => {}), freeze: vi.fn(async () => {}) });

  it("is there exactly when the Worker has one, for the configuration each environment runs", () => {
    // Staging's is the configuration the live evals read. Whatever judge it names, and whatever
    // the top-level configuration names, the adapter and the Worker ask it the same way.
    const configured = [wranglerVars("staging"), wranglerVars(), { MODEL_JUDGE: CLEF_MODEL }, { MODEL_JUDGE: "openai/gpt-5" }, {}];
    for (const vars of configured)
      expect(typeof restModels(creds, vars, { budget: new EvalBudget({ usd: 1, maxCalls: 1 }), pilot: quietPilot() }).judge, JSON.stringify(vars.MODEL_JUDGE)).toBe(typeof models(vars as unknown as Env).judge);
    expect(restModels(creds, { MODEL_JUDGE: CLEF_MODEL }, { budget: new EvalBudget({ usd: 1, maxCalls: 1 }), pilot: quietPilot() }).judge).toBeTypeOf("function");
  });

  it("sends the Worker's own request for each line, and reserves it as input alone", async () => {
    const requests = provider();
    try {
      const budget = new EvalBudget({ usd: 1, maxCalls: 12 });
      const reserve = vi.spyOn(budget, "reserve");
      const pilot = quietPilot();
      const lines = [item, { ...item, alias: "L2", text: "another line" }];
      const worker = setup(answer());
      await decisionJudge(worker.env, lines);
      const judged = await restModels(creds, { MODEL_JUDGE: CLEF_MODEL }, { budget, pilot }).judge!(lines);
      expect(judged.verdicts.map((verdict) => [verdict.id, verdict.verdict])).toEqual([["L1", "supported"], ["L2", "supported"]]);
      // One typed-decision request for each line, to Workers AI and not to the chat endpoint.
      expect(requests.map((request) => request.url)).toEqual([CLEF_URL, CLEF_URL]);
      expect(requests.map((request) => request.body)).toEqual(worker.run.mock.calls.map((call) => call[1]));
      expect(requests[0]!.body).toMatchObject({ model: "clef", state: { line: item.text, facts: item.facts }, questions: { verdict: { type: "choice" } } });
      // Through the named gateway, with nothing logged and nothing served from its cache.
      expect(["cf-aig-gateway-id", "cf-aig-collect-log-payload", "cf-aig-skip-cache"].map((name) => requests[0]!.headers.get(name))).toEqual(["test", "false", "true"]);
      // The model is priced on input alone, so each line is reserved with no output bound.
      expect(reserve.mock.calls.map(([model, , maxOutputTokens, passes, weight]) => [model, maxOutputTokens, passes, weight])).toEqual([[CLEF_MODEL, 0, 6, 6], [CLEF_MODEL, 0, 6, 6]]);
      expect(budget.calls).toBe(12);
      expect([pilot.reserve.mock.calls.length, pilot.settle.mock.calls.length, pilot.freeze.mock.calls.length]).toEqual([2, 2, 0]);
    } finally { vi.unstubAllGlobals(); }
  });

  it("holds an answer to the Worker's threshold", async () => {
    provider(answer("supported", { supported: 0.6, unsupported: 0.3, overstated: 0.1 }));
    try {
      const rest = restModels(creds, { MODEL_JUDGE: CLEF_MODEL }, { budget: new EvalBudget({ usd: 1, maxCalls: 6 }), pilot: quietPilot() });
      expect((await rest.judge!([item])).verdicts).toMatchObject([{ id: "L1", verdict: "unsupported" }]);
    } finally { vi.unstubAllGlobals(); }
  });

  it("is what offers and divisions are put to, never a chat completion", async () => {
    const requests = provider();
    try {
      const rest = restModels(creds, { MODEL_JUDGE: CLEF_MODEL }, { budget: new EvalBudget({ usd: 1, maxCalls: 48 }), pilot: quietPilot() });
      expect(await offers(rest, [{ later: { id: "later", text: "Mentored 2 junior engineers every quarter" }, earlier: { id: "earlier", text: "Mentored 2 junior engineers" } }])).toEqual([{ relation: "same", from: "later", to: "earlier" }]);
      expect(requests.map((request) => [request.url, request.body.state.line])).toEqual([[CLEF_URL, "Mentored 2 junior engineers"], [CLEF_URL, "Mentored 2 junior engineers every quarter"]]);
      // The split eval gives the adapter a proposal and keeps everything else, the judge included.
      const line = "Led a team of 5 and shipped 3 products";
      const proposing = { ...rest, complete: async (_route: unknown, _messages: unknown, schema: { parse(value: unknown): unknown }) => schema.parse({ lines: [{ id: "1", parts: [{ kind: "clause", words: [{ from: 0, to: 4 }], of: null }, { kind: "clause", words: [{ from: 6, to: 8 }], of: null }] }] }) } as typeof rest;
      expect((await splitLines(proposing, [{ id: "fact", text: line }]))[0]!.refusal).toBeNull();
      expect(requests.slice(2).map((request) => [request.url, request.body.state.line])).toEqual([[CLEF_URL, "Led a team of 5"], [CLEF_URL, "shipped 3 products"], [CLEF_URL, line]]);
    } finally { vi.unstubAllGlobals(); }
  });

  it("asks one question at a time, so a ledger that admits one unsettled attempt is never refused or frozen", async () => {
    provider();
    try {
      // The shared pilot ledger refuses a reservation while another is unsettled, and a refusal freezes it for good.
      let pending = 0;
      const pilot = {
        reserve: vi.fn(async () => {
          if (pending) throw new Error("unavailable: another pilot attempt is unresolved");
          pending++;
        }),
        settle: vi.fn(async () => {
          pending--;
        }),
        freeze: vi.fn(async () => {}),
      };
      const rest = restModels(creds, { MODEL_JUDGE: CLEF_MODEL, RERANK_MODEL: CLEF_MODEL }, { budget: new EvalBudget({ usd: 1, maxCalls: 96 }), pilot });
      const lines = ["one", "two", "three", "four"].map((text, index) => ({ ...item, alias: `L${index + 1}`, text }));
      // The Worker starts four typed decisions at once, for the judge and for ranking alike.
      expect((await rest.judge!(lines)).verdicts.map((verdict) => verdict.id)).toEqual(["L1", "L2", "L3", "L4"]);
      expect(await rest.rerank("requirement", ["one", "two", "three", "four"])).toHaveLength(4);
      // And the two never overlap each other either.
      const [judged, ranked] = await Promise.all([rest.judge!(lines), rest.rerank("requirement", ["one", "two", "three", "four"])]);
      expect([judged.verdicts.length, ranked.length]).toEqual([4, 4]);
      expect([pilot.reserve.mock.calls.length, pilot.settle.mock.calls.length, pilot.freeze.mock.calls.length]).toEqual([16, 16, 0]);
      expect(pending).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
});
