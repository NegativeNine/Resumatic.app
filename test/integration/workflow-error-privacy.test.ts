import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it } from "vitest";
import { AppError, errorCode } from "../../src/shared/errors";
import { once, retrySafely, userMessage } from "../../src/workflows/steps";
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
    const expected = await caught(once(async () => { throw new AppError("invalid", "confirm some facts before tailoring a resume"); }));
    expect(expected).toBeInstanceOf(NonRetryableError);
    expect(userMessage(expected, "Fallback.")).toBe("Confirm some facts before tailoring a resume");
    expect(userMessage(new AppError("conflict", "experience changed while this draft was being made; generate it again"), "Fallback.")).toBe("Experience changed while this draft was being made; generate it again");

    const transient = await caught(retrySafely(async () => { throw new Error(`unavailable: ${privateText}`); }));
    expect(transient).not.toBeInstanceOf(NonRetryableError);
    expect(errorCode(transient)).toBe("unavailable");
    expect(transient.message).not.toContain(privateText);
    expect(userMessage(transient, "Fallback.")).toBe("Fallback.");

    for (const wrap of [once, retrySafely]) {
      const terminal = await caught(wrap(async () => { throw new NonRetryableError(privateText); }));
      expect(terminal).toBeInstanceOf(NonRetryableError);
      expect(terminal.message).not.toContain(privateText);
    }
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
