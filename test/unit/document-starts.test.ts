import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetDocumentStart, readDocumentStart, rememberDocumentStart } from "../../src/web/document-starts";

afterEach(() => vi.unstubAllGlobals());

describe("acknowledged document starts", () => {
  it("scopes the guard to a user and application and only clears the matching acknowledgement", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    rememberDocumentStart("user-1", "app-1", "document-1");
    expect(readDocumentStart("user-1", "app-1")).toBe("document-1");
    expect(readDocumentStart("user-2", "app-1")).toBeNull();
    expect(readDocumentStart("user-1", "app-2")).toBeNull();
    rememberDocumentStart("user-1", "app-1", "document-2");
    forgetDocumentStart("user-1", "app-1", "document-1");
    expect(readDocumentStart("user-1", "app-1")).toBe("document-2");
    forgetDocumentStart("user-1", "app-1", "document-2");
    expect(readDocumentStart("user-1", "app-1")).toBeNull();
  });

  it("does not turn a completed start into an error when browser storage is unavailable", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("disabled"); },
      setItem: () => { throw new Error("disabled"); },
      removeItem: () => { throw new Error("disabled"); },
    });
    expect(readDocumentStart("u", "a")).toBeNull();
    expect(() => rememberDocumentStart("u", "a", "d")).not.toThrow();
    expect(() => forgetDocumentStart("u", "a", "d")).not.toThrow();
  });
});
