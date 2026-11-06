import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Usage } from "../../src/ai/usage";
import { extractorById } from "../../src/pipeline/extract";
import { judgeFacts } from "../../src/pipeline/extract/judge";
import { verifyExtraction } from "../../src/pipeline/extract/verify";
import { credentials, restModels, wranglerVars } from "../evals/rest-models";
import { evalBudgetFromEnv } from "./budget";
import { CASES, oraclePrediction } from "./cases";
import { scoreCase } from "./score";
import type { VerifiedExtraction } from "../../src/pipeline/extract/types";
import {
  createPrivateSnapshot,
  loadPrivateDataset,
} from "./private-dataset.mjs";
import { candidateKey } from "./promotion.mjs";
import { extractionConfiguration } from "./configuration.mjs";
import { requirePilotExtraction } from "../evals/nonvacuity";

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
type Candidate = {
  key: string;
  caseId: string;
  strategy: string;
  roleKey: string | null;
  kind: "accomplishment" | "skill" | "credential";
  span: [number, number];
  text: string;
  quote: string;
  judge: "supported" | "unsupported" | null;
};
type RunRecord = {
  caseId: string;
  strategy: string;
  repeat: number;
  outcome: "ok" | "failed";
  ms: number;
  usage: Usage[];
  candidateKeys: string[];
  score?: ReturnType<typeof scoreCase>;
  unsupportedClaims?: number | null;
  dropped?: number;
  prediction?: VerifiedExtraction;
  judgeVerdicts?: ("supported" | "unsupported")[];
};
const records: RunRecord[] = [];
const candidates: Candidate[] = [];
const privateDataset = process.env.EXTRACT_DATASET_DIR
  ? loadPrivateDataset(process.env.EXTRACT_DATASET_DIR)
  : null;
const cases = privateDataset?.cases ?? CASES;
const runId = randomUUID();
const budget = live ? evalBudgetFromEnv() : null;
if (live && !creds) throw new Error("live_eval_credentials_required");
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const environment = process.env.EVAL_ENV || "staging";
const configuration = extractionConfiguration(strategyIds, environment);
const configurationHash = configuration.hash;

afterAll(() => {
  const privateSnapshot =
    privateDataset && live
      ? createPrivateSnapshot(privateDataset.root, {
          version: 1,
          runId,
          mode: "live",
          split,
          environment,
          manifestHash: privateDataset.manifestHash,
          configurationHash,
          strategies: strategyIds,
          repeats,
          records: records.map(({ dropped: _dropped, ...row }) => row),
          candidates,
        })
      : null;
  const report = {
    generatedAt: new Date().toISOString(),
    mode: live ? "live" : "harness-self-check",
    split,
    configurationHash,
    sourceFixtureManifestHash: hash(
      JSON.parse(
        readFileSync(
          resolve("test/extract-evals/fixtures/manifest.json"),
          "utf8",
        ),
      ),
    ),
    datasetHash:
      privateDataset?.manifestHash ??
      hash(
        CASES.map((c) => ({ id: c.id, markdown: c.markdown, gold: c.gold })),
      ),
    privateSnapshot,
    models: Object.fromEntries(
      Object.entries(vars).filter(([key]) => key.startsWith("MODEL_")),
    ),
    promotionEligible: false,
    pending: [
      ...(privateDataset
        ? []
        : ["consented-real-cases", "PDF-DOCX-conversion-fixtures"]),
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
    cases: records.map(
      ({
        candidateKeys: _keys,
        prediction: _prediction,
        judgeVerdicts: _verdicts,
        ...row
      }) => row,
    ),
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
      it.each(cases.filter((c) => c.split === split))(
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
                    filename: `${testCase.id}.${"format" in testCase.meta ? testCase.meta.format : "md"}`,
                    referenceDate: testCase.referenceDate,
                  },
                  models,
                )
              : privateDataset
                ? {
                    roles: testCase.gold.roles.map((r) => ({
                      key: r.id,
                      kind: r.kind,
                      org: r.org,
                      title: r.title,
                      startDate: r.start,
                      endDate: r.end,
                      quote: testCase.markdown.slice(...r.header),
                      span: r.header,
                    })),
                    facts: testCase.gold.facts.map((f) => ({
                      roleKey: f.role,
                      kind: f.kind,
                      text: testCase.markdown.slice(...f.span),
                      quote: testCase.markdown.slice(...f.span),
                      span: f.span,
                      level: f.level,
                    })),
                  }
                : oraclePrediction(testCase as (typeof CASES)[number]);
            const { extraction, dropped } = verifyExtraction(
              testCase.markdown,
              raw,
            );
            requirePilotExtraction(
              extraction,
              testCase.gold,
              process.env.PILOT_REQUIRE_EVIDENCE === "1" &&
                process.env.EVAL_BUDGET_LEDGER_SUITE === "extraction" &&
                Boolean(process.env.EVAL_BUDGET_LEDGER),
            );
            const score = scoreCase(extraction, testCase.gold, testCase.markdown);
            const verdicts = models
              ? await judgeFacts(models, extraction.facts)
              : [];
            const unsupported = models
              ? verdicts.filter((v) => v === "unsupported").length
              : null;
            const caseCandidates = extraction.facts.map((fact, index) => {
              const candidate = {
                caseId: testCase.id,
                strategy: strategyId,
                roleKey: fact.roleKey,
                kind: fact.kind,
                span: fact.span,
                text: fact.text,
                quote: fact.quote,
                judge: verdicts[index] ?? null,
              };
              return { ...candidate, key: candidateKey(candidate) };
            });
            if (privateDataset && live) candidates.push(...caseCandidates);
            records.push({
              caseId: testCase.id,
              strategy: live ? strategyId : "oracle-self-check",
              repeat,
              score,
              ...(privateDataset && live
                ? {
                    prediction: {
                      roles: extraction.roles.map(
                        ({
                          key,
                          kind,
                          org,
                          title,
                          startDate,
                          endDate,
                          quote,
                          span,
                        }) => ({
                          key,
                          kind,
                          org,
                          title,
                          startDate,
                          endDate,
                          quote,
                          span,
                        }),
                      ),
                      facts: extraction.facts.map(
                        ({ roleKey, kind, text, level, quote, span }) => ({
                          roleKey,
                          kind,
                          text,
                          level,
                          quote,
                          span,
                        }),
                      ),
                    },
                    judgeVerdicts: verdicts,
                  }
                : {}),
              dropped: dropped.length,
              unsupportedClaims: unsupported,
              ms: Date.now() - started,
              usage,
              candidateKeys:
                privateDataset && live ? caseCandidates.map((c) => c.key) : [],
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
                candidateKeys: [],
              });
            // No raw input, provider error bodies or candidate output in test failure logs.
            throw new Error("extract_eval_case_failed");
          }
        },
      );
    }
});
