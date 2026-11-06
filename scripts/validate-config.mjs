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
} = {}) {
  if (!["deploy", "eval", "e2e"].includes(purpose))
    throw new Error("purpose must be deploy, eval or e2e");
  const missing = [];
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
    for (const name of [
      "CF_ACCOUNT_ID",
      "OIDC_CLIENT_ID",
      "ACCESS_TEAM_DOMAIN",
      "ACCESS_AUD",
      "AI_GATEWAY_ID",
    ])
      if (!config.vars?.[name]?.trim()) missing.push(`vars.${name}`);
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
    if (
      !(Number(config.vars?.DAILY_SPEND_CAP_USD) > 0) ||
      !Number.isFinite(Number(config.vars?.DAILY_SPEND_CAP_USD))
    )
      missing.push("vars.DAILY_SPEND_CAP_USD");
    if (environment === "production" && config.vars?.RESTORE_FENCE_IDS?.trim())
      missing.push("PRODUCTION_MAINTENANCE_FENCE_ACTIVE");
    if (environment === "production" && config.vars?.ROLE_UNKNOWN_END_ENABLED === "true")
      missing.push("ROLE_UNKNOWN_END_ROLLOUT_UNVERIFIED");
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
