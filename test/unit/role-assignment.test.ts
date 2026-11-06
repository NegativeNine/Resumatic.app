import { describe, expect, it } from "vitest";
import { supportedRoleAssignment } from "../../src/pipeline/extract/role-assignment";
import type { Span } from "../../src/grounding/offsets";
import { verifyExtraction } from "../../src/pipeline/extract/verify";

function spanOf(source: string, value: string): Span {
  const start = source.indexOf(value);
  if (start < 0) throw new Error("fixture missing");
  return [start, start + value.length];
}

describe("extracted role assignment", () => {
  const acme = "### Acme — Engineer";
  const globex = "### Globex — Engineer";
  const fact = "- Built an internal API";
  const source = `${acme}\n- Supported customers\n${globex}\n${fact}`;
  const roles = [
    { key: "acme", span: spanOf(source, acme) },
    { key: "globex", span: spanOf(source, globex) },
  ];

  it("keeps the nearest accepted role and clears an earlier role", () => {
    const factSpan = spanOf(source, fact);
    expect(supportedRoleAssignment(source, factSpan, "globex", roles)).toBe("globex");
    expect(supportedRoleAssignment(source, factSpan, "acme", roles)).toBeNull();
  });

  it("does not trust a later, missing or overlapping role", () => {
    const early = spanOf(source, "- Supported customers");
    expect(supportedRoleAssignment(source, early, "globex", roles)).toBeNull();
    expect(supportedRoleAssignment(source, early, "unknown", roles)).toBeNull();
    const overlap = [...roles, { key: "other", span: roles[0]!.span }];
    expect(supportedRoleAssignment(source, early, "acme", overlap)).toBeNull();
  });

  it("clears assignments past an unrecognized Markdown heading", () => {
    expect(supportedRoleAssignment(source, spanOf(source, fact), "acme", [roles[0]!])).toBeNull();
  });

  it("retains a misassigned fact without attributing it to another employer", () => {
    const result = verifyExtraction(source, {
      roles: [
        { key: "acme", kind: "job", org: "Acme", title: "Engineer", startDate: null, endDate: null, quote: acme },
        { key: "globex", kind: "job", org: "Globex", title: "Engineer", startDate: null, endDate: null, quote: globex },
      ],
      facts: [{ roleKey: "acme", kind: "accomplishment", level: "implemented", text: "Built an internal API", quote: fact }],
    });
    expect(result.extraction.facts).toHaveLength(1);
    expect(result.extraction.facts[0]).toMatchObject({ roleKey: null, text: "Built an internal API" });
  });
});
