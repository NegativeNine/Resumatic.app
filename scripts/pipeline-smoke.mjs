#!/usr/bin/env node
// An isolated fixed synthetic campaign. It does not enable shared staging pilot/model paths.
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPilotLedger } from "../test/extract-evals/budget-ledger.mjs";
import { privateRoot } from "../test/extract-evals/private-dataset.mjs";

const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== "--live" || args[1] !== "--directory") throw new Error("usage: pipeline-smoke.mjs --live --directory <existing-private-directory>");
if (!/^[a-f0-9]{32}$/i.test(process.env.CF_ACCOUNT_ID ?? "") || !process.env.CF_AI_TOKEN || process.env.AI_GATEWAY_ID !== "resumatic-staging") throw new Error("pipeline_smoke_staging_credentials_required");
const directory = privateRoot(resolve(args[2]));
// Exclusive creation: retries cannot erase spent/reserved accounting or start over here.
createPilotLedger(directory, 1_000_000, 50, 18);
const project = fileURLToPath(new URL("../", import.meta.url));
const run = spawnSync(process.execPath, [join(project, "node_modules/vitest/vitest.mjs"), "run", "--project", "evals", "test/evals/pipeline-smoke.eval.ts", "--no-file-parallelism"], {
  cwd: project, stdio: "inherit", env: { ...process.env, PIPELINE_SMOKE_LIVE: "1", PIPELINE_SMOKE_DIRECTORY: directory },
});
process.exitCode = run.status ?? 1;
