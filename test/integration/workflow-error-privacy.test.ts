import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chatComplete } from "../../src/ai/llm";
import { AppError, errorCode } from "../../src/shared/errors";
import { once, retrySafely, sourceFailureMessage, userMessage } from "../../src/workflows/steps";
import { runFleet, type FleetServices } from "../../src/workflows/fleet";
import type { WorkflowStep } from "cloudflare:workers";

const privateText = "private résumé: Morgan earned $987654321";

async function caught(fn: () => Promise<unknown>): Promise<Error> {
  try { await fn(); } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected the operation to fail");
}

describe("Workflow error privacy", () => {
  it("constructs model requests with a redirect mode supported by Workers", async () => {
    const result = await chatComplete(
      { accountId: "acct", token: "test", gatewayId: "gw", model: "example/model", temperature: 0, route: "extract" },
      [],
      z.object({ answer: z.number() }),
      async (url, init) => {
        const request = new Request(url, init);
        expect(request.redirect).toBe("manual");
        return Response.json({ choices: [{ message: { content: '{"answer":42}' } }] });
      },
    );
    expect(result).toEqual({ answer: 42 });
  });

  it("persists only reviewed model status and network categories", async () => {
    for (const detail of ["model provider HTTP 401", "model provider HTTP 403", "model provider HTTP 503", "model provider network failure", "model provider HTTP error"]) {
      const error = await caught(once(async () => { throw new AppError("unavailable", detail); }));
      expect(error.message).toBe(`unavailable: ${detail}`);
    }
    const privateDetail = `model provider HTTP 403 ${privateText}`;
    const forged = await caught(once(async () => { throw new AppError("unavailable", privateDetail); }));
    expect(forged.message).toBe("unavailable: Resumatic is busy right now. Try again in a few minutes.");
    expect(forged.message).not.toContain(privateText);
  });

  it("keeps unexpected and AppError-shaped provider messages out of step failures", async () => {
    const unexpected = await caught(once(async () => { throw new Error(privateText); }));
    expect(unexpected.message).toBe("workflow step failed");
    expect(unexpected.stack).not.toContain(privateText);
    expect(unexpected).not.toBeInstanceOf(NonRetryableError);

    const spoofed = await caught(once(async () => { throw new Error(`invalid: ${privateText}`); }));
    expect(spoofed).toBeInstanceOf(NonRetryableError);
    expect(errorCode(spoofed)).toBe("invalid");
    expect(spoofed.message).not.toContain(privateText);
    expect(userMessage(new Error(`invalid: ${privateText}`), "Fallback.")).not.toContain(privateText);
  });

  it("retains reviewed guidance and retry behavior without retaining arbitrary details", async () => {
    const expected = await caught(once(async () => { throw new AppError("invalid", "Confirm some facts before tailoring a resume."); }));
    expect(expected).toBeInstanceOf(NonRetryableError);
    expect(userMessage(expected, "Fallback.")).toBe("Confirm some facts before tailoring a resume.");
    expect(userMessage(new AppError("conflict", "Your facts changed while this draft was being made. Create it again."), "Fallback.")).toBe("Your facts changed while this draft was being made. Create it again.");
    // A detail that isn't reviewed falls back to its code's wording, still as a sentence.
    expect(userMessage(new AppError("conflict", "the resume changed; refresh and try again"), "Fallback.")).toBe("Something changed while Resumatic was working. Try again.");

    const transient = await caught(retrySafely(async () => { throw new Error(`unavailable: ${privateText}`); }));
    expect(transient).not.toBeInstanceOf(NonRetryableError);
    expect(errorCode(transient)).toBe("unavailable");
    expect(transient.message).not.toContain(privateText);
    expect(userMessage(transient, "Fallback.")).toBe("Fallback.");
    expect(sourceFailureMessage(transient)).toBe("Reading isn't available right now. Try again in a few minutes.");
    expect(sourceFailureMessage(new Error(privateText))).toBe("Resumatic couldn't finish reading this file. Try again in a few minutes.");
    expect(sourceFailureMessage(new AppError("invalid", "No text could be read from this file."))).toBe("No text could be read from this file.");

    for (const wrap of [once, retrySafely]) {
      const terminal = await caught(wrap(async () => { throw new NonRetryableError(privateText); }));
      expect(terminal).toBeInstanceOf(NonRetryableError);
      expect(terminal.message).not.toContain(privateText);
    }
  });

  it("does not trust a mutated AppError code or name as safe step metadata", async () => {
    const forged = new AppError("invalid", "invalid input");
    (forged as unknown as { code: string }).code = privateText;
    forged.name = privateText;
    const error = await caught(once(async () => { throw forged; }));
    expect(error.message).toBe("workflow step failed");
    expect(error.stack).not.toContain(privateText);
    expect(errorCode(error)).toBeNull();
  });

  it("does not expose exceptions thrown by error accessors or proxies", async () => {
    const malformed = new Error("initial");
    Object.defineProperty(malformed, "message", { get() { throw new Error(privateText); } });
    const coded = new AppError("conflict", "initial");
    Object.defineProperty(coded, "message", { get() { throw new Error(privateText); } });
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error(privateText); } });
    for (const thrown of [malformed, coded, proxy]) {
      for (const wrap of [once, retrySafely]) {
        const error = await caught(wrap(async () => { throw thrown; }));
        expect(error.message).not.toContain(privateText);
        expect(error.stack).not.toContain(privateText);
      }
    }
    expect((await caught(once(async () => { throw coded; }))).message)
      .toContain("conflict: Something changed while Resumatic was working. Try again.");
  });

  it.each(["list", "start", "status"] as const)("does not expose a fleet %s failure to the Workflow step", async (failAt) => {
    const step = { do: async (_name: string, _config: unknown, body: () => Promise<unknown>) => body() } as unknown as WorkflowStep;
    const services: FleetServices = {
      list: async () => {
        if (failAt === "list") throw new Error(privateText);
        return [{ vaultId: "a".repeat(64), state: "active" }];
      },
      start: async () => {
        if (failAt === "start") throw new Error(privateText);
        return { runId: "run" };
      },
      status: async () => {
        if (failAt === "status") throw new Error(privateText);
        return { state: "active" };
      },
    };
    const error = await caught(() => runFleet({} as Env, "test", { model: "@cf/test/model", dimensions: 3, maxVaults: 1 }, step, services));
    expect(error.message).toBe("workflow step failed");
    expect(error.stack).not.toContain(privateText);
  });
});
