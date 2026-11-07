import { describe, expect, it } from "vitest";
import {
  transcribePages,
  validateTranscriptionInput,
} from "../../src/ai/transcribe";
import { modelAttempt } from "../../src/ai/usage";

function png(width = 1, height = 1): string {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return btoa(String.fromCharCode(...bytes));
}
const input = () => ({
  images: [{ mimeType: "image/png" as const, base64: png() }],
  referenceDate: "2026-11-06",
});

describe("bounded image transcription", () => {
  it("rejects excessive pages, wrong format, invalid base64 and pixel bombs before dispatch", () => {
    expect(() =>
      validateTranscriptionInput({
        ...input(),
        images: Array(5).fill(input().images[0]),
      }),
    ).toThrow("one to four");
    expect(() =>
      validateTranscriptionInput({
        ...input(),
        images: [{ mimeType: "image/jpeg", base64: png() }],
      }),
    ).toThrow("does not match");
    expect(() =>
      validateTranscriptionInput({
        ...input(),
        images: [{ mimeType: "image/png", base64: "!!!!" }],
      }),
    ).toThrow("valid base64");
    expect(() =>
      validateTranscriptionInput({
        ...input(),
        images: [{ mimeType: "image/png", base64: png(100_000, 100_000) }],
      }),
    ).toThrow("four million pixels");
  });
  it("requires operator configuration and never accepts provider license terms implicitly", async () => {
    let calls = 0;
    const env = {
      AI: {
        run: async () => {
          calls++;
        },
      },
    } as unknown as Env;
    await expect(transcribePages(env, input())).rejects.toThrow(
      "not configured",
    );
    expect(calls).toBe(0);
  });
  it("keeps page order, awaits attempt settlement and refuses incomplete transcription", async () => {
    const order: string[] = [];
    let page = 0;
    const env = {
      MODEL_TRANSCRIBE: "vision-test",
      AI: {
        run: async (_model: string, request: { image: string }) => {
          order.push("request");
          expect(request.image).toBe(png());
          return {
            response: `Built ${++page} services\n<END_OF_TRANSCRIPTION>`,
            usage: { input_tokens: 5, output_tokens: 5 },
          };
        },
      },
    } as unknown as Env;
    const output = await transcribePages(
      env,
      { ...input(), images: [...input().images, ...input().images] },
      {
        onAttemptStart: async () => {
          order.push("reserve");
        },
        onUsage: async () => {
          order.push("settle");
        },
      },
    );
    expect(order).toEqual([
      "reserve",
      "request",
      "settle",
      "reserve",
      "request",
      "settle",
    ]);
    expect(output.markdown).toContain("<!-- Page 1 -->\nBuilt 1 services");
    expect(output.markdown).toContain("<!-- Page 2 -->\nBuilt 2 services");
    const truncated = {
      MODEL_TRANSCRIBE: "vision-test",
      AI: { run: async () => ({ response: "Built services" }) },
    } as unknown as Env;
    await expect(transcribePages(truncated, input())).rejects.toThrow(
      "image_transcription_incomplete",
    );
  });
});

describe("attempt accounting order", () => {
  it("does not dispatch without a reservation and keeps network failures distinct from free calls", async () => {
    let dispatched = false;
    let failureId = "";
    let startedId = "";
    const request = {
      route: "extract",
      model: "test",
      inputChars: 1,
      maxOutputTokens: 1,
    };
    await expect(
      modelAttempt(
        request,
        {
          onAttemptStart: async () => {
            throw new Error("cap");
          },
        },
        async () => {
          dispatched = true;
        },
        () => undefined,
      ),
    ).rejects.toThrow("cap");
    expect(dispatched).toBe(false);
    await expect(
      modelAttempt(
        request,
        {
          onAttemptStart: async (attempt) => {
            startedId = attempt.attemptId;
          },
          onAttemptError: async (attempt) => {
            failureId = attempt.attemptId;
          },
        },
        async () => {
          throw new Error("network");
        },
        () => undefined,
      ),
    ).rejects.toThrow("network");
    expect(failureId).toBe(startedId);
    expect(failureId.length).toBeGreaterThan(0);
  });
});
