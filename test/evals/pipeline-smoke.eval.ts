import { join } from "node:path";
import { it, expect } from "vitest";
import { privateRoot } from "../extract-evals/private-dataset.mjs";
import { credentials } from "./rest-models";
import { boundedSmokeModels, runPipelineSmoke } from "./pipeline-smoke";
import { createSmokeReport } from "./pipeline-smoke-report";

it.skipIf(process.env.PIPELINE_SMOKE_LIVE !== "1")("isolated bounded synthetic pipeline smoke", async () => {
  const creds = credentials();
  if (!creds) throw new Error("pipeline_smoke_credentials_required");
  const directory = privateRoot(process.env.PIPELINE_SMOKE_DIRECTORY ?? "");
  const ledger = join(directory, "first-staging-evals-budget.sqlite");
  const report = createSmokeReport(directory);
  try {
    const result = await runPipelineSmoke(boundedSmokeModels(creds, ledger, "extraction", fetch, report.question), boundedSmokeModels(creds, ledger, "tailoring", fetch, report.question), report.check);
    const { complete } = report.finish(result);
    expect(complete, "all eight provider requests must have settled").toBe(true);
    expect(result.checks.filter((check) => !check.passed)).toEqual([]);
  } catch {
    report.fail();
    throw new Error("pipeline_smoke_failed_or_incomplete");
  }
}, 300_000);
