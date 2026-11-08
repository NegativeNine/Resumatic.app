import { describe, expect, it } from "vitest";
import { href, parseRoute } from "../../src/web/router";

describe("parseRoute", () => {
  it("opens the sources page for an empty hash", () => {
    expect(parseRoute("")).toEqual({ page: "sources" });
    expect(parseRoute("#/")).toEqual({ page: "sources" });
  });

  it("reads each top-level page", () => {
    for (const page of ["sources", "applications", "account", "privacy", "terms"] as const) {
      expect(parseRoute(`#/${page}`)).toEqual({ page });
    }
  });

  it("reads a resume and decodes its ID", () => {
    expect(parseRoute(href.resume("res 1/2"))).toEqual({ page: "resume", id: "res 1/2" });
  });

  it("answers notFound for anything else", () => {
    expect(parseRoute("#/nope")).toEqual({ page: "notFound" });
    expect(parseRoute("#/resumes")).toEqual({ page: "notFound" });
    expect(parseRoute("#/resumes/a/b")).toEqual({ page: "notFound" });
    expect(parseRoute("#/resumes/%E0%A4%A")).toEqual({ page: "notFound" });
  });
});
