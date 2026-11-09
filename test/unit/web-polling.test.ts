import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, ApiNetworkError } from "../../src/web/api";
import { describeError } from "../../src/web/errors";
import { isTransientReadError } from "../../src/web/polling";

afterEach(() => vi.restoreAllMocks());

describe("progress poll failures", () => {
  it.each([408, 425, 429, 500, 502, 503, 599])("retries transient HTTP %i", (status) => {
    expect(isTransientReadError(new ApiError(status, "unavailable", ""))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 410, 422, 499])("stops polling on HTTP %i", (status) => {
    expect(isTransientReadError(new ApiError(status, "invalid", ""))).toBe(false);
  });

  it("retries a fetch failure without classifying arbitrary TypeErrors as network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("private browser detail"));
    const error = await api.sources().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiNetworkError);
    expect(isTransientReadError(error)).toBe(true);
    expect(describeError(error)).toMatch(/couldn’t be reached/);
    expect(isTransientReadError(new TypeError("application bug"))).toBe(false);
    expect(isTransientReadError(new SyntaxError("invalid JSON"))).toBe(false);
  });

  it.each(["AbortError", "TimeoutError"])("treats fetch %s as a connection failure", async (name) => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("private", name));
    const error = await api.sources().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiNetworkError);
    expect(isTransientReadError(error)).toBe(true);
  });

  it("retries an interrupted response body but not malformed JSON", async () => {
    const response = (error: Error) => {
      const result = new Response("{}", { headers: { "content-type": "application/json" } });
      vi.spyOn(result, "json").mockRejectedValue(error);
      return result;
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(new TypeError("stream interrupted")))
      .mockResolvedValueOnce(response(new SyntaxError("malformed JSON")));
    expect(isTransientReadError(await api.sources().catch((value: unknown) => value))).toBe(true);
    expect(isTransientReadError(await api.sources().catch((value: unknown) => value))).toBe(false);
  });
});
