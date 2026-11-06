import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runModels } from "../../src/workflows/models";

// Exercise the accounting only under a fake future readiness capability. The
// production capability is unconditionally false and is tested separately.
vi.mock("../../src/workflows/pilot-readiness", () => ({ sharedPilotSafetyReady: () => true }));

const model = "openai/gpt-5.6-sol";
const schema = z.object({ answer: z.number() });
const reply = (text: string, usage: unknown = { input_tokens: 17, output_tokens: 9 }) => Response.json({
  status: "completed", usage,
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
});

function fixture() {
  const pilot = {
    reserve: vi.fn().mockResolvedValue(undefined),
    settle: vi.fn().mockResolvedValue({ frozen: false }),
  };
  const vault = {
    reserveModelAttempt: vi.fn().mockResolvedValue(undefined),
    settleModelAttempt: vi.fn().mockResolvedValue(undefined),
    embeddingModel: vi.fn().mockResolvedValue("@cf/baai/bge-m3"),
  };
  const ai = { run: vi.fn(), toMarkdown: vi.fn() };
  const env = {
    PILOT_SHARED_BUDGET: "true", ALLOW_TEST_SIGNIN: "true",
    PILOT_BUDGET: { getByName: vi.fn().mockReturnValue(pilot) },
    DAILY_SPEND_CAP_USD: "10", MODEL_PRICES_JSON: JSON.stringify({ [model]: [10, 30] }),
    MODEL_JUDGE: model, MODEL_EXTRACT: model, MODEL_TRANSCRIBE: "@cf/vision",
    VAULT: { idFromString: () => "vault", get: () => vault }, AI: ai,
  } as unknown as Env;
  return { env, pilot, vault, ai };
}

afterEach(() => vi.unstubAllGlobals());

