import { describe, expect, it } from "vitest";
import { asSentence } from "../../src/shared/sentence";

describe("asSentence", () => {
  it("leaves a message written as sentences unchanged", () => {
    const written = "Files can be up to 10 MB.";
    expect(asSentence(written)).toBe(written);
    expect(asSentence("Your request was saved. Check back soon…")).toBe("Your request was saved. Check back soon…");
  });

  it("capitalises, reads a semicolon as a new sentence and ends with a full stop", () => {
    expect(asSentence("the resume changed; refresh and try again")).toBe("The resume changed. Refresh and try again.");
    expect(asSentence("  sign in to continue ")).toBe("Sign in to continue.");
    expect(asSentence("Something went wrong (HTTP 418)")).toBe("Something went wrong (HTTP 418).");
  });

  it("returns an empty message as it is", () => {
    expect(asSentence("")).toBe("");
    expect(asSentence("   ")).toBe("");
  });
});
