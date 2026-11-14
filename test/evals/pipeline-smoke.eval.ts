import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it, expect } from "vitest";
import { auditPilotLedger } from "../extract-evals/budget-ledger.mjs";
import { privateRoot } from "../extract-evals/private-dataset.mjs";
import { credentials } from "./rest-models";
import { boundedSmokeModels, runPipelineSmoke, SMOKE_LIMITATIONS } from "./pipeline-smoke";

it.skipIf(process.env.PIPELINE_SMOKE_LIVE !== "1")("isolated bounded synthetic pipeline smoke", async () => {
  const creds = credentials();
  if (!creds) throw new Error("pipeline_smoke_credentials_required");
  const directory = privateRoot(process.env.PIPELINE_SMOKE_DIRECTORY ?? "");
  const ledger = join(directory, "first-staging-evals-budget.sqlite");
  let report: unknown;
  try {
    const result = await runPipelineSmoke(boundedSmokeModels(creds, ledger, "extraction"), boundedSmokeModels(creds, ledger, "tailoring"));
    const accounting = auditPilotLedger(ledger);
    const complete = result.complete && accounting.attempts.length === 8 && accounting.attempts.every((attempt: { state: string }) => attempt.state === "settled") && !accounting.frozen;
    report = { ...result, complete, passed: result.passed && complete, accounting };
    expect(complete, "all eight provider requests must have settled").toBe(true);
    expect(result.checks.filter((check) => !check.passed)).toEqual([]);
  } catch {
    report ??= { complete: false, passed: false, failure: "pipeline_smoke_failed_or_incomplete", accounting: auditPilotLedger(ledger), limitations: SMOKE_LIMITATIONS };
    throw new Error("pipeline_smoke_failed_or_incomplete");
  } finally {
    writeFileSync(join(directory, "pipeline-smoke-report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
}, 300_000);
