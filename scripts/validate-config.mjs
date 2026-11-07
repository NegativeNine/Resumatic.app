#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readConfig, httpsOrigin } from "./lib/config.mjs";

export function livePrerequisites(env, purpose = "eval") {
  const missing = [];
  const need = (name) => {
    if (!env[name]?.trim()) missing.push(name);
  };
  if (purpose === "eval") {
    need("CF_ACCOUNT_ID");
    need("CF_AI_TOKEN");
    need("AI_GATEWAY_ID");
  } else {
    need("STAGING_URL");
    need("TEST_SIGNIN_KEY");
    if (env.STAGING_URL && !httpsOrigin(env.STAGING_URL))
      missing.push("STAGING_URL_HTTPS_ORIGIN");
  }
  if (
    !(Number(env.EVAL_BUDGET_USD) > 0) ||
    !Number.isFinite(Number(env.EVAL_BUDGET_USD))
  )
    missing.push("EVAL_BUDGET_USD");
  if (
    !(Number(env.EVAL_MAX_CALLS) > 0) ||
    !Number.isSafeInteger(Number(env.EVAL_MAX_CALLS))
  )
    missing.push("EVAL_MAX_CALLS");
  return [...new Set(missing)];
}

export async function validate({
  environment = "staging",
  purpose = "deploy",
  env = process.env,
  configPath = "wrangler.jsonc",
  testSigninOnly = false,
  smokeOnly = false,
} = {}) {
  if (!["deploy", "eval", "e2e"].includes(purpose))
    throw new Error("purpose must be deploy, eval or e2e");
  const missing = [];
  const stagingTestOnly = testSigninOnly === true && environment === "staging" && purpose === "deploy";
  const stagingSmoke = smokeOnly === true && environment === "staging" && purpose === "deploy";
  if (testSigninOnly && !stagingTestOnly)
    missing.push("TEST_SIGNIN_ONLY_STAGING_DEPLOY_REQUIRED");
  if (smokeOnly && !stagingSmoke)
    missing.push("SMOKE_ONLY_STAGING_DEPLOY_REQUIRED");
  if (purpose !== "deploy") missing.push(...livePrerequisites(env, purpose));
  if (purpose === "e2e") {
    const { config } = await readConfig(environment, configPath);
    if (config.vars?.ALLOW_TEST_SIGNIN !== "true")
      missing.push("vars.ALLOW_TEST_SIGNIN");
    if (
      !(Number(config.vars?.DAILY_SPEND_CAP_USD) > 0) ||
      !Number.isFinite(Number(config.vars?.DAILY_SPEND_CAP_USD))
    )
      missing.push("vars.DAILY_SPEND_CAP_USD");
  } else if (purpose === "deploy") {
    const { root, config } = await readConfig(environment, configPath);
    for (const name of ["CF_ACCOUNT_ID", "AI_GATEWAY_ID", ...(stagingSmoke ? [] : ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"])])
      if (!config.vars?.[name]?.trim()) missing.push(`vars.${name}`);
    if (!stagingTestOnly && !stagingSmoke && !config.vars?.OIDC_CLIENT_ID?.trim())
      missing.push("vars.OIDC_CLIENT_ID");
    if ((stagingTestOnly || stagingSmoke) && config.vars?.ALLOW_TEST_SIGNIN !== "true")
      missing.push("vars.ALLOW_TEST_SIGNIN");
    if (stagingSmoke) {
      // These empty settings keep the public Google and admin entry points
      // unavailable. Pilot mode blocks model attempts and Browser Run.
      for (const name of ["OIDC_CLIENT_ID", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD"])
        if (config.vars?.[name] !== undefined && config.vars[name] !== "")
          missing.push(`SMOKE_REQUIRES_EMPTY_${name}`);
      for (const [name, value] of Object.entries({
        PILOT_SHARED_BUDGET: "true", DAILY_SPEND_CAP_USD: "0", INVITE_ONLY: "true",
        BILLING_ENABLED: "false", MCP_ENABLED: "false",
      })) if (config.vars?.[name] !== value) missing.push(`SMOKE_REQUIRES_${name}`);
      if (!config.durable_objects?.bindings?.some((binding) =>
        binding.name === "PILOT_BUDGET" && binding.class_name === "PilotBudget"))
        missing.push("SMOKE_REQUIRES_PILOT_BUDGET_BINDING");
    }
    for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])
      if (!env[name]?.trim()) missing.push(name);
    if (
      config.vars?.CF_ACCOUNT_ID &&
      env.CLOUDFLARE_ACCOUNT_ID &&
      config.vars.CF_ACCOUNT_ID !== env.CLOUDFLARE_ACCOUNT_ID
    )
      missing.push("ACCOUNT_ID_MISMATCH");
    if (
      environment === "production" &&
      config.vars?.ALLOW_TEST_SIGNIN === "true"
    )
      missing.push("PRODUCTION_TEST_SIGNIN_FORBIDDEN");
    if (
      environment === "production" &&
      (config.vars?.TEST_SIGNIN_KEY || env.TEST_SIGNIN_KEY)
    )
      missing.push("PRODUCTION_TEST_SIGNIN_KEY_FORBIDDEN");
    // Open registration lets a creation dispatched before deletion recreate
    // the global account after erasure. This rollout guard limits exposure;
    // invite-only mode does not settle stale calls or prove deletion safe.
    if (environment === "production" && config.vars?.INVITE_ONLY !== "true")
      missing.push("PUBLIC_REGISTRATION_ROLLOUT_UNVERIFIED");
    if (!stagingSmoke && (
      !(Number(config.vars?.DAILY_SPEND_CAP_USD) > 0) ||
      !Number.isFinite(Number(config.vars?.DAILY_SPEND_CAP_USD))
    ))
      missing.push("vars.DAILY_SPEND_CAP_USD");
    if (environment === "production" && config.vars?.RESTORE_FENCE_IDS?.trim())
      missing.push("PRODUCTION_MAINTENANCE_FENCE_ACTIVE");
    if (environment === "production" && config.vars?.ROLE_UNKNOWN_END_ENABLED === "true")
      missing.push("ROLE_UNKNOWN_END_ROLLOUT_UNVERIFIED");
    if (environment === "production" && config.vars?.R2_CACHE_FENCE_ENABLED && config.vars.R2_CACHE_FENCE_ENABLED !== "false")
      missing.push("R2_CACHE_FENCE_ROLLOUT_UNVERIFIED");
    if (environment === "production" && config.vars?.PLACEMENT_FENCE_ENABLED && config.vars.PLACEMENT_FENCE_ENABLED !== "false")
      missing.push("PLACEMENT_FENCE_ROLLOUT_UNVERIFIED");
    // A delayed sharded creation can recreate an identity after deletion.
    // Keep new production placement on the global Directory until the
    // dispatch fence and mixed-version recovery are independently verified.
    if (environment === "production" && config.vars?.DIRECTORY_SHARDS !== undefined &&
        !["", "0", "1"].includes(config.vars.DIRECTORY_SHARDS))
      missing.push("DIRECTORY_SHARD_ROLLOUT_UNVERIFIED");
    if (
      config.vars?.ACCESS_TEAM_DOMAIN &&
      !httpsOrigin(config.vars.ACCESS_TEAM_DOMAIN)
    )
      missing.push("ACCESS_TEAM_DOMAIN_HTTPS_ORIGIN");
    if (!config.r2_buckets?.some((bucket) => bucket.binding === "FILES"))
      missing.push("FILES_BINDING");
    if (
      ["DISTILL", "TAILOR", "DOCUMENTS", "REEMBED"].some(
        (binding) =>
          !config.workflows?.some((workflow) => workflow.binding === binding),
      )
    )
      missing.push("WORKFLOW_BINDINGS");
    if (config.vars?.MCP_ENABLED === "true") {
      if (!httpsOrigin(config.vars.APP_ORIGIN))
        missing.push("APP_ORIGIN_HTTPS_ORIGIN");
      if (
        !config.kv_namespaces?.some(
          (namespace) =>
            namespace.binding === "OAUTH_KV" &&
            /^[a-f0-9]{32}$/i.test(namespace.id ?? ""),
        )
      )
        missing.push("OAUTH_KV_NAMESPACE_ID");
      if (
        !(config.compatibility_flags ?? root.compatibility_flags)?.includes(
          "global_fetch_strictly_public",
        )
      )
        missing.push("CIMD_PUBLIC_FETCH_COMPATIBILITY_FLAG");
    }
  }
  return {
    status: missing.length ? "pending" : "ready",
    purpose,
    environment,
    ...(stagingTestOnly ? { testSigninOnly: true } : {}),
    ...(stagingSmoke ? { smokeOnly: true } : {}),
    checkedAt: new Date().toISOString(),
    commit: env.GITHUB_SHA ?? null,
    missing,
    note: "Configuration readiness is not evidence of a passing live check.",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i < 0 ? fallback : args[i + 1];
  };
  try {
    const report = await validate({
      environment: value("--environment", "staging"),
      purpose: value("--purpose", "deploy"),
      testSigninOnly: args.includes("--test-signin-only"),
      smokeOnly: args.includes("--smoke-only"),
    });
    const serialized = JSON.stringify(report, null, 2) + "\n";
    if (value("--report"))
      await writeFile(value("--report"), serialized, { mode: 0o600 });
    process.stdout.write(serialized);
    process.exitCode = report.status === "ready" ? 0 : 2;
  } catch {
    console.error(
      "Configuration check failed. Check the configuration syntax and command options; no values were logged.",
    );
    process.exitCode = 1;
  }
}
