import { describe, expect, it } from "vitest";
import { AppError, errorCode, logErrorCode } from "../../src/shared/errors";

describe("log error codes", () => {
  it("uses only a fixed vocabulary even for mutated Error fields", () => {
    const sensitive = "Private resume for Avery Example";
    const error = new Error(sensitive);
    error.name = sensitive;
    expect(logErrorCode(error)).toBe("unexpected");
    expect(logErrorCode(new Error(`conflict: ${sensitive}`))).toBe("conflict");
    const forged = new AppError("invalid", "invalid input");
    (forged as unknown as { code: string }).code = sensitive;
    expect(logErrorCode(forged)).toBe("unexpected");
    expect(logErrorCode(null)).toBe("unexpected");
    expect(errorCode(new Error("Error: NonRetryableError: conflict: stale"))).toBe("conflict");
  });
});
