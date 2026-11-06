#!/usr/bin/env node
// Read-only accounting diagnostic. Does not settle attempts or enable spending.
import { fileURLToPath } from "node:url";
import { SharedPilotBudget } from "../test/evals/shared-pilot.mjs";
import { preflightPilotDeployment } from "./lib/pilot-deployment.mjs";

export async function inspectPilotAttempts({ env = process.env, providerFetch = fetch, pilotFetch = fetch } = {}, dependencies = {}) {
  const preflight = await preflightPilotDeployment({ env, fetcher: providerFetch }, dependencies);
  if (preflight.deployment !== "single_version_observed" || preflight.bindings !== "expected_bindings_observed") return preflight;
  try {
    const pilot = new SharedPilotBudget(env.STAGING_URL, env.PILOT_BUDGET_KEY, pilotFetch);
    const { totals, attempts } = await pilot.auditAttempts();
    return { status: "pending", deploymentId: preflight.deploymentId, versionId: preflight.versionId,
      totals, attempts, pending: [...preflight.pending, "attempt_outcome_and_provider_bounds_unverified"] };
  } catch {
    return { status: "pending", pending: ["pilot_attempt_audit_unavailable"] };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = await inspectPilotAttempts();
  console.log(JSON.stringify(report));
  process.exitCode = 2;
}