describe("shared staging pilot workflow accounting", () => {
  it("reserves six possible gateway attempts before dispatch and settles conservatively", async () => {
    const { env, pilot, vault } = fixture();
    const fetcher = vi.fn().mockResolvedValue(reply('{"answer":42}'));
    vi.stubGlobal("fetch", fetcher);
    await expect(runModels(env, "vault", "run", "verify").complete("judge", [], schema)).resolves.toEqual({ answer: 42 });
    expect(pilot.reserve).toHaveBeenCalledOnce();
    const [id, reserved, calls] = pilot.reserve.mock.calls[0]!;
    expect(id).toEqual(expect.any(String));
    expect(reserved).toBeGreaterThan(440);
    expect(calls).toBe(6);
    const body = fetcher.mock.calls[0]![1]!.body as string;
    expect(reserved).toBe(6 * Math.ceil(body.length * 4 * 10 + 8192 * 30));
    expect(vault.reserveModelAttempt).toHaveBeenCalledWith("run", "verify", expect.objectContaining({ attemptId: id }), reserved, 10_000_000);
    expect(pilot.reserve.mock.invocationCallOrder[0]!).toBeLessThan(fetcher.mock.invocationCallOrder[0]!);
    expect(vault.reserveModelAttempt.mock.invocationCallOrder[0]!).toBeLessThan(fetcher.mock.invocationCallOrder[0]!);
    expect(pilot.settle).toHaveBeenCalledWith(id, 440);
    expect(vault.settleModelAttempt).toHaveBeenCalledWith(id, 440, 17, 9);
  });

  it("never dispatches if the shared reservation fails", async () => {
    const { env, pilot, vault } = fixture();
    pilot.reserve.mockRejectedValue(new Error("budget exhausted"));
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(runModels(env, "vault", "run", "verify").complete("judge", [], schema)).rejects.toThrow("budget exhausted");
    expect(vault.reserveModelAttempt).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a nonrefundable shared reservation when vault accounting rejects before dispatch", async () => {
    const { env, pilot, vault } = fixture();
    vault.reserveModelAttempt.mockRejectedValue(new Error("vault unavailable"));
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(runModels(env, "vault", "run", "verify").complete("judge", [], schema)).rejects.toThrow("vault unavailable");
    expect(pilot.settle).toHaveBeenCalledWith(expect.any(String), 0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("marks failures unknown and does not return a response after missing usage freezes the ledger", async () => {
    const first = fixture();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    await expect(runModels(first.env, "vault", "run", "verify").complete("judge", [], schema)).rejects.toThrow();
    expect(first.pilot.settle).toHaveBeenCalledWith(expect.any(String), null);
    expect(first.vault.settleModelAttempt).toHaveBeenCalledWith(expect.any(String), null, null, null);

    const second = fixture();
    second.pilot.settle.mockResolvedValue({ frozen: true });
    // Explicit null avoids the helper's default usage.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply('{"answer":42}', null)));
    await expect(runModels(second.env, "vault", "run", "verify").complete("judge", [], schema)).rejects.toThrow("shared pilot budget is frozen");
    expect(second.pilot.settle).toHaveBeenCalledWith(expect.any(String), null);
    expect(second.vault.settleModelAttempt).toHaveBeenCalledWith(expect.any(String), null, null, null);
  });

  it("does not return a result if shared settlement is unavailable", async () => {
    const { env, pilot, vault } = fixture();
    pilot.settle.mockRejectedValue(new Error("shared settlement unavailable"));
    const fetcher = vi.fn().mockResolvedValue(reply('{"answer":42}'));
    vi.stubGlobal("fetch", fetcher);
    await expect(runModels(env, "vault", "run", "verify").complete("judge", [], schema)).rejects.toThrow("shared settlement unavailable");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(pilot.reserve).toHaveBeenCalledOnce();
    // Neither ledger is assumed settled after a lost acknowledgement.
    expect(vault.settleModelAttempt).not.toHaveBeenCalled();
  });

  it("reserves separately for a schema retry", async () => {
    const { env, pilot } = fixture();
    const fetcher = vi.fn().mockResolvedValueOnce(reply('{"answer":"wrong"}')).mockResolvedValueOnce(reply('{"answer":42}'));
    vi.stubGlobal("fetch", fetcher);
    await expect(runModels(env, "vault", "run", "verify").complete("judge", [], schema)).resolves.toEqual({ answer: 42 });
    expect(pilot.reserve).toHaveBeenCalledTimes(2);
    expect(pilot.reserve.mock.calls[0]![0]).not.toBe(pilot.reserve.mock.calls[1]![0]);
    expect(pilot.reserve.mock.calls.every((args) => args[2] === 6)).toBe(true);
  });

  it("blocks unbounded binding routes, including typed-fact embedding, before dispatch", async () => {
    const { env, pilot, vault, ai } = fixture();
    const models = runModels(env, "vault", "run", "embed");
    await expect(models.embed(["typed fact"])).rejects.toThrow("not bounded for the shared pilot");
    await expect(models.rerank("query", ["fact"])).rejects.toThrow("not bounded for the shared pilot");
    await expect(models.toMarkdown("resume.pdf", new Blob(["file"]))).rejects.toThrow("not bounded for the shared pilot");
    await expect(models.extractFields!("resume", { title: { type: "text" } }, "2026-11-06")).rejects.toThrow("not bounded for the shared pilot");
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10], 0); png.set([73, 72, 68, 82], 12);
    new DataView(png.buffer).setUint32(16, 1); new DataView(png.buffer).setUint32(20, 1);
    await expect(models.transcribePages!({ images: [{ mimeType: "image/png", base64: btoa(String.fromCharCode(...png)) }], referenceDate: "2026-11-06" })).rejects.toThrow("not bounded for the shared pilot");
    expect(ai.run).not.toHaveBeenCalled(); expect(ai.toMarkdown).not.toHaveBeenCalled();
    expect(pilot.reserve).not.toHaveBeenCalled(); expect(vault.reserveModelAttempt).not.toHaveBeenCalled();
  });

  it("rejects flat unverified pricing, malformed mode and production-like configuration", async () => {
    const { env, pilot } = fixture();
    env.MODEL_JUDGE = "openai/unpriced"; env.MODEL_MAX_CALL_USD = "0.25";
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(runModels(env, "vault", "run", "verify").complete("judge", [], schema)).rejects.toThrow("not bounded for the shared pilot");
    expect(pilot.reserve).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    env.PILOT_SHARED_BUDGET = "TRUE";
    expect(() => runModels(env, "vault", "run", "verify")).toThrow("pilot budget configuration is invalid");
    env.PILOT_SHARED_BUDGET = "true"; env.ALLOW_TEST_SIGNIN = "false";
    expect(() => runModels(env, "vault", "run", "verify")).toThrow("staging pilot ledger is unavailable");
  });
});
