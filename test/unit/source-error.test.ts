import { describe, expect, it } from "vitest";
import { sourceErrorMessage } from "../../src/web/source-error";

describe("source error guidance", () => {
  it("does not blame the file for legacy generic failures", () => {
    for (const error of [null, "We could not read this file.", "We couldn't read this file."])
      expect(sourceErrorMessage(error)).toBe("We couldn't finish reading this file. Please try again later.");
  });

  it("keeps specific service and file errors", () => {
    const unavailable = "Reading is temporarily unavailable. Please try again later.";
    const noText = "No text could be read from this file";
    expect(sourceErrorMessage(unavailable)).toBe(unavailable);
    expect(sourceErrorMessage(noText)).toBe(noText);
  });
});
