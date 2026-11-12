import { describe, expect, it } from "vitest";
import type { Models } from "../../src/ai/models";
import type { JudgeItem } from "../../src/ai/prompts";
import { extractFacts } from "../../src/pipeline/distill";
import type { ResumeBody } from "../../src/shared/api";
import { requireCitedDraft, requireExpectedExtraction, requirePilotExtraction, requireTagging } from "../evals/nonvacuity";
import { runPilotTailoring } from "../evals/pilot-tailor";
import { precision, runTagging } from "../evals/tagging";
import { CASES } from "../extract-evals/cases";
import { scoreCase } from "../extract-evals/score";
import { TAG_CONCEPTS, TAG_LINES, type TagExample } from "../fixtures/tag-lines";
import { fakeModels, RESUME } from "../support/fixtures";

describe("evaluation non-vacuity", () => {
  it("rejects an empty model extraction when gold contains career evidence", async () => {
    const { extraction } = await extractFacts(
      fakeModels({ extraction: { roles: [], facts: [] } }),
      RESUME,
    );
    expect(() => requireExpectedExtraction(extraction, { roles: [1], facts: [1] }))
      .toThrow("eval_no_roles");
    // Cases genuinely labeled empty remain valid; the check is based on gold.
    expect(() => requireExpectedExtraction(extraction, { roles: [], facts: [] }))
      .not.toThrow();
    const gold = CASES[0]!.gold;
    expect(() => requirePilotExtraction(extraction, gold, false)).not.toThrow();
    expect(scoreCase(extraction, gold, CASES[0]!.markdown).recall).toBe(0);
    expect(() => requirePilotExtraction(extraction, gold, true))
      .toThrow("eval_no_roles");
    const withRolesOnly = await extractFacts(fakeModels(), RESUME);
    expect(withRolesOnly.extraction.roles.length).toBeGreaterThan(0);
    expect(() => requireExpectedExtraction(
      { ...withRolesOnly.extraction, facts: [] },
      { roles: [1], facts: [1] },
    )).toThrow("eval_no_facts");
  });

  it("rejects a resume without a substantive cited line", () => {
    const empty: ResumeBody = { summary: null, sections: [], skills: ["Go"] };
    expect(() => requireCitedDraft(empty)).toThrow("eval_no_cited_lines");
    const uncited: ResumeBody = {
      ...empty,
      summary: { id: "line-1", text: "Built services", factIds: [], status: "kept" },
    };
    expect(() => requireCitedDraft(uncited)).toThrow("eval_no_cited_lines");
    const cited: ResumeBody = {
      ...uncited,
      summary: { ...uncited.summary!, factIds: ["fact-1"] },
    };
    expect(() => requireCitedDraft(cited)).not.toThrow();
  });

  it("rejects a tagging run that found no candidate, or proposed nothing by a method the labels expect tags from", async () => {
    // The labelled lines with a judge that says yes to everything: both methods propose tags.
    const agreed = await runTagging(fakeModels(), TAG_LINES);
    expect(agreed.outcomes.filter((outcome) => outcome.tagged).length).toBeGreaterThan(0);
    expect(() => requireTagging(agreed.outcomes)).not.toThrow();
    // A judge that declines every question tags nothing wrong, and has measured nothing.
    const declined = await runTagging(fakeModels({ judgeRejects: [":"] }), TAG_LINES);
    expect(declined.outcomes.some((outcome) => outcome.tagged === "mention-label/1")).toBe(true);
    expect(declined.outcomes.some((outcome) => outcome.tagged === "mention-judge/1")).toBe(false);
    expect(() => requireTagging(declined.outcomes)).toThrow("eval_no_tags");
    // Nor has a run whose lines gave nothing to decide: no label in them, or none that was found.
    const line = (text: string, candidates: TagExample["candidates"] = []): TagExample => ({ fact: { kind: "accomplishment", text, quote: text }, candidates });
    const plain = await runTagging(fakeModels(), [line("Mentored 2 junior engineers")]);
    expect(() => requireTagging(plain.outcomes)).toThrow("eval_no_tag_candidates");
    const unfound = await runTagging(fakeModels(), [line("Wrote Pythonic services", [{ concept: TAG_CONCEPTS.python, expect: "tag", decidedBy: "judge", why: "a label inside a longer word" }])]);
    expect(unfound.outcomes).toMatchObject([{ found: false, tagged: null }]);
    expect(() => requireTagging(unfound.outcomes)).toThrow("eval_no_tag_candidates");
    // The rule is held to the same: labels that expect its tags, and a run in which it made none.
    const recased = await runTagging(fakeModels(), [{ fact: { kind: "skill", text: "SQL", quote: "Skills: sql, Go" }, candidates: [{ concept: TAG_CONCEPTS.sql, expect: "tag", decidedBy: "rule", why: "labelled as the rule's, and the rule declines it" }] }]);
    expect(recased.outcomes).toMatchObject([{ found: true, expected: "mention-label/1", tagged: "mention-judge/1" }]);
    expect(() => requireTagging(recased.outcomes)).toThrow("eval_no_tags");
    // Labels that expect no tag from a method ask nothing of it.
    expect(() => requireTagging([{ found: true, expected: null, tagged: null }])).not.toThrow();
  });

  it("reports precision for vector-judge/1, and fails when a vector tag was expected and none was proposed", async () => {
    // With the made-up taxonomy's vector index, a judge that says yes to everything tags every
    // concept found near a line, and the method's precision is reported beside the others.
    const agreed = await runTagging(fakeModels(), TAG_LINES);
    const methods = precision(agreed.outcomes);
    expect(methods["vector-judge/1"].tagged).toBeGreaterThan(0);
    expect(methods["vector-judge/1"].precision).toBeGreaterThan(0);
    expect(methods["vector-judge/1"].precision).toBeLessThan(1);
    expect(() => requireTagging(agreed.outcomes)).not.toThrow();
    // Without an index the labels still expect vector tags, and a run that proposed none has measured nothing.
    const unindexed = await runTagging(fakeModels(), TAG_LINES, undefined, { embed: null });
    expect(unindexed.outcomes.some((outcome) => outcome.expected === "vector-judge/1")).toBe(true);
    expect(unindexed.outcomes.some((outcome) => outcome.tagged === "vector-judge/1")).toBe(false);
    expect(precision(unindexed.outcomes)["vector-judge/1"]).toEqual({ tagged: 0, right: 0, precision: null });
    expect(() => requireTagging(unindexed.outcomes)).toThrow("eval_no_tags");
  });

  it("counts the pilot's judge whichever way the configuration asks it", async () => {
    const analysis = { company: "Example", title: "Engineer", requirements: ["Kubernetes deployment"] };
    // A chat judge, as the top-level configuration has.
    const chat = { judge: 0 };
    await runPilotTailoring(fakeModels({ analysis, calls: chat }));
    expect(chat.judge).toBe(1);
    // A typed-decision judge, as staging has: the pipeline asks it through `judge`, and the
    // pilot must count that as the judge having been asked.
    const typed = { asked: [] as JudgeItem[][], calls: {} as { judge?: number } };
    const models: Models = {
      ...fakeModels({ analysis, calls: typed.calls }),
      async judge(items) {
        typed.asked.push(items);
        return { verdicts: items.map((item) => ({ id: item.alias, verdict: "supported" as const, reason: "" })) };
      },
    };
    await runPilotTailoring(models);
    expect(typed.asked.flat().map((item) => item.text)).toContain("Reduced deployment time by 35% with Kubernetes");
    expect(typed.calls.judge).toBeUndefined();
  });
});
