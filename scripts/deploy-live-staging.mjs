#!/usr/bin/env node
// Preserve an already configured staging service. A failed settings read never reaches deploy.
import { spawnSync } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validStagingSecretNames } from "./lib/release-secret-names.mjs";

const PROJECT = fileURLToPath(new URL("../", import.meta.url));
const WORKER = "resumatic-staging";
const fail = (code) => { throw new Error(code); };
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const fingerprint = (bindings) => canonical([...bindings].sort((a, b) => a.name.localeCompare(b.name)));

/** Keep live variables/resources; refuse live bindings we cannot preserve deliberately. */
export function stagingOverlay(config, bindings, accountId) {
  if (config.name !== WORKER || config.targetEnvironment !== "staging" || !Array.isArray(bindings)) fail("LIVE_STAGING_TARGET_INVALID");
  const vars = Object.fromEntries(bindings.filter((b) => b.type === "plain_text").map((b) => [b.name, b.text]));
  if (vars.CF_ACCOUNT_ID !== accountId || !vars.OIDC_CLIENT_ID || !vars.AI_GATEWAY_ID) fail("LIVE_STAGING_SETTINGS_INCOMPLETE");
  if (!validStagingSecretNames(bindings.filter((b) => b.type === "secret_text"), { ...config.vars, ...vars })) fail("LIVE_STAGING_SECRET_SHADOWS_CONFIGURATION");
  const out = structuredClone(config);
  out.vars = vars;
  const arrays = { d1: "d1_databases", vectorize: "vectorize", kv_namespace: "kv_namespaces", r2_bucket: "r2_buckets", analytics_engine: "analytics_engine_datasets", ratelimit: "ratelimits", service: "services" };
  for (const key of Object.values(arrays)) out[key] = [];
  const unique = new Set();
  for (const b of bindings) {
    if (typeof b.name !== "string" || !b.name || unique.has(b.name)) fail("LIVE_STAGING_BINDING_INVALID");
    unique.add(b.name);
    if (b.type === "plain_text") {
      if (typeof b.text !== "string") fail("LIVE_STAGING_VARIABLE_INVALID");
      if (/^(?:SESSION_KEY|CF_AI_TOKEN|OIDC_CLIENT_SECRET|TEST_SIGNIN_KEY|PILOT_BUDGET_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)$/.test(b.name)) fail("LIVE_STAGING_PLAINTEXT_SECRET");
    } else if (b.type === "secret_text") {
      // Wrangler preserves secret values itself. Never copy them into the artifact.
    } else if (b.type === "d1") {
      const id = b.id ?? b.database_id;
      if (typeof id !== "string" || !id) fail("LIVE_STAGING_D1_INVALID");
      out.d1_databases.push({ binding: b.name, database_id: id });
    } else if (b.type === "vectorize") {
      if (!b.index_name) fail("LIVE_STAGING_VECTORIZE_INVALID");
      out.vectorize.push({ binding: b.name, index_name: b.index_name });
    } else if (b.type === "kv_namespace") {
      if (!b.namespace_id) fail("LIVE_STAGING_KV_INVALID");
      out.kv_namespaces.push({ binding: b.name, id: b.namespace_id });
    } else if (b.type === "r2_bucket") {
      if (!b.bucket_name) fail("LIVE_STAGING_R2_INVALID");
      out.r2_buckets.push({ binding: b.name, bucket_name: b.bucket_name, ...(b.jurisdiction ? { jurisdiction: b.jurisdiction } : {}) });
    } else if (b.type === "analytics_engine") {
      if (!b.dataset) fail("LIVE_STAGING_METRICS_INVALID");
      out.analytics_engine_datasets.push({ binding: b.name, dataset: b.dataset });
    } else if (b.type === "ratelimit") {
      if (!b.namespace_id || !b.simple) fail("LIVE_STAGING_RATELIMIT_INVALID");
      out.ratelimits.push({ name: b.name, namespace_id: b.namespace_id, simple: b.simple });
    } else if (b.type === "service") {
      if (!b.service) fail("LIVE_STAGING_SERVICE_INVALID");
      out.services.push({ binding: b.name, service: b.service, ...(b.environment ? { environment: b.environment } : {}), ...(b.entrypoint ? { entrypoint: b.entrypoint } : {}) });
    } else if (b.type === "durable_object_namespace") {
      const target = config.durable_objects?.bindings?.find((x) => x.name === b.name);
      if (!target || target.class_name !== b.class_name || (target.script_name ?? WORKER) !== (b.script_name ?? WORKER)) fail("LIVE_STAGING_DURABLE_OBJECT_CHANGED");
    } else if (b.type === "workflow") {
      const target = config.workflows?.find((x) => x.binding === b.name);
      if (!target || target.name !== b.workflow_name || target.class_name !== b.class_name || (target.script_name ?? WORKER) !== (b.script_name ?? WORKER)) fail("LIVE_STAGING_WORKFLOW_CHANGED");
    } else if (["ai", "browser", "assets", "version_metadata"].includes(b.type)) {
      if (config[b.type]?.binding !== b.name) fail("LIVE_STAGING_PLATFORM_BINDING_CHANGED");
    } else fail("LIVE_STAGING_UNSUPPORTED_BINDING");
  }
  for (const b of config.durable_objects?.bindings ?? []) if (!bindings.some((x) => x.name === b.name && x.type === "durable_object_namespace")) fail("LIVE_STAGING_NEW_DURABLE_OBJECT");
  for (const b of config.workflows ?? []) if (!bindings.some((x) => x.name === b.binding && x.type === "workflow")) fail("LIVE_STAGING_NEW_WORKFLOW");
  for (const type of ["ai", "browser", "assets", "version_metadata"]) if (config[type]?.binding && !bindings.some((x) => x.name === config[type].binding && x.type === type)) fail("LIVE_STAGING_NEW_PLATFORM_BINDING");
  return out;
}

