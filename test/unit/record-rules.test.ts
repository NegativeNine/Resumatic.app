import { describe, expect, it } from "vitest";
import {
  MAX_PART_RANGES,
  MAX_SPLIT_PARTS,
  linkProblem,
  partText,
  partsProblem,
  rangesProblem,
  sameRole,
  sameWording,
  stampProblem,
  tagProblem,
  tagRelation,
  wording,
  type NewPart,
  type Range,
  type RoleIdentity,
  type Stamp,
} from "../../src/shared/record";

/** The range of `words` in `line`, which must hold them exactly once. */
function at(line: string, words: string): Range {
  const start = line.indexOf(words);
  if (start < 0 || line.indexOf(words, start + 1) >= 0) throw new Error(`"${words}" is not in the line exactly once`);
  return [start, start + words.length];
}

const model: Stamp = { proposedBy: "model", model: "@cf/test/judge", method: "split/1", taxonomyVersion: null, confidence: 0.97, shadow: true };
const rule: Stamp = { proposedBy: "rule", model: null, method: "identical-wording/1", taxonomyVersion: null, confidence: null, shadow: false };
const owner: Stamp = { proposedBy: "owner", model: null, method: "owner", taxonomyVersion: null, confidence: null, shadow: false };

describe("a range is whole words of its line", () => {
  const allowed: [line: string, words: string][] = [
    ["Designed and built the API, cutting deploy time", "Designed and built the API"],
    ["Designed and built the API, cutting deploy time", "the API,"],
    ["Designed and built the API, cutting deploy time", "cutting deploy time"],
    ["Grew revenue 40%, then doubled it", "40%"],
    ["Led migration (Python, Go) to Kubernetes", "Python"],
    ["Led migration (Python, Go) to Kubernetes", "Go"],
    ["Led migration (Python, Go) to Kubernetes", "(Python, Go)"],
    ['Awarded "Engineer of the Year" in 2021', "Engineer of the Year"],
    ["Awarded \u201CEngineer of the Year\u201D in 2021", "Engineer of the Year"],
    ["Led a team of 5\u2014delivered on time", "Led a team of 5"],
    ["Led a team of 5\u2014delivered on time", "delivered on time"],
    ["Built services in C++, C# and .NET.", "C++"],
    ["Built services in C++, C# and .NET.", "C#"],
    ["Built services in C++, C# and .NET.", ".NET"],
    ["Ran research & QA for the unit", "&"],
    ["Raised $1.2M.", "$1.2M"],
    ["Raised $1.2M.", "Raised $1.2M."],
  ];
  it.each(allowed)("takes %j as far as %j", (line, words) => {
    expect(rangesProblem(line, [at(line, words)])).toBeNull();
    expect(partText(line, [at(line, words)])).toBe(words);
  });

  // Each of these would say something the line doesn't.
  const refused: [line: string, words: string][] = [
    ["Was unhelpful to the team", "helpful"],
    ["Joined as co-founder in 2019", "founder"],
    ["Joined as co-founder in 2019", "co"],
    ["Kept churn at -5% all year", "5%"],
    ["Grew revenue 40%, then doubled it", "40"],
    ["Raised $1.2M.", "1.2M"],
    ["Raised $1.2M.", "$1"],
    ["Cut build time from 1,000 seconds", "000"],
    ["Set up CI/CD for the group", "CI"],
    ["Set up CI/CD for the group", "CD"],
    ["Worked there 2019\u20132021", "2021"],
    ["Built services in C++, C# and .NET.", "NET"],
    ["Wrote the F# services", "F"],
    ["Didn't manage the budget", "Didn"],
    ["Non-technical lead for the rollout", "technical"],
    ["Took 10+ teams through audit", "10"],
    ["Shipped w/o delay", "w"],
  ];
  it.each(refused)("refuses to cut %j down to %j", (line, words) => {
    expect(rangesProblem(line, [at(line, words)])).toBe("a range starts and ends on whole words");
  });

  it("refuses a range that starts or ends in the space between words", () => {
    const line = "Built the API";
    expect(rangesProblem(line, [[5, 13]])).toBe("a range starts and ends on whole words");
    expect(rangesProblem(line, [[6, 14]])).toBe("a range lies inside its line");
    expect(rangesProblem(line, [[0, 6]])).toBe("a range starts and ends on whole words");
    expect(rangesProblem(line, [[0, 5]])).toBeNull();
  });

  it("takes punctuation standing alone whole or not at all", () => {
    const line = "Planned ... then shipped";
    expect(rangesProblem(line, [at(line, "...")])).toBeNull();
    expect(rangesProblem(line, [[8, 10]])).toBe("a range starts and ends on whole words");
  });

  it("keeps the ranges of one part in order and apart", () => {
    const line = "Designed and built the API";
    const designed = at(line, "Designed");
    const api = at(line, "the API");
    expect(rangesProblem(line, [designed, api])).toBeNull();
    expect(partText(line, [designed, api])).toBe("Designed the API");
    expect(rangesProblem(line, [api, designed])).toBe("the ranges of a part are in order and apart");
    expect(rangesProblem(line, [at(line, "Designed and"), at(line, "and built")])).toBe("the ranges of a part are in order and apart");
    expect(rangesProblem(line, [designed, designed])).toBe("the ranges of a part are in order and apart");
  });

  it("refuses anything that is not positions inside the line", () => {
    const line = "Built the API";
    for (const ranges of [undefined, null, "0-5", [], [[0]], [[0, 5, 9]], [["0", "5"]], [[0.5, 5]], [[0, Number.NaN]], [{ start: 0, end: 5 }]])
      expect(rangesProblem(line, ranges)).not.toBeNull();
    expect(rangesProblem(line, [[-1, 5]])).toBe("a range lies inside its line");
    expect(rangesProblem(line, [[5, 5]])).toBe("a range lies inside its line");
    expect(rangesProblem(line, [[9, 5]])).toBe("a range lies inside its line");
    expect(rangesProblem(line, [[0, 99]])).toBe("a range lies inside its line");
    expect(rangesProblem("a b c d e f g h i j", Array.from({ length: MAX_PART_RANGES + 1 }, (_, i): Range => [i * 2, i * 2 + 1]))).toMatch(/between one and/);
  });

  it("never splits a character that takes two places in a string", () => {
    const line = "Shipped \u{1F680} launch";
    expect(rangesProblem(line, [[8, 9]])).toBe("a range starts and ends on whole words");
    expect(rangesProblem(line, [[8, 10]])).toBeNull();
  });
});

