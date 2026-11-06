import { describe, expect, it, vi } from "vitest";
import { completeReservedUpload } from "../../src/worker/upload-cleanup";
import { AppError } from "../../src/shared/errors";

describe("late upload cleanup", () => {
  it("removes a key only when the Vault authoritatively reports closure", async () => {
    const bucket = { delete: vi.fn(async (_key: string | string[]) => {}) };
    const gone = new AppError("gone", "the account is closed");
    await expect(
      completeReservedUpload(bucket, "unique-key", async () => {
        throw gone;
      }),
    ).rejects.toBe(gone);
    expect(bucket.delete).toHaveBeenCalledExactlyOnceWith("unique-key");
  });

  it("retains keys for signed-out, conflict, transient, and unknown failures", async () => {
    for (const failure of [
      new AppError("unauthenticated", "session ended"),
      new AppError("conflict", "request changed"),
      new AppError("unavailable", "retry"),
      new Error("connection lost"),
    ]) {
      const bucket = { delete: vi.fn(async (_key: string | string[]) => {}) };
      await expect(
        completeReservedUpload(bucket, "key", async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(bucket.delete).not.toHaveBeenCalled();
    }
  });

  it("leaves a successfully committed object alone", async () => {
    const bucket = { delete: vi.fn(async (_key: string | string[]) => {}) };
    expect(
      await completeReservedUpload(bucket, "key", async () => ({
        sourceId: "source",
      })),
    ).toEqual({ sourceId: "source" });
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("cleans a conflict only after an authoritative exact-reservation expiry check", async () => {
    const conflict = new AppError("conflict", "upload expired");
    for (const [result, remove] of [[true, true], [false, false]] as const) {
      const bucket = { delete: vi.fn(async (_key: string | string[]) => {}) };
      const expired = vi.fn(async () => result);
      await expect(completeReservedUpload(bucket, "unique-key", async () => { throw conflict; }, { expired })).rejects.toBe(conflict);
      expect(expired).toHaveBeenCalledOnce();
      expect(bucket.delete).toHaveBeenCalledTimes(Number(remove));
    }
  });

  it("retains the object when the expiry lookup fails or the session ends", async () => {
    const conflict = new AppError("conflict", "unknown state");
    for (const error of [new AppError("unauthenticated", "session ended"), new Error("connection lost")]) {
      const bucket = { delete: vi.fn(async (_key: string | string[]) => {}) };
      await expect(completeReservedUpload(bucket, "key", async () => { throw conflict; }, {
        expired: async () => { throw error; },
      })).rejects.toBe(conflict);
      expect(bucket.delete).not.toHaveBeenCalled();
    }
  });

  it("retries deletion twice, and logs only a fixed code if cleanup still fails", async () => {
    const failure = new AppError("gone", "the account is closed");
    const bucket = {
      delete: vi
        .fn()
        .mockRejectedValue(new Error("sensitive provider response")),
    };
    const wait = vi.fn(async (_ms: number) => {});
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        completeReservedUpload(
          bucket,
          "private-key",
          async () => {
            throw failure;
          },
          { wait },
        ),
      ).rejects.toBe(failure);
      expect(bucket.delete).toHaveBeenCalledTimes(3);
      expect(wait.mock.calls).toEqual([[30], [60]]);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        "late upload cleanup failed",
        { code: "r2_delete_failed" },
      );
    } finally {
      log.mockRestore();
    }
  });
});
