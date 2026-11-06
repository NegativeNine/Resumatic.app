import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { extractPrompt } from "../../src/ai/prompts";
import type { Usage } from "../../src/ai/usage";
import { extractorById } from "../../src/pipeline/extract";
import {
  ACCOMPLISHMENTS,
  OUTLINE,
  ROLE,
} from "../../src/pipeline/extract/clairic";
import { judgeFacts } from "../../src/pipeline/extract/judge";
import { verifyExtraction } from "../../src/pipeline/extract/verify";
import { credentials, restModels, wranglerVars } from "../evals/rest-models";
import { evalBudgetFromEnv } from "./budget";
import { CASES, oraclePrediction } from "./cases";
import { scoreCase } from "./score";

const live = process.env.EXTRACT_LIVE === "1";
const split = process.env.EXTRACT_SPLIT || "dev";
const strategyIds = (process.env.EXTRACT_STRATEGY || "llm:default").split(",");
strategyIds.forEach(extractorById);
const repeats = Number(process.env.EXTRACT_REPEAT || "1");
if (
  !["dev", "holdout"].includes(split) ||
  !Number.isSafeInteger(repeats) ||
  repeats < 1 ||
  repeats > 10
)
  throw new Error("extract_eval_arguments");
const creds = credentials();
const vars = live ? wranglerVars(process.env.EVAL_ENV || "staging") : {};
const records: Record<string, unknown>[] = [];
const budget = live ? evalBudgetFromEnv() : null;
if (live && !creds) throw new Error("live_eval_credentials_required");
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const configurationHash = hash({
  extract: extractPrompt("<fixture>"),
  outline: OUTLINE,
  role: ROLE,
  accomplishments: ACCOMPLISHMENTS,
});

afterAll(() => {
  const report = {
    generatedAt: new Date().toISOString(),
    mode: live ? "live" : "harness-self-check",
    split,
    configurationHash,
    datasetHash: hash(
      CASES.map((c) => ({ id: c.id, markdown: c.markdown, gold: c.gold })),
    ),
    models: Object.fromEntries(
      Object.entries(vars).filter(([key]) => key.startsWith("MODEL_")),
    ),
    promotionEligible: false,
    pending: [
      "consented-real-cases",
      "PDF-DOCX-conversion-fixtures",
      "human-entailment-audit",
      ...(live ? [] : ["live-model-evaluation"]),
    ],
    budget: budget
      ? {
          calls: budget.calls,
          reservedUsd: budget.reservedUsd,
          measuredUsd: budget.measuredUsd,
          unpricedCalls: budget.unpricedCalls,
        }
      : null,
    cases: records,
  };
  writeFileSync("extract-report.json", JSON.stringify(report, null, 2));
  writeFileSync(
    "extract-report.md",
    `# Extraction evaluation\n\nMode: ${report.mode}. Promotion is pending real-format fixtures and human audit.\n\n${records.length} case runs. Configuration: ${configurationHash}.\n`,
  );
});

describe.sequential("extraction evaluation", () => {
  for (const strategyId of strategyIds)
    for (let repeat = 0; repeat < repeats; repeat++) {
      it.each(CASES.filter((c) => c.split === split))(
        `${strategyId} run ${repeat + 1}: $id`,
        async (testCase) => {
          const usage: Usage[] = [];
          let recorded = false;
          const started = Date.now();
          const models = live
            ? restModels(creds!, vars, {
                budget: budget!,
                onUsage: (u) => {
                  usage.push(u);
                },
              })
            : null;
          try {
            const raw = models
              ? await extractorById(strategyId).extract(
                  {
                    markdown: testCase.markdown,
                    filename: `${testCase.id}.md`,
                    referenceDate: testCase.referenceDate,
                  },
                  models,
                )
              : oraclePrediction(testCase);
            const { extraction, dropped } = verifyExtraction(
              testCase.markdown,
              raw,
            );
            const score = scoreCase(extraction, testCase.gold);
            const unsupported = models
              ? (await judgeFacts(models, extraction.facts)).filter(
                  (v) => v === "unsupported",
                ).length
              : null;
            records.push({
              caseId: testCase.id,
              strategy: live ? strategyId : "oracle-self-check",
              repeat,
              score,
              dropped: dropped.length,
              unsupportedClaims: unsupported,
              ms: Date.now() - started,
              usage,
              outcome: "ok",
            });
            recorded = true;
            expect(score.trapLeaks).toBe(0);
            if (models) expect(unsupported).toBe(0);
            else expect(score.recall).toBe(1);
          } catch {
            if (!recorded)
              records.push({
                caseId: testCase.id,
                strategy: strategyId,
                repeat,
                outcome: "failed",
                ms: Date.now() - started,
                usage,
              });
            // No raw input, provider error bodies or candidate output in test failure logs.
            throw new Error("extract_eval_case_failed");
          }
        },
      );
    }
});
