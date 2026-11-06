#!/usr/bin/env node
// Staging-only diagnostic. It opens/consumes a one-use identity probe but
// never creates a user, starts a Workflow, deploys or makes a model request.
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { SharedPilotBudget } from "../test/evals/shared-pilot.mjs";
import { inspectPilotDeployment, preflightPilotDeployment } from "./lib/pilot-deployment.mjs";

const PATHS = new Set(["distill", "tailor", "document", "reembed", "vault"]);
const RUN = /^[A-Za-z0-9_-]{1,100}$/;
const VAULT = /^[0-9a-f]{64}$/i;

/** Injectable I/O exists for local stand-in tests; it never enables the pilot. */
export async function runPilotInspection({ args, env = process.env, input = process.stdin, output = process.stderr,
  providerFetch = fetch, pilotFetch = fetch, promptRun, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now }, dependencies = {}) {
  const pending = (reason) => ({ status: "pending", pending: [reason] });
  if (!Array.isArray(args) || args.length !== 4 || args[0] !== "--path" || args[2] !== "--vault-id" ||
      !PATHS.has(args[1]) || typeof args[3] !== "string" || !VAULT.test(args[3]))
    return pending("path_and_vault_id_required");
  if (!input?.isTTY || !output?.isTTY) return pending("interactive_terminal_required");
  const preflight = await preflightPilotDeployment({ env, fetcher: providerFetch }, dependencies);
  if (preflight.deployment !== "single_version_observed" || preflight.bindings !== "expected_bindings_observed")
    return preflight;
  let pilot;
  try { pilot = new SharedPilotBudget(env.STAGING_URL, env.PILOT_BUDGET_KEY, pilotFetch); }
  catch { return pending("pilot_configuration_unavailable"); }
  try {
    const challenge = await pilot.beginIdentity(args[1], args[3]);
    const openedAt = now();
    if (!Number.isSafeInteger(openedAt) || challenge.expiresAt <= openedAt || challenge.expiresAt > openedAt + 125_000)
      return pending("probe_expiry_invalid");
    const deadline = Math.min(challenge.expiresAt, openedAt + 120_000);
    // The old-version/Workflow drain cannot be inferred from preflight. The
    // operator must establish that separately before triggering any work.
    output.write("Identity challenge opened. Only after verifying old Workers and Workflows are drained, " +
      "start the selected synthetic run separately. This command will not start it.\n");
    let runId;
    if (promptRun) runId = await promptRun();
    else {
      const terminal = createInterface({ input, output });
      try { runId = await terminal.question("Run ID: ", { signal: AbortSignal.timeout(60_000) }); }
      finally { terminal.close(); }
    }
    if (typeof runId !== "string" || !RUN.test(runId)) return pending("run_id_invalid");
    // A Workflow may not reach its model-attempt path immediately. All waits
    // are short and bounded by the probe's own expiry; no provider call occurs.
    for (;;) {
      const current = now();
      if (!Number.isSafeInteger(current) || current >= deadline) return pending("probe_expired");
      if ((await pilot.identityStatus(challenge.nonce)).state === "observed") break;
      await wait(1000);
    }
    return await inspectPilotDeployment({ pilot, nonce: challenge.nonce, runId, env, fetcher: providerFetch }, dependencies);
  } catch {
    // Never surface a provider response, credential, nonce or user input.
    return pending("pilot_probe_unavailable");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = await runPilotInspection({ args: process.argv.slice(2) });
  console.log(JSON.stringify(report));
  process.exitCode = 2; // Always pending; no release or paid-call guard is changed.
}