export async function deployLiveStaging(options, deps = {}) {
  const accountId = options.accountId;
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? "") || !options.token) fail("LIVE_STAGING_CREDENTIALS_REQUIRED");
  const fetcher = deps.fetch ?? fetch;
  const read = deps.readFile ?? readFile;
  const write = deps.writeFile ?? writeFile;
  const move = deps.rename ?? rename;
  const execute = deps.execute ?? ((command, args) => {
    const result = spawnSync(command, args, { cwd: options.project ?? PROJECT, env: process.env, stdio: "inherit" });
    if (result.error || result.status !== 0) fail("LIVE_STAGING_COMMAND_FAILED");
  });
  async function settings() {
    let response;
    try {
      response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/services/${WORKER}/environments/production/settings`, {
        headers: { authorization: `Bearer ${options.token}` }, redirect: "error", signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) fail("LIVE_STAGING_SETTINGS_READ_FAILED");
      const body = await response.json();
      if (body.success !== true || !Array.isArray(body.result?.bindings)) fail("LIVE_STAGING_SETTINGS_READ_FAILED");
      return body.result.bindings;
    } catch { fail("LIVE_STAGING_SETTINGS_READ_FAILED"); }
  }
  const before = await settings(); // A failed live settings read stops before build or deploy.
  await execute("npm", ["run", "build:staging"]);
  const path = join(options.project ?? PROJECT, "dist/resumatic/wrangler.json");
  const config = JSON.parse(await read(path, "utf8"));
  const overlay = stagingOverlay(config, before, accountId);
  const current = await settings();
  if (fingerprint(before) !== fingerprint(current)) fail("LIVE_STAGING_CHANGED_DURING_BUILD");
  const temporary = join(dirname(path), `staging-runtime-${crypto.randomUUID()}.json`);
  await write(temporary, JSON.stringify(overlay, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await move(temporary, path);
  const wrangler = join(options.project ?? PROJECT, "node_modules/wrangler/bin/wrangler.js");
  await execute(process.execPath, [wrangler, "deploy", "--config", path, "--keep-vars"]);
  return { worker: WORKER, preservedBindings: before.length };
}

export function stagingCredentials(env = process.env, run = spawnSync) {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN;
  const wrangler = join(PROJECT, "node_modules/wrangler/bin/wrangler.js");
  // Capture authentication output privately; refresh OAuth before retrieving its token.
  const refresh = run(process.execPath, [wrangler, "whoami"], { cwd: PROJECT, env: { ...env, CI: "true" }, encoding: "utf8", stdio: "pipe" });
  if (refresh.error || refresh.status !== 0) fail("LIVE_STAGING_AUTH_REQUIRED");
  const result = run(process.execPath, [wrangler, "auth", "token", "--json"], { cwd: PROJECT, env: { ...env, CI: "true" }, encoding: "utf8", stdio: "pipe" });
  try {
    if (result.error || result.status !== 0) fail("LIVE_STAGING_AUTH_REQUIRED");
    const value = JSON.parse(result.stdout);
    if (!["api_token", "oauth"].includes(value.type) || typeof value.token !== "string" || !value.token) fail("LIVE_STAGING_AUTH_REQUIRED");
    return value.token;
  } catch { fail("LIVE_STAGING_AUTH_REQUIRED"); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) fail("LIVE_STAGING_UNEXPECTED_ARGUMENTS");
    const result = await deployLiveStaging({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID, token: stagingCredentials() });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error && /^LIVE_STAGING_[A-Z_]+$/.test(error.message) ? error.message : "LIVE_STAGING_FAILED");
    process.exitCode = 1;
  }
}