describe("the parts of a line", () => {
  const line = "Designed and built the API, cutting deploy time from 40 minutes to 6.";
  const designed: NewPart = { kind: "clause", ranges: [at(line, "Designed"), at(line, "the API")] };
  const built: NewPart = { kind: "clause", ranges: [at(line, "built the API")] };
  const cutting: NewPart = { kind: "result", ranges: [at(line, "cutting deploy time from 40 minutes to 6")], resultOf: 1 };
  const api: NewPart = { kind: "mention", ranges: [at(line, "API")] };
  const minutes: NewPart = { kind: "mention", ranges: [at(line, "40 minutes")] };

  it("accepts clauses that share words, a result of one, and mentions inside them", () => {
    expect(partsProblem(line, [designed, built, cutting, api, minutes])).toBeNull();
    expect(partText(line, designed.ranges)).toBe("Designed the API");
    expect(partText(line, cutting.ranges)).toBe("cutting deploy time from 40 minutes to 6");
  });

  it("needs a clause", () => {
    expect(partsProblem(line, [api])).toBe("a line divides into at least one clause");
    expect(partsProblem(line, [])).toMatch(/between one and/);
    expect(partsProblem(line, "clauses")).toMatch(/between one and/);
    expect(partsProblem(line, Array.from({ length: MAX_SPLIT_PARTS + 1 }, () => built))).toMatch(/between one and/);
  });

  it("refuses an unknown kind and any part whose ranges are not whole words", () => {
    expect(partsProblem(line, [{ kind: "summary", ranges: built.ranges }])).toBe("unknown kind of part");
    expect(partsProblem(line, [null])).toBe("unknown kind of part");
    expect(partsProblem(line, [built, { kind: "mention", ranges: [[23, 25]] }])).toBe("a range starts and ends on whole words");
  });

  it("ties a result to a clause, directly or through another result", () => {
    const saving: NewPart = { kind: "result", ranges: [at(line, "to 6")], resultOf: 0 };
    expect(partsProblem(line, [built, { ...cutting, resultOf: 0 }, saving])).toBeNull();
    // A result of a result still leads to a clause.
    expect(partsProblem(line, [built, { ...cutting, resultOf: 0 }, { ...saving, resultOf: 1 }])).toBeNull();
    for (const resultOf of [undefined, null, 1, 2, 9, -1, 0.5])
      expect(partsProblem(line, [built, { ...cutting, resultOf: resultOf as number }, api]), String(resultOf)).toBe(
        "a result names the claim it is an outcome of",
      );
    // Two results that are each the other's outcome lead to no clause.
    expect(partsProblem(line, [built, { ...cutting, resultOf: 2 }, { ...saving, resultOf: 1 }])).toBe("a result names the claim it is an outcome of");
    expect(partsProblem(line, [{ ...built, resultOf: 1 }, cutting])).toBe("only a result is an outcome of another part");
    expect(partsProblem(line, [built, { ...api, resultOf: 0 }])).toBe("only a result is an outcome of another part");
  });

  it("keeps a mention inside a claim", () => {
    expect(partsProblem(line, [built, minutes])).toBe("a mention lies inside a clause");
    expect(partsProblem(line, [built, { ...cutting, resultOf: 0 }, minutes])).toBeNull();
    // A mention in two pieces must sit in one claim, not across two.
    expect(partsProblem(line, [designed, { kind: "mention", ranges: [at(line, "Designed"), at(line, "API")] }])).toBeNull();
    expect(partsProblem(line, [built, { ...cutting, resultOf: 0 }, { kind: "mention", ranges: [at(line, "API"), at(line, "40 minutes")] }])).toBe(
      "a mention lies inside a clause",
    );
  });

  it("refuses the same part twice", () => {
    expect(partsProblem(line, [built, built])).toBe("two parts are the same");
    expect(partsProblem(line, [built, { kind: "result", ranges: built.ranges, resultOf: 0 }])).toBe("two parts are the same");
    expect(partsProblem(line, [built, api, api])).toBe("two parts are the same");
    // A clause may be one word that is also mentioned.
    expect(partsProblem("Python", [{ kind: "clause", ranges: [[0, 6]] }, { kind: "mention", ranges: [[0, 6]] }])).toBeNull();
  });
});

