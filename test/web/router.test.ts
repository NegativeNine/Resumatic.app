import { describe, expect, it } from "vitest";
import { canonicalHash, href, parseRoute } from "../../src/web/router";

describe("parseRoute", () => {
  it("opens Facts for an empty hash", () => {
    expect(parseRoute("")).toEqual({ page: "facts" });
    expect(parseRoute("#/")).toEqual({ page: "facts" });
  });

  it("reads each top-level page", () => {
    for (const page of ["facts", "jobs", "account", "privacy", "terms"] as const) {
      expect(parseRoute(`#/${page}`)).toEqual({ page });
    }
  });

  it("still lands the v1 addresses on the renamed pages", () => {
    expect(parseRoute("#/sources")).toEqual({ page: "facts" });
    expect(parseRoute("#/applications")).toEqual({ page: "jobs" });
  });

  it("reads a resume and decodes its ID", () => {
    expect(parseRoute(href.resume("res 1/2"))).toEqual({ page: "resume", id: "res 1/2" });
  });

  it("answers notFound for anything else", () => {
    expect(parseRoute("#/nope")).toEqual({ page: "notFound" });
    expect(parseRoute("#/resumes")).toEqual({ page: "notFound" });
    expect(parseRoute("#/resumes/a/b")).toEqual({ page: "notFound" });
    expect(parseRoute("#/resumes/%E0%A4%A")).toEqual({ page: "notFound" });
    expect(parseRoute("#/sources/extra")).toEqual({ page: "notFound" });
  });
});

describe("canonicalHash", () => {
  it("rewrites only the v1 addresses", () => {
    expect(canonicalHash("#/sources")).toBe("#/facts");
    expect(canonicalHash("#/applications")).toBe("#/jobs");
    expect(canonicalHash("#/facts")).toBeNull();
    expect(canonicalHash("#/resumes/abc")).toBeNull();
    expect(canonicalHash("")).toBeNull();
  });
});
