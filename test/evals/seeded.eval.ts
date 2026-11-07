import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { judgePrompt, repairPrompt, writePrompt } from "../../src/ai/prompts";
import type { Usage } from "../../src/ai/usage";
import { verifyDraft, writeDraft } from "../../src/pipeline/tailor";
import { checkLine } from "../../src/grounding/verdict";
import { fakeModels } from "../support/fixtures";
import { evalBudgetFromEnv } from "../extract-evals/budget";
import { credentials, restModels, wranglerVars } from "./rest-models";
import { seedFailureRecords, summarizeSeedRecords, type SeedRecord } from "./seeded-report";
import { extractionConfiguration } from "../extract-evals/configuration.mjs";
import {
  INSTRUCTION_CLAIM,
  SEED_CASES,
  SEED_KINDS,
  SEED_VERSION,
  plantSeed,
  scoreSeed,
  type SeedKind,
} from "./seeded";

// Default is a harness check with controlled model replies. Live calls require a separate opt-in.
const live = process.env.SEEDED_LIVE === "1";
const repeats = Number(process.env.SEEDED_REPEAT || 1);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10)
  throw new Error("seeded_eval_repeat_invalid");
const creds = live ? credentials() : null;
if (live && !creds) throw new Error("seeded_eval_credentials_required");
const budget = live ? evalBudgetFromEnv() : null;
const vars = live ? wranglerVars(process.env.EVAL_ENV || "staging") : {};
const environment = process.env.EVAL_ENV || "staging";
const sourceConfiguration = extractionConfiguration(["llm:default"], environment, { priceOverrides: {} });
const records: SeedRecord[] = [];
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

afterAll(() => {
  const kinds = summarizeSeedRecords(records);
  const baselines = records.filter((record) => record.outcome === "baseline");
  const sumBaseline = (field: string) => baselines.reduce((sum, record) => sum + Number(record[field] ?? 0), 0);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: live ? "live" : "harness-self-check",
    commit: process.env.GITHUB_SHA ?? null,
    environment,
    sourceConfigurationHash: sourceConfiguration.hash,
    baseline: { cases: baselines.length, inputLines: sumBaseline("inputLines"), outputLines: sumBaseline("outputLines"), deterministicViolations: sumBaseline("deterministicViolations") },
    seedVersion: SEED_VERSION,
    models: Object.fromEntries(
      Object.entries(vars).filter(([key]) => key.startsWith("MODEL_")),
    ),
    configurationHash: hash({
      seedVersion: SEED_VERSION,
      kinds: SEED_KINDS,
      write: writePrompt([], [], []),
      judge: judgePrompt([]),
      repair: repairPrompt("", "", []),
    }),
    datasetHash: hash(SEED_CASES),
    promotionEligible: false,
    pending: [
      ...(live ? [] : ["live-model-evaluation"]),
      "human-entailment-audit",
      "representative-production-regression-cases",
    ],
    measurement:
      "Planted-claim signatures plus deterministic post-checks; ambiguous action and outcome rewrites are not counted as catches. This is not an independent semantic audit.",
    budget: budget
      ? {
          calls: budget.calls,
          reservedUsd: budget.reservedUsd,
          measuredUsd: budget.measuredUsd,
          unpricedCalls: budget.unpricedCalls,
        }
      : null,
    seeds: kinds,
    cases: records,
  };
  const reportDir = process.env.SEEDED_REPORT_DIR || ".";
  writeFileSync(join(reportDir, "seeded-report.json"), JSON.stringify(report, null, 2));
  writeFileSync(
    join(reportDir, "seeded-report.md"),
    `# Seeded fabrication evaluation\n\nMode: ${report.mode}. Promotion remains pending.\n\n| Seed | Planted | Caught | Uncertain | Catch rate | Inapplicable | Failed | Not run |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${kinds.map((row) => `| ${row.kind} | ${row.planted} | ${row.caught} | ${row.uncertain} | ${row.catchRate === null ? "n/a" : `${(row.catchRate * 100).toFixed(1)}%`} | ${row.skipped} | ${row.failed} | ${row.notRun} |`).join("\n")}\n\nBaseline retention is included in the JSON report so dropping every line cannot masquerade as quality.\n`,
  );
});

describe.sequential("seeded fabrication verification", () => {
  for (let repeat = 0; repeat < repeats; repeat++) {
    it.each(SEED_CASES)(`run ${repeat + 1}: $id`, async (testCase) => {
      const usage: Usage[] = [];
      let activeSeed: SeedKind | undefined;
      let recorded = false;
      try {
        const models = live
          ? restModels(creds!, vars, {
              budget: budget!,
              onUsage: (item) => {
                usage.push(item);
              },
            })
          : fakeModels({
              judgeRejects: [INSTRUCTION_CLAIM, "ignore all earlier rules"],
            });
        const draft = await writeDraft(
          models,
          testCase.analysis,
          testCase.selection,
          testCase.facts,
          testCase.roles,
        );
        const baseline = await verifyDraft(
          models,
          draft,
          testCase.selection,
          testCase.facts,
        );
        const byId = new Map(testCase.facts.map((fact) => [fact.id, fact]));
        const selected = new Set(testCase.selection.factIds);
        const baselineViolations = baseline.lines.filter(
          (line) => !checkLine(line, byId, selected).ok,
        ).length;
        records.push({
          caseId: testCase.id,
          repeat,
          outcome: "baseline",
          inputLines: draft.lines.length,
          outputLines: baseline.lines.length,
          retention: draft.lines.length
            ? baseline.lines.length / draft.lines.length
            : 0,
          deterministicViolations: baselineViolations,
        });
        expect(draft.lines.length).toBeGreaterThan(0);
        expect(baselineViolations).toBe(0);
        for (const kind of SEED_KINDS) {
          activeSeed = kind;
          recorded = false;
          const seed = plantSeed(kind, draft, testCase);
          if (!seed) {
            records.push({
              caseId: testCase.id,
              repeat,
              seed: kind,
              outcome: "inapplicable",
            });
            continue;
          }
          const started = Date.now();
          const verified = await verifyDraft(
            models,
            seed.draft,
            testCase.selection,
            testCase.facts,
          );
          const score = scoreSeed(seed, verified, testCase);
          records.push({
            caseId: testCase.id,
            repeat,
            seed: kind,
            outcome: "evaluated",
            ...score,
            ms: Date.now() - started,
          });
          recorded = true;
          expect(score.caught).toBe(true);
        }
      } catch {
        // Stop on an error rather than risk further paid calls, but do not
        // mistake the unvisited seed kinds for a complete set of results.
        records.push(...seedFailureRecords(testCase.id, repeat, activeSeed, recorded));
        // Provider replies, prompts and candidate text stay out of diagnostics and artifacts.
        throw new Error("seeded_eval_case_failed");
      } finally {
        records.push({ caseId: testCase.id, repeat, outcome: "usage", usage });
      }
    });
  }
});
