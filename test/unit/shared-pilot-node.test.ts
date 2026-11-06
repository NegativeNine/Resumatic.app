import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EvalBudget } from "../extract-evals/budget";
import { restModels } from "../evals/rest-models";
import { SharedPilotBudget } from "../evals/shared-pilot.mjs";

const creds = { accountId: "example", token: "unused", gatewayId: "test" };
const vars = { MODEL_WRITE: "@cf/openai/gpt-oss-20b" };
const schema = z.object({ ok: z.boolean() });

describe("shared pilot reservations for the direct evaluator", () => {
  it("awaits the shared reservation before dispatch and sends only accounting metadata", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const pilot = { reserve: vi.fn(async () => hold), settle: vi.fn(async () => {}), freeze: vi.fn(async () => {}) };
    const provider = vi.fn(async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    vi.stubGlobal("fetch", provider);
    try {
      const model = restModels(creds, vars, { budget: new EvalBudget({ usd: 1, maxCalls: 10 }), pilot });
      const result = model.complete("write", [{ role: "user", content: "private test career text" }], schema);
      await vi.waitFor(() => expect(pilot.reserve).toHaveBeenCalledTimes(1));
      expect(provider).not.toHaveBeenCalled();
      const [id, micros, calls] = pilot.reserve.mock.calls[0] as unknown as [string, number, number];
      expect(id).toMatch(/^[a-f0-9-]+$/);
      expect(micros).toBeGreaterThan(0);
      expect(calls).toBe(6);
      expect(JSON.stringify(pilot.reserve.mock.calls)).not.toContain("private test career text");
      release();
      await expect(result).resolves.toEqual({ ok: true });
      expect(pilot.settle).toHaveBeenCalledWith(id, 1);
      expect(provider).toHaveBeenCalledTimes(1);
    } finally { release(); vi.unstubAllGlobals(); }
  });

  it("never dispatches when the shared reservation is unavailable", async () => {
    const pilot = { reserve: vi.fn(async () => { throw new Error("unavailable"); }), settle: vi.fn(async () => {}), freeze: vi.fn(async () => {}) };
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);
    try {
      const model = restModels(creds, vars, { budget: new EvalBudget({ usd: 1, maxCalls: 20 }), pilot });
      await expect(model.complete("write", [], schema)).rejects.toThrow("unavailable");
      expect(provider).not.toHaveBeenCalled();
      expect(pilot.freeze).toHaveBeenCalledTimes(1);
      await expect(model.complete("write", [], schema)).rejects.toThrow("live_eval_campaign_frozen");
    } finally { vi.unstubAllGlobals(); }
  });

  it("reserves each direct Workers AI attempt before fetching", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const pilot = { reserve: vi.fn(async () => hold), settle: vi.fn(async () => {}), freeze: vi.fn(async () => {}) };
    const provider = vi.fn(async () => Response.json({ result: { data: [[1, 0]], usage: { input_tokens: 1 } } }));
    vi.stubGlobal("fetch", provider);
    try {
      const model = restModels(creds, {}, { budget: new EvalBudget({ usd: 1, maxCalls: 10 }), pilot });
      const result = model.embed(["private embedding text"]);
      await vi.waitFor(() => expect(pilot.reserve).toHaveBeenCalledTimes(1));
      expect(provider).not.toHaveBeenCalled();
      expect((pilot.reserve.mock.calls[0] as unknown as [string, number, number])[2]).toBe(1);
      expect(JSON.stringify(pilot.reserve.mock.calls)).not.toContain("private embedding text");
      release();
      await expect(result).resolves.toEqual([[1, 0]]);
      expect(pilot.settle).toHaveBeenCalledTimes(1);
    } finally { release(); vi.unstubAllGlobals(); }
  });

  it("freezes on unknown provider usage and never exposes the response", async () => {
    const pilot = { reserve: vi.fn(async () => {}), settle: vi.fn(async (_id: string, actual: number | null) => { if (actual === null) throw new Error("frozen"); }), freeze: vi.fn(async () => {}) };
    const provider = vi.fn(async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }));
    vi.stubGlobal("fetch", provider);
    try {
      const model = restModels(creds, vars, { budget: new EvalBudget({ usd: 1, maxCalls: 20 }), pilot });
      await expect(model.complete("write", [], schema)).rejects.toThrow("frozen");
      expect(pilot.settle.mock.calls[0]![1]).toBeNull();
      expect(pilot.freeze).toHaveBeenCalled();
      await expect(model.complete("write", [], schema)).rejects.toThrow("live_eval_campaign_frozen");
      expect(provider).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps the real coordinator closed until same-namespace identity is verified", async () => {
    const fetcher = vi.fn();
    const pilot = new SharedPilotBudget("https://staging.example.com", "a".repeat(32), fetcher);
    await expect(pilot.reserve("id", 1, 1)).rejects.toThrow("shared_pilot_identity_unverified");
    await expect(pilot.settle("id", null)).rejects.toThrow("shared_pilot_identity_unverified");
    await expect(pilot.freeze()).rejects.toThrow("shared_pilot_identity_unverified");
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => new SharedPilotBudget("http://staging.example.com", "a".repeat(32), fetcher)).toThrow("shared_pilot_configuration_required");
  });

  it("blocks the actual direct model adapter before provider dispatch while identity is unverified", async () => {
    const coordinatorFetch = vi.fn();
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);
    try {
      const pilot = new SharedPilotBudget("https://staging.example.com", "a".repeat(32), coordinatorFetch);
      const model = restModels(creds, vars, { budget: new EvalBudget({ usd: 1, maxCalls: 20 }), pilot });
      await expect(model.complete("write", [], schema)).rejects.toThrow("shared_pilot_identity_unverified");
      expect(coordinatorFetch).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
