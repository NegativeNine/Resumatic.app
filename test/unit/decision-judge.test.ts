import { describe, expect, it, vi } from "vitest";
import { CLEF_MODEL, decisionJudge } from "../../src/ai/decision-judge";
import { models } from "../../src/ai/models";

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
});
