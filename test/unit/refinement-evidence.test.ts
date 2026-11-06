import { describe, expect, it } from "vitest";
import type { FactRecord, RenderData } from "../../src/shared/types";
import { mergeRefinementEvidence } from "../../src/vault/refinement-evidence";
import { evidenceForFacts, type ResumeVersion } from "../../src/vault/snapshots";

const fact = (id: string, text: string): FactRecord => ({
  id, text, quote: null, origin: "user", revision: 1, roleId: "r", kind: "accomplishment", level: "implemented",
});
const a = fact("a", "Built Go services"), b = fact("b", "Shipped APIs");
const roles = [{ id: "r", kind: "job" as const, org: "Acme", title: "Engineer", startDate: null, endDate: null }];
function baseline(): ResumeVersion {
  const render = { version: 1, profile: { name: "", email: "", phone: "", location: "", links: [] }, company: null, title: null,
    body: { summary: null, skills: [], sections: [{ roleId: "r", kind: "job", org: "Acme", title: "Engineer", startDate: null, endDate: null, lines: [
      { id: "l1", text: "Built Go services", factIds: ["a"], status: "kept" },
      { id: "l2", text: "Shipped APIs", factIds: ["b"], status: "kept" },
    ] }] } } as RenderData;
  return { render, report: null, provenance: "snapshot", facts: { a: { text: a.text, quote: null }, b: { text: b.text, quote: null } }, evidence: evidenceForFacts([a,b]) };
}

describe("refinement evidence", () => {
  it("preserves unchanged evidence and updates only newly verified evidence", () => {
    const base = baseline(), body = structuredClone(base.render.body);
    body.sections[0]!.lines[0]!.text = "Built services";
    const newer = { ...a, text: "Built Go services and tools", revision: 2 };
    const merged = mergeRefinementEvidence(base, body, [newer, { ...b, text: "Changed later", revision: 2 }], roles);
    expect(merged.facts.a.text).toBe(newer.text);
    expect(merged.facts.b.text).toBe(b.text);
    expect(merged.evidence?.b).toEqual(b);
  });
  it("allows a shared fact only when its complete evidence is identical", () => {
    const base = baseline();
    base.render.body.sections[0]!.lines[1]!.factIds = ["a"];
    const body = structuredClone(base.render.body);
    body.sections[0]!.lines[0]!.text = "Built services";
    expect(mergeRefinementEvidence(base, body, [a,b], roles).facts.a.text).toBe(a.text);
    expect(() => mergeRefinementEvidence(base, body, [{ ...a, level: "led", revision: 2 }, b], roles)).toThrow(/evidence changed/);
    delete base.evidence;
    expect(() => mergeRefinementEvidence(base, body, [a,b], roles)).toThrow(/evidence changed/);
  });
  it("protects printed skills sharing a fact and rejects altered resume structure", () => {
    const base = baseline();
    base.render.body.skills = [a.text];
    const body = structuredClone(base.render.body);
    body.sections[0]!.lines[0]!.text = "Built services";
    expect(() => mergeRefinementEvidence(base, body, [{ ...a, revision: 2 },b], roles)).toThrow();
    body.sections[0]!.org = "Other";
    expect(() => mergeRefinementEvidence(base, body, [a,b], roles)).toThrow();
  });
  it("rejects reattribution to a changed role header", () => {
    const base = baseline(), body = structuredClone(base.render.body);
    body.sections[0]!.lines[0]!.text = "Built services";
    expect(() => mergeRefinementEvidence(base, body, [a,b], [{ ...roles[0]!, org: "Other" }])).toThrow(/evidence changed/);
    expect(() => mergeRefinementEvidence(base, body, [a,b], [{ ...roles[0]!, unknownEndStartDate: "2021" }])).toThrow(/evidence changed/);
    expect(() => mergeRefinementEvidence(base, body, [a,b], [])).toThrow(/evidence changed/);
  });
});
