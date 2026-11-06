import { describe, expect, it, vi } from "vitest";
import { renderPdf } from "../../src/render/pdf";

describe("Browser Run during a shared pilot", () => {
  it("rejects pilot and malformed configuration before dispatch", async () => {
    const quickAction = vi.fn();
    const env = { PILOT_SHARED_BUDGET: "true", BROWSER: { quickAction } } as unknown as Env;
    await expect(renderPdf(env, "<p>test</p>")).rejects.toThrow("unavailable during the budgeted pilot");
    env.PILOT_SHARED_BUDGET = "TRUE";
    await expect(renderPdf(env, "<p>test</p>")).rejects.toThrow("pilot budget configuration is invalid");
    expect(quickAction).not.toHaveBeenCalled();
  });

  it("preserves ordinary non-pilot rendering", async () => {
    const quickAction = vi.fn().mockImplementation(async () => new Response("%PDF-1.7 test", {
      headers: { "content-type": "application/pdf" },
    }));
    const env = { BROWSER: { quickAction } } as unknown as Env;
    expect(new TextDecoder().decode(await renderPdf(env, "<p>test</p>"))).toBe("%PDF-1.7 test");
    env.PILOT_SHARED_BUDGET = "false";
    expect(new TextDecoder().decode(await renderPdf(env, "<p>test</p>"))).toBe("%PDF-1.7 test");
    expect(quickAction).toHaveBeenCalledTimes(2);
  });
});
