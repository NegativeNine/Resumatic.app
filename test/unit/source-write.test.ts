import { describe, expect, it, vi } from "vitest";
import { settleAcknowledgedSourceWrite } from "../../src/worker/source-write";
import { AppError } from "../../src/shared/errors";

describe("acknowledged source writes", () => {
  it("recreates the stub and retries only the acknowledgement after an RPC failure", async () => {
    const finish = vi.fn().mockRejectedValueOnce(new Error("lost acknowledgement")).mockResolvedValueOnce(undefined);
    const vault = vi.fn(() => ({ finishCacheWrite: finish }));
    const wait = vi.fn(async (_ms: number) => {});
    await settleAcknowledgedSourceWrite(vault, "owner", "attempt", wait);
    expect(vault).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenNthCalledWith(1, "owner", "attempt");
    expect(finish).toHaveBeenNthCalledWith(2, "owner", "attempt");
    expect(wait).toHaveBeenCalledExactlyOnceWith(30);
  });

  it("bounds retries and does not retry an overloaded object", async () => {
    const unavailable = vi.fn().mockRejectedValue(new Error("unavailable"));
    const wait = vi.fn(async (_ms: number) => {});
    await expect(settleAcknowledgedSourceWrite(() => ({ finishCacheWrite: unavailable }), "owner", "attempt", wait)).rejects.toThrow("unavailable");
    expect(unavailable).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[30], [60]]);
    const overloaded = vi.fn().mockRejectedValue(Object.assign(new Error("overloaded"), { overloaded: true }));
    await expect(settleAcknowledgedSourceWrite(() => ({ finishCacheWrite: overloaded }), "owner", "attempt")).rejects.toThrow("overloaded");
    expect(overloaded).toHaveBeenCalledTimes(1);
    const denied = vi.fn().mockRejectedValue(new AppError("forbidden", "not this user's vault"));
    await expect(settleAcknowledgedSourceWrite(() => ({ finishCacheWrite: denied }), "owner", "attempt", wait)).rejects.toThrow("forbidden");
    expect(denied).toHaveBeenCalledTimes(1);
  });
});
