import { describe, expect, it } from "vitest";
import type { RolePatch, RoleView } from "../../src/shared/api";
import { roleWriteObserved } from "../../src/web/role-save";

const original: RoleView = {
  id: "role", revision: 4, kind: "job", org: "Example", title: "Engineer",
  startDate: "2021-03", endDate: null, state: "confirmed", quote: "Example Engineer", sourceId: "source",
};

describe("role edit reconciliation", () => {
  it("recognizes the submitted values only at exactly the next revision", () => {
    const patch: RolePatch = { expectedRevision: 4, title: "Senior Engineer" };
    const current = { ...original, revision: 5, title: "Senior Engineer" };
    expect(roleWriteObserved(current, original, patch)).toBe(true);
    for (const other of [
      { ...current, revision: 4 }, { ...current, revision: 6 },
      { ...current, title: "Director" }, { ...current, org: "Different" },
      { ...current, state: "rejected" as const }, { ...current, sourceId: "other" },
    ]) expect(roleWriteObserved(other, original, patch)).toBe(false);
  });

  it("preserves and compares unknown-end dates when the date inputs are locked", () => {
    const unknown: RoleView = { ...original, startDate: null, endDate: null, unknownEndStartDate: "2021-03" };
    const patch: RolePatch = { expectedRevision: 4, org: "New Example" };
    const current = { ...unknown, revision: 5, org: "New Example" };
    expect(roleWriteObserved(current, unknown, patch)).toBe(true);
    expect(roleWriteObserved({ ...current, unknownEndStartDate: null }, unknown, patch)).toBe(false);
    expect(roleWriteObserved({ ...current, startDate: "2021-03" }, unknown, patch)).toBe(false);
  });

  it("checks explicit date transitions and refuses missing or unsafe revisions", () => {
    const patch: RolePatch = { expectedRevision: 4, startDate: null, endDate: null, unknownEndStartDate: "2021-03" };
    const current: RoleView = { ...original, revision: 5, startDate: null, endDate: null, unknownEndStartDate: "2021-03" };
    expect(roleWriteObserved(current, original, patch)).toBe(true);
    expect(roleWriteObserved({ ...current, unknownEndStartDate: null }, original, patch)).toBe(false);
    expect(roleWriteObserved(current, { ...original, revision: undefined }, patch)).toBe(false);
    expect(roleWriteObserved(current, { ...original, revision: Number.MAX_SAFE_INTEGER }, patch)).toBe(false);
    expect(roleWriteObserved(undefined, original, patch)).toBe(false);
  });
});
