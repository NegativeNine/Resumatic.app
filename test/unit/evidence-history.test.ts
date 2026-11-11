import { describe, expect, it } from "vitest";
import type { FactRecord, RoleRecord } from "../../src/shared/types";
import { assertGroundedResume, evidenceForFacts, evidenceForRoles, sameEvidence } from "../../src/vault/snapshots";
import type { RenderData } from "../../src/shared/types";

const fact: FactRecord = {
  id: "fact-1", revision: 3, origin: "extracted", roleId: "role-1",
  kind: "accomplishment", text: "Led a migration", level: "led", quote: "Led a migration",
};

describe("immutable resume evidence", () => {
  it("checks all section headings, including empty education sections, against captured roles", () => {
    const role: RoleRecord = { id: "r", revision: 2, kind: "education", org: "School", title: "Degree", startDate: "2020", endDate: "2022" };
    const render: RenderData = {
      profile: { name: "A User", email: "", phone: "", location: "", links: [] },
      body: { summary: null, sections: [{ roleId: "r", kind: "education", org: "School", title: "Degree", startDate: "2020", endDate: "2022", lines: [] }], skills: [] },
      version: 1, company: null, title: null,
    };
    const roles = evidenceForRoles([role]);
    expect(() => assertGroundedResume(render, {}, "snapshot")).toThrow(/unverified/);
    expect(() => assertGroundedResume(render, {}, "snapshot", {}, roles)).not.toThrow();
    for (const change of [
      { org: "Another School" }, { title: "Doctorate" }, { kind: "job" as const },
      { startDate: "2010" }, { endDate: null }, { unknownEndStartDate: "2010" },
    ]) {
      const altered = structuredClone(render);
      Object.assign(altered.body.sections[0]!, change);
      expect(() => assertGroundedResume(altered, {}, "snapshot", {}, roles)).toThrow(/unverified/);
    }
    expect(() => evidenceForRoles([{ ...role, revision: undefined }])).toThrow(/incomplete/);
  });

  it("requires the immutable role binding of every section citation", () => {
    const role: RoleRecord = { id: "role-1", revision: 1, kind: "job", org: "Employer", title: null, startDate: null, endDate: null };
    const render: RenderData = {
      profile: { name: "A User", email: "", phone: "", location: "", links: [] },
      body: { summary: null, sections: [{ roleId: role.id, kind: role.kind, org: role.org, title: role.title, startDate: null, endDate: null, lines: [{ id: "line", text: fact.text, factIds: [fact.id], status: "kept" }] }], skills: [] },
      version: 1, company: null, title: null,
    };
    const facts = { [fact.id]: { text: fact.text, quote: fact.quote } };
    const roles = evidenceForRoles([role]);
    expect(() => assertGroundedResume(render, facts, "snapshot", undefined, roles)).toThrow(/unverified/);
    expect(() => assertGroundedResume(render, facts, "snapshot", evidenceForFacts([{ ...fact, roleId: "other-role" }]), roles)).toThrow(/unverified/);
    expect(() => assertGroundedResume(render, facts, "snapshot", evidenceForFacts([fact]), roles)).not.toThrow();
  });

  it("requires a matching captured skill record for each printed skill", () => {
    const render: RenderData = {
      profile: { name: "A User", email: "", phone: "", location: "", links: [] },
      body: { summary: null, sections: [], skills: ["TypeScript"] },
      version: 1, company: null, title: null,
    };
    const skill: FactRecord = { ...fact, id: "skill-1", kind: "skill", roleId: null,
      text: "TypeScript", level: null, quote: "TypeScript" };
    const stored = { [skill.id]: { text: skill.text, quote: skill.quote } };
    // Legacy facts alone do not say whether this was a confirmed skill.
    expect(() => assertGroundedResume(render, stored, "snapshot")).toThrow(/unverified/);
    expect(() => assertGroundedResume(render, stored, "snapshot", evidenceForFacts([{ ...skill, kind: "accomplishment" }]))).toThrow(/unverified/);
    expect(() => assertGroundedResume(render, stored, "snapshot", evidenceForFacts([{ ...skill, quote: "different source" }]))).toThrow(/unverified/);
    expect(() => assertGroundedResume(render, stored, "snapshot", evidenceForFacts([skill]))).not.toThrow();
    for (const quote of [null, "", "  "] as const) {
      const incomplete = { ...skill, quote };
      expect(() => assertGroundedResume(render, { [skill.id]: { text: skill.text, quote } }, "snapshot", { [skill.id]: incomplete })).toThrow(/unverified/);
      expect(() => evidenceForFacts([incomplete])).toThrow(/incomplete/);
    }
    // A valid captured skill with the same spelling may support the output.
    const other = { ...skill, id: "skill-2", origin: "user" as const, quote: null };
    expect(() => assertGroundedResume(render, { ...stored, [other.id]: { text: other.text, quote: other.quote } }, "snapshot", evidenceForFacts([{ ...skill, kind: "credential" }, other]))).not.toThrow();
  });

  it("rejects repeated or missing line IDs across the summary and sections", () => {
    const role: RoleRecord = { id: "role-1", revision: 1, kind: "job", org: "Employer", title: null, startDate: null, endDate: null };
    const line = { id: "same", text: fact.text, factIds: [fact.id], status: "kept" as const };
    const render: RenderData = {
      profile: { name: "A User", email: "", phone: "", location: "", links: [] },
      body: { summary: { ...line }, sections: [{ roleId: role.id, kind: role.kind, org: role.org, title: null, startDate: null, endDate: null, lines: [{ ...line }] }], skills: [] },
      version: 1, company: null, title: null,
    };
    const stored = { [fact.id]: { text: fact.text, quote: fact.quote } };
    const captured = evidenceForFacts([fact]), roles = evidenceForRoles([role]);
    expect(() => assertGroundedResume(render, stored, "snapshot", captured, roles)).toThrow(/unverified/);
    render.body.sections[0]!.lines[0]!.id = "second";
    expect(() => assertGroundedResume(render, stored, "snapshot", captured, roles)).not.toThrow();
    render.body.sections[0]!.lines[0]!.id = "";
    expect(() => assertGroundedResume(render, stored, "snapshot", captured, roles)).toThrow(/unverified/);
  });
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

  describe("with facts their owner has marked sensitive", () => {
    const SKILLS = "Go, TypeScript, Kubernetes";
    const role: RoleRecord = { id: "role-1", revision: 1, kind: "job", org: "Employer", title: null, startDate: null, endDate: null };
    const roles = evidenceForRoles([role]);
    const skill = (id: string, text: string, quote = SKILLS): FactRecord => ({ ...fact, id, kind: "skill", roleId: null, text, level: null, quote });
    const go = skill("go", "Go"), kubernetes = skill("kubernetes", "Kubernetes");
    const stored = (...records: FactRecord[]) => Object.fromEntries(records.map((record) => [record.id, { text: record.text, quote: record.quote }]));
    const version = (lines: { id: string; text: string; factIds: string[] }[], skills: string[] = [], summary: { id: string; text: string; factIds: string[] } | null = null): RenderData => ({
      profile: { name: "A User", email: "", phone: "", location: "", links: [] },
      body: {
        summary: summary ? { ...summary, status: "kept" } : null,
        sections: [{ roleId: role.id, kind: role.kind, org: role.org, title: role.title, startDate: null, endDate: null, lines: lines.map((line) => ({ ...line, status: "kept" as const })) }],
        skills,
      },
      version: 1, company: null, title: null,
    });
    const marked = (...records: FactRecord[]) => ({ ids: new Set(records.map((record) => record.id)), quotes: new Set(records.flatMap((record) => (record.quote === null ? [] : [record.quote]))) });
    const nothing = { ids: new Set<string>(), quotes: new Set<string>() };

    it("refuses a version in which a line cites one, and opens it again when the mark is gone", () => {
      const render = version([{ id: "line", text: fact.text, factIds: [fact.id] }]);
      const facts = stored(fact), evidence = evidenceForFacts([fact]);
      // Its owner's own read passes no marks, and neither does removing the line.
      expect(() => assertGroundedResume(render, facts, "snapshot", evidence, roles)).not.toThrow();
      expect(() => assertGroundedResume(render, facts, "snapshot", evidence, roles, nothing)).not.toThrow();
      expect(() => assertGroundedResume(render, facts, "snapshot", evidence, roles, marked(fact))).toThrow("This version uses a fact you marked sensitive");
      expect(() => assertGroundedResume(render, facts, "snapshot", evidence, roles, marked({ ...fact, id: "another", quote: "Another line" }))).not.toThrow();
      // The summary is a line like any other.
      const summarised = version([], [], { id: "summary", text: fact.text, factIds: [fact.id] });
      expect(() => assertGroundedResume(summarised, facts, "snapshot", evidence, roles, marked(fact))).toThrow("marked sensitive");
    });

    it("refuses a version in which a line cites a fact stored with a marked fact's line", () => {
      const render = version([], [], { id: "summary", text: "Go", factIds: [go.id] });
      // Checked while the whole skills list was the quote: the line may rest on the marked word.
      expect(() => assertGroundedResume(render, stored(go), "snapshot", evidenceForFacts([go]), roles, marked(kubernetes))).toThrow("marked sensitive");
      // Captured after the mark, with its own word as its only evidence.
      const own = { ...go, quote: go.text };
      expect(() => assertGroundedResume(render, stored(own), "snapshot", evidenceForFacts([own]), roles, marked(kubernetes))).not.toThrow();
    });

    it("ignores a marked fact the run captured and no line cites", () => {
      const other: FactRecord = { ...fact, id: "fact-2", text: "Built a billing service", quote: "Built a billing service", level: "implemented" };
      const render = version([{ id: "line", text: other.text, factIds: [other.id] }], ["Go"]);
      const facts = stored(fact, other, go, kubernetes), evidence = evidenceForFacts([fact, other, go, kubernetes]);
      // Captured with the rest, cited by nothing and printed nowhere. "Go" prints as its own word.
      expect(() => assertGroundedResume(render, facts, "snapshot", evidence, roles, marked(fact, kubernetes))).not.toThrow();
    });

    it("refuses a printed skill that only marked facts stand behind", () => {
      const render = version([], ["Go", "Kubernetes"]);
      const facts = stored(go, kubernetes), evidence = evidenceForFacts([go, kubernetes]);
      expect(() => assertGroundedResume(render, facts, "snapshot", evidence, roles, marked(kubernetes))).toThrow("marked sensitive");
      const again = skill("kubernetes-2", "Kubernetes", "Kubernetes, Terraform");
      expect(() => assertGroundedResume(render, stored(go, kubernetes, again), "snapshot", evidenceForFacts([go, kubernetes, again]), roles, marked(kubernetes))).not.toThrow();
      expect(() => assertGroundedResume(render, stored(go, kubernetes, again), "snapshot", evidenceForFacts([go, kubernetes, again]), roles, marked(kubernetes, again))).toThrow("marked sensitive");
    });

    it("says a version is unverified first when it is that as well", () => {
      const render = version([{ id: "line", text: "Led a migration of 900 services", factIds: [fact.id] }]);
      expect(() => assertGroundedResume(render, stored(fact), "snapshot", evidenceForFacts([fact]), roles, marked(fact))).toThrow(/unverified/);
      expect(() => assertGroundedResume(version([{ id: "line", text: fact.text, factIds: [fact.id] }]), stored(fact), "legacy", evidenceForFacts([fact]), roles, marked(fact))).toThrow(/unverified/);
    });
  });

  it("blocks a historical positive claim that contradicts saved negative evidence", () => {
    const render: RenderData = {
      profile: { name: "A User", email: "", phone: "", location: "", links: [] },
      body: { summary: { id: "line", text: "Led the migration", factIds: [fact.id], status: "kept" }, sections: [], skills: [] },
      version: 1, company: null, title: null,
    };
    const negative = { ...fact, text: "Never led the migration", quote: "Never led the migration", level: "led" as const };
    const stored = { [fact.id]: { text: negative.text, quote: negative.quote } };
    expect(() => assertGroundedResume(render, stored, "snapshot", evidenceForFacts([negative]))).toThrow(/unverified/);
    render.body.summary!.text = negative.text;
    expect(() => assertGroundedResume(render, stored, "snapshot", evidenceForFacts([negative]))).not.toThrow();
  });
});
