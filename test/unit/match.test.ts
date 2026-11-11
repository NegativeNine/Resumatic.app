import { describe, expect, it } from "vitest";
import { identicalMatches, type MatchFact, type MatchRole } from "../../src/pipeline/match";
import { sameRole, sameWording } from "../../src/shared/record";

const LINE = "Designed and built the API, cutting deploy time from 40 minutes to 6.";

const role = (id: string, fields: Partial<MatchRole> = {}): MatchRole => ({ id, kind: "job", org: "Acme", title: "Engineer", startDate: "2019-03", endDate: "2021-06", ...fields });
const fact = (id: string, text: string, roleId: string | null = "r1", kind = "accomplishment"): MatchFact => ({ id, roleId, kind, text });
const pairs = (roles: MatchRole[], facts: MatchFact[] = []) => identicalMatches(roles, facts).map((match) => `${match.kind} ${match.from} > ${match.to}`);

describe("roles that are the same role", () => {
  it("match each later copy to the earliest", () => {
    expect(pairs([role("r1"), role("r2"), role("other", { org: "Globex" }), role("r3")])).toEqual(["role r2 > r1", "role r3 > r1"]);
  });

  it("match across differences that are only presentation", () => {
    expect(pairs([role("r1"), role("r2", { org: "Acme.", title: " Engineer " })])).toEqual(["role r2 > r1"]);
    expect(pairs([role("r1", { endDate: null }), role("r2", { endDate: null })])).toEqual(["role r2 > r1"]);
  });

  it("do not match when any field that names the role differs", () => {
    for (const other of [
      { kind: "project" },
      { org: "Acme Ltd" },
      { org: "ACME" },
      { title: "Senior Engineer" },
      { startDate: "2019-04" },
      { startDate: "2019" },
      { endDate: "2021-07" },
      { endDate: null },
    ])
      expect(pairs([role("r1"), role("r2", other)]), JSON.stringify(other)).toEqual([]);
  });

  it("do not match when the fields can't say which role either is", () => {
    // Each pair is alike in every field, and still nothing says they are one job.
    for (const unknown of [{ title: null }, { title: "" }, { startDate: null, endDate: null }, { startDate: null, endDate: null, unknownEndStartDate: "2019-03" }])
      expect(pairs([role("r1", unknown), role("r2", unknown)]), JSON.stringify(unknown)).toEqual([]);
  });
});

describe("facts that are the same fact", () => {
  it("match word for word, inside roles that match", () => {
    const roles = [role("r1"), role("r2"), role("r3")];
    const facts = [fact("f1", LINE, "r1"), fact("g1", "Ran the on-call rota", "r1"), fact("f2", LINE, "r2"), fact("f3", LINE, "r3"), fact("g3", "Ran the on-call rota", "r3")];
    expect(pairs(roles, facts)).toEqual(["role r2 > r1", "role r3 > r1", "fact f2 > f1", "fact f3 > f1", "fact g3 > g1"]);
  });

  it("match inside one role, and across differences that are only presentation", () => {
    expect(pairs([role("r1")], [fact("f1", LINE), fact("f2", LINE)])).toEqual(["fact f2 > f1"]);
    expect(pairs([role("r1")], [fact("f1", "Led a team of 5"), fact("f2", "- Led a team  of 5."), fact("f3", "**Led** a team of 5")])).toEqual(["fact f2 > f1", "fact f3 > f1"]);
  });

  it("do not match when the roles are not the same role", () => {
    const facts = [fact("f1", LINE, "r1"), fact("f2", LINE, "r2")];
    expect(pairs([role("r1"), role("r2", { title: "Senior Engineer" })], facts)).toEqual([]);
    // Two roles with no title are never found to be one, so neither are their lines.
    expect(pairs([role("r1", { title: null }), role("r2", { title: null })], facts)).toEqual([]);
    // A role the matcher was never given stands only for itself.
    expect(pairs([], facts)).toEqual([]);
  });

  it("do not match when anything but presentation differs", () => {
    for (const other of [
      LINE.replace("40 minutes", "45 minutes"),
      LINE.replace("Designed", "Helped design"),
      LINE.replace("Designed and built", "Built"),
      LINE.toLowerCase(),
      `${LINE.slice(0, -1)} for 30 partner teams.`,
    ])
      expect(pairs([role("r1")], [fact("f1", LINE), fact("f2", other)]), other).toEqual([]);
    expect(pairs([role("r1")], [fact("f1", LINE), fact("f2", LINE, "r1", "credential")])).toEqual([]);
    expect(pairs([role("r1")], [fact("f1", "  "), fact("f2", " ")])).toEqual([]);
  });

  it("match a skill or a credential wherever it is listed, and never an accomplishment read without a job", () => {
    expect(pairs([], [fact("s1", "Kubernetes", null, "skill"), fact("s2", "Kubernetes", null, "skill"), fact("c1", "Kubernetes", null, "credential"), fact("c2", "Kubernetes", null, "credential")])).toEqual([
      "fact s2 > s1",
      "fact c2 > c1",
    ]);
    expect(pairs([], [fact("a1", LINE, null), fact("a2", LINE, null)])).toEqual([]);
    // A skill listed under a job is not the one listed under none.
    expect(pairs([role("r1")], [fact("s1", "Kubernetes", null, "skill"), fact("s2", "Kubernetes", "r1", "skill")])).toEqual([]);
  });
});