describe("what made a judgement", () => {
  it("accepts a rule, a model and the owner", () => {
    for (const stamp of [model, rule, owner]) expect(stampProblem(stamp)).toBeNull();
    expect(stampProblem({ ...model, confidence: null, taxonomyVersion: "esco-1.2.1+onet-31.0+c036f953" })).toBeNull();
  });

  it("refuses a stamp that does not say what made it", () => {
    expect(stampProblem(null)).not.toBeNull();
    expect(stampProblem({ ...rule, proposedBy: "coach" })).toBe("a judgement is made by a rule, a model or the owner");
    expect(stampProblem({ ...model, model: null })).toBe("a model's judgement names the model");
    expect(stampProblem({ ...model, model: "two words" })).toBe("a model's judgement names the model");
    expect(stampProblem({ ...rule, model: "@cf/test/judge" })).toBe("only a model's judgement names a model");
    for (const method of ["", "Identical", "has space", "a/b/c", "x".repeat(80)])
      expect(stampProblem({ ...rule, method })).toBe("a judgement names the rule or check that made it");
    expect(stampProblem({ ...rule, taxonomyVersion: "not a version" })).toBe("unknown taxonomy version");
    for (const confidence of [-0.1, 1.1, Number.NaN, "0.9"]) expect(stampProblem({ ...model, confidence })).toBe("confidence is between 0 and 1");
    expect(stampProblem({ ...rule, shadow: 0 })).toBe("a judgement says whether it is in shadow");
  });

  it("never hides or scores what the owner does", () => {
    expect(stampProblem({ ...owner, shadow: true })).toBe("the owner's own judgement is neither in shadow nor scored");
    expect(stampProblem({ ...owner, confidence: 1 })).toBe("the owner's own judgement is neither in shadow nor scored");
  });
});

