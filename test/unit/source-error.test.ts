import { describe, expect, it } from "vitest";
import { resumeErrorMessage, sourceErrorMessage } from "../../src/web/source-error";

describe("source error guidance", () => {
  it("does not blame the file for earlier generic failures", () => {
    for (const error of [
      null,
      "We could not read this file.",
      "We couldn't read this file.",
      "We couldn't finish reading this file. Please try again later.",
    ])
      expect(sourceErrorMessage(error)).toBe("Resumatic couldn't finish reading this file. Try again in a few minutes.");
  });

  it("rewords earlier service messages in the interface's voice", () => {
    expect(sourceErrorMessage("Reading is temporarily unavailable. Please try again later.")).toBe(
      "Reading isn't available right now. Try again in a few minutes.",
    );
    expect(sourceErrorMessage("Could not start this request. Please try again.")).toBe("Reading couldn't be started. Try again.");
  });

  it("keeps specific file errors, as sentences", () => {
    expect(sourceErrorMessage("No text could be read from this file.")).toBe("No text could be read from this file.");
    // Stored before messages were written as sentences.
    expect(sourceErrorMessage("No text could be read from this file")).toBe("No text could be read from this file.");
    expect(sourceErrorMessage("The uploaded file is missing; upload it again")).toBe("The uploaded file is missing. Upload it again.");
  });
});

describe("tailoring error guidance", () => {
  it("gives every failure a reason as sentences", () => {
    expect(resumeErrorMessage(null)).toBe("Tailoring stopped unexpectedly. Try again.");
    expect(resumeErrorMessage("Confirm some facts before tailoring a resume")).toBe("Confirm some facts before tailoring a resume.");
    expect(resumeErrorMessage("Could not start this request. Please try again.")).toBe("Tailoring couldn't be started. Try again.");
  });
});