describe("what a match is", () => {
  // Five uploads of one resume, with a sixth that changed a title and a line.
  const roles = [1, 2, 3, 4, 5].flatMap((upload) => [role(`acme-${upload}`), role(`globex-${upload}`, { org: "Globex", title: "Analyst" })]).concat(role("acme-6", { title: "Staff Engineer" }));
  const facts = [1, 2, 3, 4, 5]
    .flatMap((upload) => [fact(`api-${upload}`, LINE, `acme-${upload}`), fact(`rota-${upload}`, "Ran the on-call rota", `globex-${upload}`), fact(`go-${upload}`, "Go", null, "skill")])
    .concat(fact("api-6", LINE.replace("40", "45"), "acme-6"), fact("go-6", "Go", null, "skill"));
  const matches = identicalMatches(roles, facts);

  it("points every copy at one row, and no row at more than one", () => {
    expect(matches).toHaveLength(8 + 13);
    const from = matches.map((match) => `${match.kind} ${match.from}`);
    expect(new Set(from).size).toBe(from.length);
    const copies = new Set(from);
    // What a copy points at is never itself a copy, so nothing has to be followed twice.
    for (const match of matches) expect(copies.has(`${match.kind} ${match.to}`), match.to).toBe(false);
    expect(matches.filter((match) => match.to.endsWith("-1")).length).toBe(matches.length);
    expect(matches.some((match) => match.from === "acme-6" || match.from === "api-6")).toBe(false);
  });

  it("is only ever what the record itself would confirm without the owner", () => {
    const roleOf = new Map(roles.map((found) => [found.id, found]));
    const factOf = new Map(facts.map((found) => [found.id, found]));
    for (const match of matches) {
      if (match.kind === "role") expect(sameRole(roleOf.get(match.from)!, roleOf.get(match.to)!), match.from).toBe(true);
      else {
        const [from, to] = [factOf.get(match.from)!, factOf.get(match.to)!];
        expect(from.kind === to.kind && sameWording(from.text, to.text), match.from).toBe(true);
        expect(from.roleId === null ? to.roleId === null && from.kind !== "accomplishment" : sameRole(roleOf.get(from.roleId)!, roleOf.get(to.roleId!)!), match.from).toBe(true);
      }
    }
  });

  it("finds the same matches whenever it is run again", () => {
    expect(identicalMatches(roles, facts)).toEqual(matches);
  });
});