describe("a tag", () => {
  const stamp: Stamp = { ...model, taxonomyVersion: "esco-1.2.1+onet-31.0+c036f953" };
  const tag = { subject: { kind: "fact", id: "fact-1" }, conceptId: "onet:tool:python", conceptKind: "tool", label: "Python", stamp };

  it("relates by what kind of concept it names", () => {
    expect(tagRelation("fact", "tool")).toBe("uses");
    expect(tagRelation("part", "tool-category")).toBe("uses");
    expect(tagRelation("fact", "skill")).toBe("shows");
    expect(tagRelation("part", "knowledge")).toBe("shows");
    expect(tagRelation("fact", "skill-group")).toBe("shows");
    expect(tagRelation("fact", "activity")).toBe("does");
    expect(tagRelation("part", "task")).toBe("does");
    expect(tagRelation("role", "occupation")).toBe("occupation");
    expect(tagRelation("role", "occupation-group")).toBe("occupation");
  });

  it("puts occupations on roles and nothing else on them", () => {
    expect(tagRelation("fact", "occupation")).toBeNull();
    expect(tagRelation("part", "occupation-group")).toBeNull();
    expect(tagRelation("role", "skill")).toBeNull();
    expect(tagRelation("role", "tool")).toBeNull();
    expect(tagProblem({ ...tag, conceptId: "onet:occ:15-1252.00", conceptKind: "occupation" })).toBe("an occupation tags a role");
    expect(tagProblem({ ...tag, subject: { kind: "role", id: "role-1" } })).toBe("a role is tagged with an occupation");
    expect(tagProblem({ ...tag, subject: { kind: "role", id: "role-1" }, conceptId: "onet:occ:15-1252.00", conceptKind: "occupation" })).toBeNull();
  });

  it("names a concept in the taxonomy's own form, with its label and the build it came from", () => {
    expect(tagProblem(tag)).toBeNull();
    expect(tagProblem({ ...tag, conceptId: "Python" })).toBe("a tag names a concept of the taxonomy");
    expect(tagProblem({ ...tag, conceptId: "linkedin:skill:python" })).toBe("a tag names a concept of the taxonomy");
    expect(tagProblem({ ...tag, conceptKind: "language" })).toBe("a tag says what kind of concept it names");
    for (const label of ["", "  ", " Python", "x".repeat(301), 7]) expect(tagProblem({ ...tag, label })).toBe("a tag carries its concept's label");
    expect(tagProblem({ ...tag, stamp: { ...stamp, taxonomyVersion: null } })).toBe("a tag says which taxonomy it was made against");
    expect(tagProblem({ ...tag, stamp: { ...stamp, model: null } })).toBe("a model's judgement names the model");
    for (const subject of [undefined, { kind: "resume", id: "r" }, { kind: "fact", id: "" }, { kind: "fact", id: "has space" }])
      expect(tagProblem({ ...tag, subject })).toBe("a tag is on a fact, a part or a role");
  });
});

describe("a link", () => {
  const link = { kind: "fact", from: "fact-2", to: "fact-1", relation: "same", stamp: rule };

  it("joins two different facts or two different roles", () => {
    expect(linkProblem(link)).toBeNull();
    expect(linkProblem({ ...link, kind: "role" })).toBeNull();
    expect(linkProblem({ ...link, relation: "fuller" })).toBeNull();
    expect(linkProblem({ ...link, kind: "resume" })).toBe("a link joins two facts or two roles");
    expect(linkProblem({ ...link, relation: "similar" })).toBe("unknown kind of link");
    expect(linkProblem({ ...link, kind: "role", relation: "fuller" })).toBe("only a fact is a fuller version of another");
    expect(linkProblem({ ...link, to: "fact-2" })).toBe("a link joins two different items");
    expect(linkProblem({ ...link, from: "" })).toBe("a link joins two different items");
  });

  it("lets only a rule's finding of identity be confirmed without asking, and never in shadow", () => {
    expect(linkProblem({ ...link, confirm: true })).toBeNull();
    expect(linkProblem({ ...link, confirm: false, stamp: model })).toBeNull();
    const refusal = "only a rule's finding that two items are identical is confirmed without asking";
    expect(linkProblem({ ...link, confirm: true, stamp: { ...model, shadow: false } })).toBe(refusal);
    expect(linkProblem({ ...link, confirm: true, relation: "fuller" })).toBe(refusal);
    expect(linkProblem({ ...link, confirm: true, stamp: { ...rule, shadow: true } })).toBe(refusal);
    expect(linkProblem({ ...link, confirm: "yes" })).toBe("confirm is true or false");
  });
});

