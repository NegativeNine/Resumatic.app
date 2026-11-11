import { describe, expect, it } from "vitest";
import type { Models } from "../../src/ai/models";
import type { JudgeItem } from "../../src/ai/prompts";
import { extractFacts } from "../../src/pipeline/distill";
import type { ResumeBody } from "../../src/shared/api";
import { requireCitedDraft, requireExpectedExtraction, requirePilotExtraction } from "../evals/nonvacuity";
import { runPilotTailoring } from "../evals/pilot-tailor";
import { CASES } from "../extract-evals/cases";
import { scoreCase } from "../extract-evals/score";
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
