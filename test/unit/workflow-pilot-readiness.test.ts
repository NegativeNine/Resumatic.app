import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { runModels } from "../../src/workflows/models";

afterEach(() => vi.unstubAllGlobals());

it("does not dispatch paid pilot calls while deployment identity and provider bounds are unverified", async () => {
  const pilot = { reserve: vi.fn(), settle: vi.fn() };
  const localReserve = vi.fn();
  const fetcher = vi.fn();
  const ai = { run: vi.fn(), toMarkdown: vi.fn() };
  vi.stubGlobal("fetch", fetcher);
  const env = {
    PILOT_SHARED_BUDGET: "true", ALLOW_TEST_SIGNIN: "true",
    PILOT_BUDGET: { getByName: () => pilot },
    DAILY_SPEND_CAP_USD: "10", MODEL_PRICES_JSON: '{"openai/gpt-5.6-sol":[10,30]}',
    MODEL_JUDGE: "openai/gpt-5.6-sol", MODEL_TRANSCRIBE: "@cf/vision", AI: ai,
    VAULT: { idFromString: () => "vault", get: () => ({ reserveModelAttempt: localReserve, embeddingModel: () => "@cf/baai/bge-m3" }) },
  } as unknown as Env;
  const models = runModels(env, "vault", "run", "verify");
  await expect(models.complete("judge", [], z.object({ answer: z.number() }))).rejects.toThrow("shared pilot identity and provider bounds are not verified");
  await expect(models.embed(["fact"])).rejects.toThrow("shared pilot identity and provider bounds are not verified");
  await expect(models.rerank("query", ["fact"])).rejects.toThrow("shared pilot identity and provider bounds are not verified");
  await expect(models.toMarkdown("resume.pdf", new Blob(["file"]))).rejects.toThrow("shared pilot identity and provider bounds are not verified");
  await expect(models.extractFields!("resume", { title: { type: "text" } }, "2026-11-06")).rejects.toThrow("shared pilot identity and provider bounds are not verified");
  const png = new Uint8Array(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10], 0); png.set([73, 72, 68, 82], 12);
  new DataView(png.buffer).setUint32(16, 1); new DataView(png.buffer).setUint32(20, 1);
  await expect(models.transcribePages!({ images: [{ mimeType: "image/png", base64: btoa(String.fromCharCode(...png)) }], referenceDate: "2026-11-06" })).rejects.toThrow("shared pilot identity and provider bounds are not verified");
  expect(fetcher).not.toHaveBeenCalled(); expect(ai.run).not.toHaveBeenCalled(); expect(ai.toMarkdown).not.toHaveBeenCalled();
  expect(pilot.reserve).not.toHaveBeenCalled(); expect(localReserve).not.toHaveBeenCalled();
});
