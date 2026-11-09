import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/web/api";
import { describeError, signInErrorMessage } from "../../src/web/errors";

describe("describeError", () => {
  it("prefers the caller's words, then the server's message, then the fallbacks", () => {
    const tooLarge = new ApiError(413, "too_large", "Files can be up to 10 MB.");
    expect(describeError(tooLarge, { too_large: '"cv.pdf" is too large. Files can be up to 10 MB.' })).toBe(
      '"cv.pdf" is too large. Files can be up to 10 MB.',
    );
    expect(describeError(tooLarge)).toBe("Files can be up to 10 MB.");
    expect(describeError(new ApiError(404, "not_found", ""))).toBe("This couldn’t be found. It may have been removed.");
  });

  it("shows a server message as sentences", () => {
    expect(describeError(new ApiError(409, "conflict", "this run no longer accepts work"))).toBe("This run no longer accepts work.");
  });

  it("never shows a server error's body, and speaks in the interface's voice", () => {
    expect(describeError(new ApiError(500, "unavailable", "stack trace"))).toBe("Resumatic is busy right now. Try again in a minute.");
    expect(describeError(new ApiError(502, "http_502", "Bad gateway"))).toBe("Something went wrong in Resumatic. Try again in a moment.");
    for (const message of [
      describeError(new ApiError(418, "http_418", "")),
      describeError(new Error("boom")),
      signInErrorMessage("unavailable"),
      signInErrorMessage("server_error"),
    ]) {
      expect(message).not.toMatch(/\b(we|our|please)\b/i);
      expect(message).toMatch(/\.$/);
    }
  });
});
