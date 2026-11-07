import { describe, expect, it } from "vitest";
import type { FactRecord, RoleRecord } from "../../src/shared/types";
import { finalLegacyEvidence, legacyReceipt, legacyReview } from "../../src/vault/legacy-remediation";
import type { ResumeVersion } from "../../src/vault/snapshots";

const role: RoleRecord = { id: "r1", revision: 1, kind: "job", org: "Acme", title: "Engineer", startDate: "2021", endDate: null };
const fact: FactRecord = { id: "f1", revision: 1, origin: "user", roleId: "r1", kind: "accomplishment", text: "Built systems", level: "implemented", quote: null };
const skill: FactRecord = { id: "s1", revision: 1, origin: "user", roleId: null, kind: "skill", text: "Go", level: null, quote: null };
function fixture(): ResumeVersion {
  return {
    render: { version: 1, company: null, title: null, profile: { name: "", email: "", phone: "", location: "", links: [] },
      body: { summary: null, skills: ["Go"], sections: [{ roleId: "r1", kind: "job", org: "Acme", title: "Engineer", startDate: "2021", endDate: null,
        lines: [{ id: "l1", text: "Built systems", factIds: ["f1"], status: "kept" }] }] } },
    report: null, facts: {}, provenance: "legacy",
  };
}
describe("legacy review receipts", () => {
  it("requires fresh receipts and rechecks complete fact metadata, headings, and skills", () => {
    const saved = fixture();
    expect(legacyReview(saved, [fact, skill], [role])).toMatchObject({ verifiedLineIds: [], totalLines: 1, headersReady: true, skillsReady: true });
    expect(() => finalLegacyEvidence(saved, [fact, skill], [role])).toThrow();
    saved.legacyReceipts = { l1: legacyReceipt(saved.render.body, "l1", [fact, skill], [role]) };
    expect(finalLegacyEvidence(saved, [fact, skill], [role]).facts).toEqual({ f1: { text: "Built systems", quote: null }, s1: { text: "Go", quote: null } });
    expect(legacyReview(saved, [{ ...fact, revision: 2 }, skill], [role]).verifiedLineIds).toEqual([]);
    expect(legacyReview(saved, [fact, skill], [{ ...role, revision: 2 }]).verifiedLineIds).toEqual([]);
    expect(legacyReview(saved, [fact, skill], [{ ...role, title: "Manager" }]).headersReady).toBe(false);
    expect(legacyReview(saved, [fact], [role]).skillsReady).toBe(false);
    saved.render.body.sections[0]!.lines[0]!.text = "Different claim";
    expect(() => finalLegacyEvidence(saved, [fact, skill], [role])).toThrow();
  });
  it("rejects empty or duplicate lines and cannot promote a blank document", () => {
    const saved = fixture();
    const line = saved.render.body.sections[0]!.lines[0]!;
    saved.render.body.sections[0]!.lines.push({ ...line });
    expect(() => finalLegacyEvidence(saved, [fact, skill], [role])).toThrow();
    saved.render.body.sections[0]!.lines = [{ ...line, text: " " }];
    expect(() => legacyReceipt(saved.render.body, "l1", [fact], [role])).toThrow();
    saved.render.body.sections[0]!.lines = [];
    saved.render.body.skills = [];
    expect(() => finalLegacyEvidence(saved, [fact], [role])).toThrow();
  });
});
