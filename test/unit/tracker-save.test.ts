import { describe, expect, it } from "vitest";
import type { ApplicationView } from "../../src/shared/api";
import { trackingWriteObserved } from "../../src/web/tracker-save";

const submitted = { status: "applied" as const, appliedAt: "2026-11-06", notes: "Contacted recruiter" };
const current: ApplicationView = {
  id: "app-1", revision: 3, ...submitted, company: null, title: null,
  excerpt: "", createdAt: 1, resumes: [],
};

describe("tracking save reconciliation", () => {
  it("recognizes only the exact values at the next revision", () => {
    expect(trackingWriteObserved(current, "app-1", 2, submitted)).toBe(true);
    for (const changed of [
      { id: "other" }, { revision: 2 }, { revision: 4 }, { revision: undefined },
      { status: "saved" as const }, { appliedAt: null }, { notes: "Changed" },
      { status: undefined }, { appliedAt: undefined }, { notes: undefined },
    ]) {
      expect(trackingWriteObserved({ ...current, ...changed }, "app-1", 2, submitted)).toBe(false);
    }
  });

  it("does not infer success without a valid original revision", () => {
    for (const revision of [undefined, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER])
      expect(trackingWriteObserved(current, "app-1", revision, submitted)).toBe(false);
    expect(trackingWriteObserved(undefined, "app-1", 2, submitted)).toBe(false);
  });
});