describe("identical wording", () => {
  it("looks past presentation only", () => {
    const line = "Led a team of 5 engineers";
    for (const other of [
      "Led a team of 5 engineers.",
      "  Led a team  of 5 engineers ",
      "- Led a team of 5 engineers",
      "\u2022 Led a team of 5 engineers.",
      "**Led** a team of 5 engineers",
    ])
      expect(sameWording(line, other), other).toBe(true);
    expect(sameWording("Won \u201CEngineer of the Year\u201D", 'Won "Engineer of the Year"')).toBe(true);
    expect(sameWording("Ran the team\u2019s roadmap", "Ran the team's roadmap")).toBe(true);
    // The same letters written as one character or as a letter and a mark.
    expect(sameWording("Caf\u00E9 manager", "Cafe\u0301 manager")).toBe(true);
    expect(wording("1. Built the API.")).toBe("Built the API");
  });

  it("treats every other difference as a different line", () => {
    const line = "Led a team of 5 engineers";
    for (const other of [
      "Led a team of 8 engineers",
      "Led a team of 5 engineers and 2 designers",
      "Helped lead a team of 5 engineers",
      "led a team of 5 engineers",
      "Led a team of 5 engineers!",
      "Led a team of 5 engineers?",
      "Led a team of 5\u00A0000 engineers",
      "Led a team of 5 engineers (interim)",
      "",
    ])
      expect(sameWording(line, other), other).toBe(false);
    expect(sameWording("Not responsible for the budget", "Responsible for the budget")).toBe(false);
    expect(sameWording("Cut costs by 5%", "Cut costs by 5")).toBe(false);
    expect(sameWording("Cut costs by -5%", "Cut costs by 5%")).toBe(false);
    // A raised 2 is not the digit 2.
    expect(sameWording("Covered 10\u00B2 sites", "Covered 102 sites")).toBe(false);
    expect(sameWording("Built in Go", "Built in GO")).toBe(false);
    expect(sameWording("", "")).toBe(false);
    expect(sameWording("   ", " ")).toBe(false);
  });
});

describe("identical roles", () => {
  const role: RoleIdentity = { kind: "job", org: "Acme", title: "Senior Engineer", startDate: "2019-03", endDate: "2021-06" };

  it("holds when every field that names the role is the same", () => {
    expect(sameRole(role, { ...role })).toBe(true);
    expect(sameRole(role, { ...role, org: "Acme.", title: " Senior  Engineer " })).toBe(true);
    expect(sameRole({ ...role, endDate: null }, { ...role, endDate: null })).toBe(true);
  });

  it("does not hold when any of them differs or is not known", () => {
    for (const other of [
      { ...role, kind: "project" },
      { ...role, org: "Acme Ltd" },
      { ...role, org: "ACME" },
      { ...role, title: "Engineer" },
      { ...role, title: null },
      { ...role, startDate: "2019-04" },
      { ...role, startDate: "2019" },
      { ...role, startDate: null },
      { ...role, endDate: "2021-07" },
      { ...role, endDate: "2021" },
      { ...role, endDate: null },
    ])
      expect(sameRole(role, other), JSON.stringify(other)).toBe(false);
    // Two roles with no title, or no known start, are offered to the owner rather than merged.
    expect(sameRole({ ...role, title: null }, { ...role, title: null })).toBe(false);
    expect(sameRole({ ...role, startDate: null, endDate: null }, { ...role, startDate: null, endDate: null })).toBe(false);
    const unknownEnd = { ...role, startDate: null, endDate: null, unknownEndStartDate: "2019-03" };
    expect(sameRole(unknownEnd, { ...unknownEnd })).toBe(false);
  });
});
