import { describe, expect, it } from "vitest";
import type { FactPatch, FactView } from "../../src/shared/api";
import { factWriteObserved } from "../../src/web/fact-save";

const original: FactView = {
  id: "fact", revision: 4, roleId: "role", kind: "accomplishment",
  text: "Built a service", level: "led", origin: "user", state: "confirmed",
  quote: null, sourceId: null,
};

describe("fact edit reconciliation", () => {
  it("accepts the submitted values only at the next revision", () => {
    const patch: FactPatch = { expectedRevision: 4, text: "Built an API", level: "implemented" };
    const current = { ...original, revision: 5, text: "Built an API", level: "implemented" as const };
    expect(factWriteObserved(current, original, patch)).toBe(true);
    for (const other of [
      { ...current, revision: 4 }, { ...current, revision: 6 },
      { ...current, text: "Another edit" }, { ...current, roleId: "other" },
      { ...current, state: "rejected" as const }, { ...current, level: "led" as const },
      { ...current, levelNeedsReview: true },
    ]) expect(factWriteObserved(other, original, patch)).toBe(false);
  });

  it("accounts for implicit level invalidation after a wording change", () => {
    const current = { ...original, revision: 5, text: "Built an API", level: null, levelNeedsReview: true };
    expect(factWriteObserved(current, original, { expectedRevision: 4, text: "Built an API" })).toBe(true);
    expect(factWriteObserved({ ...current, level: "led" }, original, { expectedRevision: 4, text: "Built an API" })).toBe(false);
    expect(factWriteObserved({ ...current, levelNeedsReview: true }, original, { expectedRevision: 4, text: "Built an API", level: null })).toBe(false);
  });

  it("checks role moves and changes to extracted facts without retaining an unconfirmed level", () => {
    const extracted: FactView = { ...original, origin: "extracted", quote: "Built a service", sourceId: "source" };
    const patch: FactPatch = { expectedRevision: 4, roleId: "role-2" };
    const current: FactView = { ...extracted, revision: 5, roleId: "role-2", origin: "user", level: null, levelNeedsReview: true };
    expect(factWriteObserved(current, extracted, patch)).toBe(true);
    expect(factWriteObserved({ ...current, roleId: "role" }, extracted, patch)).toBe(false);
    expect(factWriteObserved({ ...current, origin: "extracted" }, extracted, patch)).toBe(false);
    expect(factWriteObserved({ ...current, level: "led" }, extracted, patch)).toBe(false);
  });

  it("does not infer an omitted or unsafe original revision", () => {
    const current = { ...original, revision: 5 };
    expect(factWriteObserved(current, { ...original, revision: undefined }, {})).toBe(false);
    expect(factWriteObserved(current, { ...original, revision: Number.MAX_SAFE_INTEGER }, {})).toBe(false);
    expect(factWriteObserved(undefined, original, {})).toBe(false);
  });
});
