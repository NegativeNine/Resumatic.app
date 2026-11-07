import { describe, expect, it } from "vitest";
import { verifyDraft, writeDraft } from "../../src/pipeline/tailor";
import type { VerifiedDraft } from "../../src/shared/types";
import { fakeModels } from "../support/fixtures";
import {
  INSTRUCTION_CLAIM,
  SEED_CASES,
  SEED_KINDS,
  plantSeed,
  scoreSeed,
} from "../evals/seeded";

const models = () =>
  fakeModels({ judgeRejects: [INSTRUCTION_CLAIM, "ignore all earlier rules"] });
const report = { kept: 1, repaired: 0, replaced: 0, dropped: 0, gaps: [] };

describe("seeded fabrication harness", () => {
  it.each(SEED_KINDS)(
    "plants and catches %s through the production verification pipeline",
    async (kind) => {
      const testCase = SEED_CASES[0]!;
      const model = models();
      const draft = await writeDraft(
        model,
        testCase.analysis,
        testCase.selection,
        testCase.facts,
        testCase.roles,
      );
      const before = structuredClone(draft);
      const planted = plantSeed(kind, draft, testCase)!;
      expect(planted).not.toBeNull();
      expect(draft).toEqual(before);
      expect(
        planted.draft.lines.filter(
          (line, i) => JSON.stringify(line) !== JSON.stringify(draft.lines[i]),
        ),
      ).toHaveLength(1);
      // A verifier returning the planted line untouched must never score as a catch.
      expect(
        scoreSeed(planted, { lines: planted.draft.lines, report }, testCase)
          .caught,
      ).toBe(false);
      const verified = await verifyDraft(
        model,
        planted.draft,
        testCase.selection,
        testCase.facts,
      );
      expect(scoreSeed(planted, verified, testCase)).toMatchObject({
        caught: true,
        survives: false,
        deterministicViolations: 0,
      });
    },
  );

  it("reports inapplicable number and cross-role seeds rather than a perfect empty score", () => {
    const testCase = SEED_CASES[0]!;
    expect(plantSeed("inflateNumber", { lines: [] }, testCase)).toBeNull();
    expect(
      plantSeed(
        "citeOtherRole",
        {
          lines: [
            {
              id: "summary",
              text: "Relevant experience",
              roleId: null,
              factIds: [],
            },
          ],
        },
        testCase,
      ),
    ).toBeNull();
  });

  it("detects an inflated claim surviving a repair with changed wording", async () => {
    const testCase = SEED_CASES[0]!;
    const draft = await writeDraft(
      models(),
      testCase.analysis,
      testCase.selection,
      testCase.facts,
      testCase.roles,
    );
    const planted = plantSeed("inflateNumber", draft, testCase)!;
    const bad = planted.draft.lines.find((line) => line.id === planted.lineId)!;
    const verified: VerifiedDraft = {
      lines: [
        {
          ...bad,
          text: `Successfully ${bad.text.toLowerCase()}`,
          status: "repaired",
        },
      ],
      report,
    };
    expect(scoreSeed(planted, verified, testCase)).toMatchObject({
      caught: false,
      survives: true,
    });
  });

  it("does not score a surviving negation as caught when the verb changes form", async () => {
    const testCase = SEED_CASES[0]!;
    const draft = await writeDraft(models(), testCase.analysis, testCase.selection, testCase.facts, testCase.roles);
    const planted = plantSeed("negateAction", draft, testCase)!;
    const bad = planted.draft.lines.find((line) => line.id === planted.lineId)!;
    const verified: VerifiedDraft = { lines: [{ ...bad, text: "Did not help build the service", status: "repaired" }], report };
    expect(scoreSeed(planted, verified, testCase)).toMatchObject({ caught: false, survives: true });
  });

  it("reports synonymous or ambiguous rewrites as uncertain instead of caught", async () => {
    const testCase = SEED_CASES[0]!;
    const draft = await writeDraft(models(), testCase.analysis, testCase.selection, testCase.facts, testCase.roles);
    const planted = plantSeed("negateAction", draft, testCase)!;
    const bad = planted.draft.lines.find((line) => line.id === planted.lineId)!;
    for (const text of ["Never assisted in building a Go service", "Not only helped build a Go service"]) {
      const verified: VerifiedDraft = { lines: [{ ...bad, text, status: "repaired" }], report };
      expect(scoreSeed(planted, verified, testCase)).toMatchObject({ caught: false, uncertain: true });
    }
  });

  it("does not plant a negation when the source supports only a different object", () => {
    const testCase = SEED_CASES[0]!;
    const draft = { lines: [{ id: "different", roleId: testCase.facts[0]!.roleId, factIds: [testCase.facts[0]!.id],
      text: "Helped build the payroll system" }] };
    expect(plantSeed("negateAction", draft, testCase)).toBeNull();
  });

  it("does not treat an uncited fact as proof that a rewrite recovered", () => {
    const base = SEED_CASES[0]!;
    const first = { ...base.facts[0]!, text: "Helped build billing systems", quote: "Helped build billing systems" };
    const second = { ...base.facts[1]!, roleId: first.roleId, text: "Helped build payroll systems", quote: "Helped build payroll systems" };
    const testCase = { ...base, facts: [first, second], selection: { ...base.selection, factIds: [first.id, second.id] } };
    const draft = { lines: [{ id: "line", roleId: first.roleId, factIds: [first.id, second.id], text: first.text }] };
    const planted = plantSeed("negateAction", draft, testCase)!;
    const verified: VerifiedDraft = { lines: [{ ...draft.lines[0]!, factIds: [first.id], text: second.text, status: "repaired" }], report };
    expect(scoreSeed(planted, verified, testCase)).toMatchObject({ caught: false, uncertain: true });
  });

  it("does not count a synonymous reversed outcome as a successful repair", () => {
    const testCase = SEED_CASES[0]!;
    const fact = testCase.facts[1]!;
    const draft = { lines: [{ id: "line", roleId: fact.roleId, factIds: [fact.id], text: fact.text }] };
    const planted = plantSeed("reverseOutcome", draft, testCase)!;
    expect(planted.draft.lines[0]!.text).toBe("Increased deployment time by 35% with Kubernetes");
    const verified: VerifiedDraft = { lines: [{ ...planted.draft.lines[0]!, text: "Boosted deployment time by 35% with Kubernetes", status: "repaired" }], report };
    expect(scoreSeed(planted, verified, testCase)).toMatchObject({ caught: false, uncertain: true });
  });

  it("plants an outcome reversal in each synthetic case without mutating the draft", async () => {
    for (const testCase of SEED_CASES) {
      const draft = await writeDraft(models(), testCase.analysis, testCase.selection, testCase.facts, testCase.roles);
      const before = structuredClone(draft);
      expect(plantSeed("reverseOutcome", draft, testCase)).not.toBeNull();
      expect(draft).toEqual(before);
    }
  });

  it("does not plant a direction reversal when another cited fact supports it", () => {
    const base = SEED_CASES[0]!;
    const fact = base.facts[1]!;
    const other = { ...fact, id: "opposite", text: "Increased deployment time by 35% with Kubernetes", quote: "Increased deployment time by 35% with Kubernetes" };
    const testCase = { ...base, facts: [...base.facts, other], selection: { ...base.selection, factIds: [...base.selection.factIds, other.id] } };
    const draft = { lines: [{ id: "line", roleId: fact.roleId, factIds: [fact.id, other.id], text: fact.text }] };
    expect(plantSeed("reverseOutcome", draft, testCase)).toBeNull();
  });

  it("plants a clear reversal even when the deterministic direction checker cannot classify it", () => {
    const base = SEED_CASES[0]!;
    const fact = { ...base.facts[1]!, text: "Reduced latency in production", quote: "Reduced latency in production" };
    const testCase = { ...base, facts: [fact], selection: { ...base.selection, factIds: [fact.id] } };
    const draft = { lines: [{ id: "line", roleId: fact.roleId, factIds: [fact.id], text: fact.text }] };
    const planted = plantSeed("reverseOutcome", draft, testCase)!;
    expect(planted).not.toBeNull();
    expect(planted.draft.lines[0]!.text).toBe("Increased latency in production");
    expect(scoreSeed(planted, { lines: planted.draft.lines, report }, testCase)).toMatchObject({ caught: false, survives: true });
  });

  it("keeps supported baseline lines when the fixture judge has no reason to reject them", async () => {
    for (const testCase of SEED_CASES) {
      const model = models();
      const draft = await writeDraft(
        model,
        testCase.analysis,
        testCase.selection,
        testCase.facts,
        testCase.roles,
      );
      const verified = await verifyDraft(
        model,
        draft,
        testCase.selection,
        testCase.facts,
      );
      expect(verified.lines).toHaveLength(draft.lines.length);
      expect(verified.report.dropped).toBe(0);
    }
  });
});
