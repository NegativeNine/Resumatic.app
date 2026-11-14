import { writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { auditPilotLedger } from "../extract-evals/budget-ledger.mjs";
import { privateRoot } from "../extract-evals/private-dataset.mjs";
import { CLEF_MODEL } from "../../src/ai/decision-judge";
import { SMOKE_LIMITATIONS, SMOKE_LIMITS, type SmokeCheck, type SmokeQuestion, type runPipelineSmoke } from "./pipeline-smoke";

/** Checkpoint completed synthetic checks and individual answers, even if a later request fails. */
export function createSmokeReport(directory: string) {
  const root = privateRoot(directory);
  const file = join(root, "pipeline-smoke-report.json");
  const ledger = join(root, "first-staging-evals-budget.sqlite");
  const checks: SmokeCheck[] = [], questions: SmokeQuestion[] = [];
  let state = { complete: false, passed: false, models: { judge: CLEF_MODEL }, checks, questions, limitations: SMOKE_LIMITATIONS, accounting: auditPilotLedger(ledger), failure: undefined as string | undefined };
  // A previous report cannot be silently replaced by a fresh invocation.
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  const save = () => {
    state.accounting = auditPilotLedger(ledger);
    const temporary = join(root, `.pipeline-smoke-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  };
  return {
    check(check: SmokeCheck) { checks.push(check); save(); },
    question(question: SmokeQuestion) { questions.push(question); save(); },
    finish(result: Awaited<ReturnType<typeof runPipelineSmoke>>) {
      const accounting = auditPilotLedger(ledger);
      const complete = result.complete && accounting.attempts.length === SMOKE_LIMITS.expectedRequests && accounting.attempts.every((attempt: { state: string }) => attempt.state === "settled") && !accounting.frozen;
      state = { ...state, ...result, checks, questions, complete, passed: result.passed && complete, accounting };
      save();
      return { complete, passed: state.passed };
    },
    fail() { state.failure = "pipeline_smoke_failed_or_incomplete"; state.passed = false; save(); },
  };
}
