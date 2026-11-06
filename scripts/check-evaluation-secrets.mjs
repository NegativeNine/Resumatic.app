#!/usr/bin/env node
// Wrangler exposes secret names, never values. Do not print the subprocess output.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validEvaluationSecretNames } from "./lib/release-secret-names.mjs";

export function checkEvaluationSecrets(run = spawnSync) {
  let result;
  try {
    result = run("npx", ["--no-install", "wrangler", "secret", "list", "--env", "staging"], {
      encoding: "utf8", timeout: 30_000, maxBuffer: 1_000_000,
    });
  } catch {
    return { status: "pending", reason: "STAGING_SECRET_NAMES_UNAVAILABLE" };
  }
  if (result.error || result.status !== 0 || typeof result.stdout !== "string")
    return { status: "pending", reason: "STAGING_SECRET_NAMES_UNAVAILABLE" };
  try {
    if (!validEvaluationSecretNames(JSON.parse(result.stdout)))
      return { status: "pending", reason: "STAGING_SECRET_SHADOWS_CONFIGURATION" };
  } catch {
    return { status: "pending", reason: "STAGING_SECRET_NAMES_UNAVAILABLE" };
  }
  return { status: "passed" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkEvaluationSecrets();
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "passed" ? 0 : 2;
}
