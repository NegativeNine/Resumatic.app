import { describe, expect, it } from "vitest";
import type { FactRecord } from "../../src/shared/types";
import { assertGroundedResume, evidenceForFacts, sameEvidence } from "../../src/vault/snapshots";
import type { RenderData } from "../../src/shared/types";

const fact: FactRecord = {
  id: "fact-1", revision: 3, origin: "extracted", roleId: "role-1",
  kind: "accomplishment", text: "Led a migration", level: "led", quote: "Led a migration",
};

describe("immutable resume evidence", () => {
  it("captures a detached copy of all verification-relevant fields", () => {
    const captured = evidenceForFacts([fact]);
    expect(captured[fact.id]).toEqual(fact);
    expect(captured[fact.id]).not.toBe(fact);
    expect(sameEvidence(captured[fact.id], { ...fact })).toBe(true);
  });

  it("rejects metadata changes, including changes that retain text and quote", () => {
    const variants: FactRecord[] = [
      { ...fact, id: "fact-2" }, { ...fact, revision: 4 },
      { ...fact, origin: "user" }, { ...fact, roleId: "role-2" },
      { ...fact, kind: "credential" }, { ...fact, text: "Built a migration" },
      { ...fact, level: "owned" }, { ...fact, quote: "Led a larger migration" },
    ];
    for (const variant of variants) expect(sameEvidence(fact, variant)).toBe(false);
  });

  it("does not infer old or malformed evidence from matching text", () => {
    expect(sameEvidence(undefined, fact)).toBe(false);
    expect(sameEvidence({ ...fact, revision: undefined }, fact)).toBe(false);
    expect(sameEvidence({ ...fact, origin: undefined }, fact)).toBe(false);
    expect(() => evidenceForFacts([{ ...fact, revision: undefined }])).toThrow(/incomplete/);
    expect(() => evidenceForFacts([fact, { ...fact }])).toThrow(/incomplete/);
  });

  it("stores a hostile-looking identifier as data rather than changing the map prototype", () => {
    const special = { ...fact, id: "__proto__" };
    const captured = evidenceForFacts([special]);
    expect(Object.hasOwn(captured, "__proto__")).toBe(true);
    expect(sameEvidence(captured.__proto__, special)).toBe(true);
    expect(Object.getPrototypeOf(captured)).toBe(Object.prototype);
  });

  it("does not trust an old quote when the snapshot cannot establish its origin", () => {
    const render: RenderData = {
      profile: { name: "A User", email: "", phone: "", location: "", links: [] },
      body: { summary: { id: "line", text: "Built 10 services", factIds: ["fact-1"], status: "kept" }, sections: [], skills: [] },
      version: 1, company: null, title: null,
    };
    const stored = { "fact-1": { text: "Built services", quote: "Built 10 services" } };
    // A pre-provenance quote may describe an earlier user claim, so it does
    // not justify adding the number to a corrected claim.
    expect(() => assertGroundedResume(render, stored, "snapshot")).toThrow(/unverified/);
    const extracted = { ...fact, text: stored["fact-1"].text, quote: stored["fact-1"].quote, level: "implemented" as const };
    expect(() => assertGroundedResume(render, stored, "snapshot", evidenceForFacts([extracted]))).not.toThrow();
    const corrected = { ...extracted, origin: "user" as const };
    expect(() => assertGroundedResume(render, stored, "snapshot", evidenceForFacts([corrected]))).toThrow(/unverified/);
  });
});
