import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonc, httpsOrigin, readConfig } from "./lib/config.mjs";
import { livePrerequisites, validate } from "./validate-config.mjs";
import { copyFile, cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { extractionConfiguration } from "../test/extract-evals/configuration.mjs";
import { SEED_KINDS, SEED_VERSION } from "../test/evals/seed-kinds.mjs";
import { configuredExtractors } from "./lib/extractor-routes.mjs";
import { validEvaluationSecretNames, validProductionSecretNames } from "./lib/release-secret-names.mjs";

test("production secrets cannot shadow reviewed variables or activate guarded settings", () => {
  const vars = { DAILY_SPEND_CAP_USD: "1", ACCESS_AUD: "configured", FUTURE_SETTING: "reviewed" };
  assert.equal(validProductionSecretNames([{ name: "SESSION_KEY" }, { name: "CF_AI_TOKEN" }], vars), true);
  for (const name of ["SESSION_KEY", "OIDC_CLIENT_SECRET", "CF_AI_TOKEN", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "ALERT_WEBHOOK_URL", "CF_ANALYTICS_TOKEN"]) {
    assert.equal(validProductionSecretNames([{ name }], vars), true, name);
    assert.equal(validProductionSecretNames([{ name }], { ...vars, [name]: "reviewed" }), false, `shadowed ${name}`);
  }
  for (const name of ["TEST_SIGNIN_KEY", "MODEL_EXTRACT", "MODEL_JUDGE", "EXTRACTOR", "EXTRACTOR_BY_FORMAT", "EXTRACTOR_EXPERIMENT", "ROLE_UNKNOWN_END_ENABLED"]) {
    assert.equal(validProductionSecretNames([{ name }], vars), false);
    if (name !== "TEST_SIGNIN_KEY") assert.equal(validEvaluationSecretNames([{ name }]), false);
  }
  assert.equal(validEvaluationSecretNames([{ name: "TEST_SIGNIN_KEY" }]), true);
  for (const name of ["DAILY_SPEND_CAP_USD", "ACCESS_AUD", "FUTURE_SETTING", "ALLOW_TEST_SIGNIN", "RESTORE_FENCE_IDS", "R2_CACHE_FENCE_ENABLED", "PLACEMENT_FENCE_ENABLED", "DIRECTORY_SHARDS", "INVITE_ONLY", "MCP_ENABLED", "APP_ORIGIN", "PILOT_SHARED_BUDGET", "MODEL_PRICES_JSON", "POSTING_READER_ENABLED", "UNKNOWN_SECRET"]) {
    assert.equal(validProductionSecretNames([{ name }], vars), false, name);
  }
  assert.equal(validProductionSecretNames({}, vars), false);
  assert.equal(validProductionSecretNames([{}], vars), false);
  assert.equal(validProductionSecretNames([], undefined), false);
  assert.equal(validProductionSecretNames([], []), false);
});

test("production preflight requires explicit invite-only registration until deletion races are resolved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "public-registration-config-"));
  try {
    const path = join(dir, "wrangler.jsonc");
    const config = { name: "example", vars: {}, env: { staging: { vars: { INVITE_ONLY: "false" } } } };
    for (const value of [undefined, "false", "", "TRUE", true, null, "other"]) {
      if (value === undefined) delete config.vars.INVITE_ONLY;
      else config.vars.INVITE_ONLY = value;
      await writeFile(path, JSON.stringify(config));
      const report = await validate({ environment: "production", purpose: "deploy", configPath: path, env: {} });
      assert.ok(report.missing.includes("PUBLIC_REGISTRATION_ROLLOUT_UNVERIFIED"), String(value));
    }
    config.vars.INVITE_ONLY = "true";
    await writeFile(path, JSON.stringify(config));
    assert.ok(!(await validate({ environment: "production", purpose: "deploy", configPath: path, env: {} })).missing.includes("PUBLIC_REGISTRATION_ROLLOUT_UNVERIFIED"));
    assert.ok(!(await validate({ environment: "staging", purpose: "deploy", configPath: path, env: {} })).missing.includes("PUBLIC_REGISTRATION_ROLLOUT_UNVERIFIED"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the posting reader cannot be enabled in production configuration, and can in staging", async () => {
  const dir = await mkdtemp(join(tmpdir(), "posting-reader-config-"));
  try {
    const path = join(dir, "wrangler.jsonc");
    const report = async (environment, vars, staging = {}) => {
      await writeFile(path, JSON.stringify({ name: "example", vars, env: { staging: { vars: staging } } }));
      return (await validate({ environment, purpose: "deploy", configPath: path, env: {} })).missing;
    };
    assert.ok((await report("production", { POSTING_READER_ENABLED: "true" })).includes("POSTING_READER_ROLLOUT_UNVERIFIED"));
    for (const off of [{}, { POSTING_READER_ENABLED: "false" }, { POSTING_READER_ENABLED: "" }])
      assert.ok(!(await report("production", off)).includes("POSTING_READER_ROLLOUT_UNVERIFIED"), JSON.stringify(off));
    // Staging is where it is exercised before the guard is lifted.
    assert.ok(!(await report("staging", {}, { POSTING_READER_ENABLED: "true" })).includes("POSTING_READER_ROLLOUT_UNVERIFIED"));
    // The same for dividing lines in shadow: staging only, until it has been measured.
    assert.ok((await report("production", { SPLIT_SHADOW_ENABLED: "true" })).includes("SPLIT_SHADOW_ROLLOUT_UNVERIFIED"));
    for (const off of [{}, { SPLIT_SHADOW_ENABLED: "false" }, { SPLIT_SHADOW_ENABLED: "" }])
      assert.ok(!(await report("production", off)).includes("SPLIT_SHADOW_ROLLOUT_UNVERIFIED"), JSON.stringify(off));
    assert.ok(!(await report("staging", {}, { SPLIT_SHADOW_ENABLED: "true" })).includes("SPLIT_SHADOW_ROLLOUT_UNVERIFIED"));
    assert.ok((await report("production", { MATCH_SHADOW_ENABLED: "true" })).includes("MATCH_SHADOW_ROLLOUT_UNVERIFIED"));
    for (const off of [{}, { MATCH_SHADOW_ENABLED: "false" }, { MATCH_SHADOW_ENABLED: "" }])
      assert.ok(!(await report("production", off)).includes("MATCH_SHADOW_ROLLOUT_UNVERIFIED"), JSON.stringify(off));
    assert.ok(!(await report("staging", {}, { MATCH_SHADOW_ENABLED: "true" })).includes("MATCH_SHADOW_ROLLOUT_UNVERIFIED"));
    assert.ok((await report("production", { OFFER_SHADOW_ENABLED: "true" })).includes("OFFER_SHADOW_ROLLOUT_UNVERIFIED"));
    for (const off of [{}, { OFFER_SHADOW_ENABLED: "false" }, { OFFER_SHADOW_ENABLED: "" }])
      assert.ok(!(await report("production", off)).includes("OFFER_SHADOW_ROLLOUT_UNVERIFIED"), JSON.stringify(off));
    assert.ok(!(await report("staging", {}, { OFFER_SHADOW_ENABLED: "true" })).includes("OFFER_SHADOW_ROLLOUT_UNVERIFIED"));
    // And for tagging in shadow, which also sends each line's words to the taxonomy's database.
    assert.ok((await report("production", { TAG_SHADOW_ENABLED: "true" })).includes("TAG_SHADOW_ROLLOUT_UNVERIFIED"));
    for (const off of [{}, { TAG_SHADOW_ENABLED: "false" }, { TAG_SHADOW_ENABLED: "" }])
      assert.ok(!(await report("production", off)).includes("TAG_SHADOW_ROLLOUT_UNVERIFIED"), JSON.stringify(off));
    assert.ok(!(await report("staging", {}, { TAG_SHADOW_ENABLED: "true" })).includes("TAG_SHADOW_ROLLOUT_UNVERIFIED"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the card preview cannot be enabled in production configuration, and can in staging", async () => {
  const dir = await mkdtemp(join(tmpdir(), "card-preview-config-"));
  try {
    const path = join(dir, "wrangler.jsonc");
    const report = async (environment, vars, staging = {}) => {
      await writeFile(path, JSON.stringify({ name: "example", vars, env: { staging: { vars: staging } } }));
      return (await validate({ environment, purpose: "deploy", configPath: path, env: {} })).missing;
    };
    assert.ok((await report("production", { CARD_PREVIEW_ENABLED: "true" })).includes("CARD_PREVIEW_ROLLOUT_UNVERIFIED"));
    for (const off of [{}, { CARD_PREVIEW_ENABLED: "false" }, { CARD_PREVIEW_ENABLED: "" }])
      assert.ok(!(await report("production", off)).includes("CARD_PREVIEW_ROLLOUT_UNVERIFIED"), JSON.stringify(off));
    // Staging may switch it on, where a taxonomy is bound; whether to is the owner's decision.
    assert.ok(!(await report("staging", {}, { CARD_PREVIEW_ENABLED: "true" })).includes("CARD_PREVIEW_ROLLOUT_UNVERIFIED"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("experimental cache-write fencing cannot be enabled in production configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cache-fence-config-"));
  try {
    const path = join(dir, "wrangler.jsonc");
    await writeFile(path, JSON.stringify({ name: "example", vars: { R2_CACHE_FENCE_ENABLED: "true" }, env: { staging: { vars: {} } } }));
    assert.ok((await validate({ environment: "production", purpose: "deploy", configPath: path, env: {} })).missing.includes("R2_CACHE_FENCE_ROLLOUT_UNVERIFIED"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("experimental placement fencing cannot be enabled in production configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "placement-fence-config-"));
  try {
    const path = join(dir, "wrangler.jsonc");
    await writeFile(path, JSON.stringify({ name: "example", vars: { PLACEMENT_FENCE_ENABLED: "true" }, env: { staging: { vars: {} } } }));
    assert.ok((await validate({ environment: "production", purpose: "deploy", configPath: path, env: {} })).missing.includes("PLACEMENT_FENCE_ROLLOUT_UNVERIFIED"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("production preflight blocks new sharded placement until deletion races are resolved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "placement-rollout-config-"));
  try {
    const path = join(dir, "wrangler.jsonc");
    const config = { name: "example", vars: {}, env: { staging: { vars: { DIRECTORY_SHARDS: "16" } } } };
    for (const value of ["16", "unexpected", 16, null]) {
      config.vars.DIRECTORY_SHARDS = value;
      await writeFile(path, JSON.stringify(config));
      const report = await validate({ environment: "production", purpose: "deploy", configPath: path, env: {} });
      assert.ok(report.missing.includes("DIRECTORY_SHARD_ROLLOUT_UNVERIFIED"));
    }
    for (const value of ["", "0", "1"]) {
      config.vars.DIRECTORY_SHARDS = value;
      await writeFile(path, JSON.stringify(config));
      const report = await validate({ environment: "production", purpose: "deploy", configPath: path, env: {} });
      assert.ok(!report.missing.includes("DIRECTORY_SHARD_ROLLOUT_UNVERIFIED"));
    }
    delete config.vars.DIRECTORY_SHARDS;
    await writeFile(path, JSON.stringify(config));
    const defaultProduction = await validate({ environment: "production", purpose: "deploy", configPath: path, env: {} });
    assert.ok(!defaultProduction.missing.includes("DIRECTORY_SHARD_ROLLOUT_UNVERIFIED"));
    const staging = await validate({ environment: "staging", purpose: "deploy", configPath: path, env: {} });
    assert.ok(!staging.missing.includes("DIRECTORY_SHARD_ROLLOUT_UNVERIFIED"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unknown-end behavior changes evaluation hash and production activation stays blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "role-date-config-"));
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    for (const name of ["src", "test", "scripts"]) await cp(join(root, name), join(dir, name), { recursive: true });
    await copyFile(join(root, "package.json"), join(dir, "package.json"));
    await copyFile(join(root, "package-lock.json"), join(dir, "package-lock.json"));
    await copyFile(join(root, "vitest.config.ts"), join(dir, "vitest.config.ts"));
    const configPath = join(dir, "wrangler.jsonc");
    const config = { name: "example", vars: {}, env: { staging: { vars: {} } } };
    await writeFile(configPath, JSON.stringify(config));
    const disabled = extractionConfiguration(["llm:default"], "production", { root: dir, priceOverrides: {} });
    config.vars.ROLE_UNKNOWN_END_ENABLED = "true";
    await writeFile(configPath, JSON.stringify(config));
    const enabled = extractionConfiguration(["llm:default"], "production", { root: dir, priceOverrides: {} });
    assert.equal(disabled.behavior.roleUnknownEnd, false);
    assert.equal(enabled.behavior.roleUnknownEnd, true);
    assert.notEqual(disabled.hash, enabled.hash);
    assert.ok((await validate({ environment: "production", purpose: "deploy", configPath, env: {} })).missing.includes("ROLE_UNKNOWN_END_ROLLOUT_UNVERIFIED"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("extraction promotion fingerprint changes when evaluated dependency versions change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extract-config-dependencies-"));
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    for (const name of ["src", "test", "scripts"]) await cp(join(root, name), join(dir, name), { recursive: true });
    for (const name of ["wrangler.jsonc", "package.json", "package-lock.json", "vitest.config.ts"])
      await copyFile(join(root, name), join(dir, name));
    const fingerprint = () => extractionConfiguration(["llm:default"], "staging", { root: dir, priceOverrides: {} }).hash;
    const initial = fingerprint();
    // These bundled synthetic documents are not the private holdout; private
    // dataset bytes have their own manifest and tamper checks.
    await writeFile(join(dir, "test", "extract-evals", "fixtures", "synthetic-01.pdf"), "changed synthetic fixture");
    assert.equal(fingerprint(), initial);
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    manifest.dependencies.zod = "0.0.0-test";
    await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
    const changedManifest = fingerprint();
    assert.notEqual(changedManifest, initial);
    await copyFile(join(root, "package.json"), join(dir, "package.json"));
    assert.equal(fingerprint(), initial);
    const lock = JSON.parse(await readFile(join(dir, "package-lock.json"), "utf8"));
    lock.packages["node_modules/zod"].version = "0.0.0-test";
    await writeFile(join(dir, "package-lock.json"), JSON.stringify(lock));
    assert.notEqual(fingerprint(), initial);
    await copyFile(join(root, "package-lock.json"), join(dir, "package-lock.json"));
    assert.equal(fingerprint(), initial);
    const newModule = join(dir, "scripts", "new-evaluation-module.mjs");
    await writeFile(newModule, "export const changed = true;\n");
    assert.notEqual(fingerprint(), initial);
    await rm(newModule);
    assert.equal(fingerprint(), initial);
    // Links inside a code tree cannot silently redirect the evidence to an
    // untracked file; reject them even when their target looks harmless.
    await symlink(join(dir, "package.json"), newModule);
    assert.throws(fingerprint, /extract_eval_source_invalid/);
    await rm(newModule);
    await rm(join(dir, "src"), { recursive: true });
    await symlink(join(root, "src"), join(dir, "src"), "dir");
    assert.throws(fingerprint, /extract_eval_source_invalid/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("release route inventory includes default, format routes and active experiment", () => {
  const { fallback, selected } = configuredExtractors({
    EXTRACTOR: "llm:default",
    EXTRACTOR_BY_FORMAT: JSON.stringify({ pdf: "clairic", docx: "llm:default" }),
    EXTRACTOR_EXPERIMENT: JSON.stringify({ strategy: "segment:@cf/openai/gpt-oss-20b", percent: 1 }),
  });
  assert.equal(fallback, "llm:default");
  assert.deepEqual([...selected].sort(), ["llm:default", "clairic", "segment:@cf/openai/gpt-oss-20b"].sort());
  assert.deepEqual([...configuredExtractors({ EXTRACTOR_EXPERIMENT: JSON.stringify({ strategy: "clairic", percent: 0 }) }).selected], ["llm:default"]);
  for (const invalid of [
    { EXTRACTOR_BY_FORMAT: '{"other":"clairic"}' },
    { EXTRACTOR_BY_FORMAT: '[]' },
    { EXTRACTOR_EXPERIMENT: '{"strategy":"clairic","percent":"1"}' },
    { EXTRACTOR_EXPERIMENT: '{"strategy":"clairic","percent":101}' },
    { EXTRACTOR_EXPERIMENT: '{"strategy":"not-a-real-extractor","percent":0}' },
    { EXTRACTOR_BY_FORMAT: '{"pdf":"judge:judge:clairic"}' },
    { EXTRACTOR: "not-a-real-extractor" },
  ]) assert.throws(() => configuredExtractors(invalid));
});

test("JSONC preserves URLs, comment characters and escaped strings", () => {
  assert.deepEqual(
    parseJsonc(
      '{"url":"https://host/path//text",/* comment */"quote":"\\\"/*x*/", "values":[1,2, /* trailing */],}',
    ),
    { url: "https://host/path//text", quote: '"/*x*/', values: [1, 2] },
  );
  assert.throws(() => parseJsonc("{/* unterminated"));
});
test("production selects top-level configuration and staging its own bindings", async () => {
  assert.equal((await readConfig("production")).name, "resumatic");
  assert.equal((await readConfig("staging")).name, "resumatic-staging");
  await assert.rejects(() => readConfig("prod"));
});
test("default model routes use Cloudflare catalog IDs in both environments", async () => {
  for (const environment of ["production", "staging"]) {
    const { config } = await readConfig(environment);
    assert.equal(config.vars.MODEL_EXTRACT, environment === "staging" ? "meta/muse-ember-1.0" : "anthropic/claude-haiku-5.5");
    assert.equal(config.vars.MODEL_ANALYZE, environment === "staging" ? "meta/muse-ember-1.0" : "anthropic/claude-haiku-5.5");
    assert.equal(config.vars.MODEL_WRITE, environment === "staging" ? "meta/muse-ember-1.0" : "anthropic/claude-sonnet-5.5");
    assert.equal(config.vars.MODEL_JUDGE, environment === "staging" ? "@cf/cloudflare/clef" : "openai/gpt-5");
  }
});
test("live checks cannot pass with credentials but no spend budget", () => {
  const env = {
    CF_ACCOUNT_ID: "account",
    CF_AI_TOKEN: "secret",
    AI_GATEWAY_ID: "gateway",
  };
  assert.deepEqual(livePrerequisites(env), [
    "EVAL_BUDGET_USD",
    "EVAL_MAX_CALLS",
  ]);
  assert.deepEqual(
    livePrerequisites({ ...env, EVAL_BUDGET_USD: "1", EVAL_MAX_CALLS: "10" }),
    [],
  );
  assert.ok(
    livePrerequisites({
      ...env,
      EVAL_BUDGET_USD: "Infinity",
      EVAL_MAX_CALLS: "1.5",
    }).length,
  );
});
test("live evaluation preflight needs model credentials and budget, not deploy credentials", async () => {
  const env = {
    CF_ACCOUNT_ID: "account",
    CF_AI_TOKEN: "token",
    AI_GATEWAY_ID: "gateway",
    EVAL_BUDGET_USD: "1",
    EVAL_MAX_CALLS: "10",
  };
  const result = await validate({ purpose: "eval", env });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.missing, []);
});

test("operations URLs must be HTTPS origins without credentials or URL tokens", () => {
  assert.equal(
    httpsOrigin("https://app.example.com/"),
    "https://app.example.com",
  );
  for (const url of [
    "http://app.example.com",
    "https://user:secret@app.example.com",
    "https://app.example.com?token=secret",
    "https://app.example.com/path",
  ])
    assert.equal(httpsOrigin(url), null);
});

test("deploy and staging lifecycle stay pending until the Worker spend cap is positive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resumatic-config-"));
  const configPath = join(directory, "wrangler.jsonc");
  const config = {
    name: "test",
    vars: { DAILY_SPEND_CAP_USD: "0" },
    env: {
      staging: {
        name: "test-staging",
        vars: { DAILY_SPEND_CAP_USD: "0", ALLOW_TEST_SIGNIN: "true" },
      },
    },
  };
  const env = {
    STAGING_URL: "https://staging.example.test",
    TEST_SIGNIN_KEY: "test",
    EVAL_BUDGET_USD: "1",
    EVAL_MAX_CALLS: "10",
  };
  try {
    await writeFile(configPath, JSON.stringify(config));
    assert.ok(
      (
        await validate({
          purpose: "deploy",
          environment: "production",
          env,
          configPath,
        })
      ).missing.includes("vars.DAILY_SPEND_CAP_USD"),
    );
    assert.equal(
      (await validate({ purpose: "e2e", env, configPath })).status,
      "pending",
    );
    config.env.staging.vars.DAILY_SPEND_CAP_USD = "2";
    await writeFile(configPath, JSON.stringify(config));
    assert.equal(
      (await validate({ purpose: "e2e", env, configPath })).status,
      "ready",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("staging MCP preflight accepts the inherited root compatibility flag", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resumatic-mcp-config-"));
  const configPath = join(directory, "wrangler.jsonc");
  const vars = {
    CF_ACCOUNT_ID: "account",
    OIDC_CLIENT_ID: "client",
    ACCESS_TEAM_DOMAIN: "https://access.example.test",
    ACCESS_AUD: "aud",
    AI_GATEWAY_ID: "gateway",
    DAILY_SPEND_CAP_USD: "1",
    MCP_ENABLED: "true",
    APP_ORIGIN: "https://app.example.test",
  };
  const config = {
    compatibility_flags: ["global_fetch_strictly_public"],
    env: {
      staging: {
        vars,
        r2_buckets: [{ binding: "FILES" }],
        workflows: ["DISTILL", "TAILOR", "DOCUMENTS", "REEMBED"].map(
          (binding) => ({ binding }),
        ),
        kv_namespaces: [{ binding: "OAUTH_KV", id: "a".repeat(32) }],
      },
    },
  };
  try {
    await writeFile(configPath, JSON.stringify(config));
    const result = await validate({
      purpose: "deploy",
      env: { CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ACCOUNT_ID: "account" },
      configPath,
    });
    assert.equal(result.status, "ready");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("test-signin-only preflight waives Google only for explicitly enabled staging", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resumatic-test-signin-config-"));
  const configPath = join(directory, "wrangler.jsonc");
  const vars = {
    CF_ACCOUNT_ID: "account",
    ACCESS_TEAM_DOMAIN: "https://access.example.test",
    ACCESS_AUD: "aud",
    AI_GATEWAY_ID: "gateway",
    DAILY_SPEND_CAP_USD: "1",
    ALLOW_TEST_SIGNIN: "true",
  };
  const bindings = {
    r2_buckets: [{ binding: "FILES" }],
    workflows: ["DISTILL", "TAILOR", "DOCUMENTS", "REEMBED"].map((binding) => ({ binding })),
  };
  const config = { vars: { ...vars, ALLOW_TEST_SIGNIN: "false" }, ...bindings, env: { staging: { vars, ...bindings } } };
  const env = { CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ACCOUNT_ID: "account" };
  const check = (options = {}) => validate({ purpose: "deploy", env, configPath, ...options });
  try {
    await writeFile(configPath, JSON.stringify(config));
    assert.ok((await check()).missing.includes("vars.OIDC_CLIENT_ID"));
    assert.equal((await check({ testSigninOnly: true })).status, "ready");
    const production = await check({ environment: "production", testSigninOnly: true });
    assert.ok(production.missing.includes("TEST_SIGNIN_ONLY_STAGING_DEPLOY_REQUIRED"));
    assert.ok(production.missing.includes("vars.OIDC_CLIENT_ID"));

    config.env.staging.vars.ALLOW_TEST_SIGNIN = "false";
    config.env.staging.vars.ACCESS_TEAM_DOMAIN = "";
    config.env.staging.vars.ACCESS_AUD = "";
    config.env.staging.vars.DAILY_SPEND_CAP_USD = "0";
    await writeFile(configPath, JSON.stringify(config));
    const missing = (await check({ testSigninOnly: true })).missing;
    for (const name of ["vars.ALLOW_TEST_SIGNIN", "vars.ACCESS_TEAM_DOMAIN", "vars.ACCESS_AUD", "vars.DAILY_SPEND_CAP_USD"])
      assert.ok(missing.includes(name), name);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("smoke-only preflight requires a staging-only non-model configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resumatic-smoke-config-"));
  const configPath = join(directory, "wrangler.jsonc");
  const vars = {
    CF_ACCOUNT_ID: "account", AI_GATEWAY_ID: "gateway", OIDC_CLIENT_ID: "",
    ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", ALLOW_TEST_SIGNIN: "true",
    PILOT_SHARED_BUDGET: "true", DAILY_SPEND_CAP_USD: "0", INVITE_ONLY: "true",
    BILLING_ENABLED: "false", MCP_ENABLED: "false",
  };
  const bindings = {
    r2_buckets: [{ binding: "FILES" }],
    workflows: ["DISTILL", "TAILOR", "DOCUMENTS", "REEMBED"].map((binding) => ({ binding })),
    durable_objects: { bindings: [{ name: "PILOT_BUDGET", class_name: "PilotBudget" }] },
  };
  const config = { vars: { ...vars }, ...bindings, env: { staging: { vars, ...bindings } } };
  const env = { CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ACCOUNT_ID: "account" };
  const check = (options = {}) => validate({ purpose: "deploy", env, configPath, ...options });
  try {
    await writeFile(configPath, JSON.stringify(config));
    assert.equal((await check({ smokeOnly: true })).status, "ready");
    assert.ok((await check({ smokeOnly: true, smokeGoogle: true })).missing.includes("SMOKE_GOOGLE_REQUIRES_OIDC_CLIENT_ID"));
    vars.OIDC_CLIENT_ID = "google-client";
    await writeFile(configPath, JSON.stringify(config));
    assert.ok((await check({ smokeOnly: true })).missing.includes("SMOKE_REQUIRES_EMPTY_OIDC_CLIENT_ID"));
    assert.equal((await check({ smokeOnly: true, smokeGoogle: true })).status, "ready");
    assert.ok((await check({ smokeGoogle: true })).missing.includes("SMOKE_GOOGLE_REQUIRES_STAGING_SMOKE_DEPLOY"));
    assert.ok((await check({ environment: "production", smokeOnly: true, smokeGoogle: true })).missing.includes("SMOKE_GOOGLE_REQUIRES_STAGING_SMOKE_DEPLOY"));
    assert.ok((await check({ purpose: "e2e", smokeOnly: true, smokeGoogle: true })).missing.includes("SMOKE_GOOGLE_REQUIRES_STAGING_SMOKE_DEPLOY"));
    vars.OIDC_CLIENT_ID = " ";
    await writeFile(configPath, JSON.stringify(config));
    assert.ok((await check({ smokeOnly: true, smokeGoogle: true })).missing.includes("SMOKE_GOOGLE_REQUIRES_OIDC_CLIENT_ID"));
    vars.OIDC_CLIENT_ID = "";
    vars.ACCESS_TEAM_DOMAIN = "https://team.cloudflareaccess.com";
    vars.ACCESS_AUD = "example-audience";
    await writeFile(configPath, JSON.stringify(config));
    assert.equal((await check({ smokeOnly: true })).status, "ready");
    for (const [team, audience] of [
      ["https://team.cloudflareaccess.com", ""],
      ["", "example-audience"],
      ["http://team.cloudflareaccess.com", "example-audience"],
      ["https://team.cloudflareaccess.com/path", "example-audience"],
      ["https://team.cloudflareaccess.com", "   "],
      ["https://team.cloudflareaccess.com", " example-audience"],
      [null, "example-audience"],
    ]) {
      vars.ACCESS_TEAM_DOMAIN = team;
      vars.ACCESS_AUD = audience;
      await writeFile(configPath, JSON.stringify(config));
      assert.ok((await check({ smokeOnly: true })).missing.includes("SMOKE_REQUIRES_VALID_ACCESS_CONFIGURATION"));
    }
    vars.ACCESS_TEAM_DOMAIN = "";
    vars.ACCESS_AUD = "";
    await writeFile(configPath, JSON.stringify(config));
    assert.equal((await check()).status, "pending");
    const production = await check({ environment: "production", smokeOnly: true });
    assert.ok(production.missing.includes("SMOKE_ONLY_STAGING_DEPLOY_REQUIRED"));
    assert.ok(production.missing.includes("vars.OIDC_CLIENT_ID"));
    assert.ok((await check({ purpose: "e2e", smokeOnly: true })).missing.includes("SMOKE_ONLY_STAGING_DEPLOY_REQUIRED"));
    for (const [name, bad] of Object.entries({
      OIDC_CLIENT_ID: "client", ACCESS_TEAM_DOMAIN: "https://access.example.test", ACCESS_AUD: "aud",
      ALLOW_TEST_SIGNIN: "false", PILOT_SHARED_BUDGET: "false", DAILY_SPEND_CAP_USD: "1",
      INVITE_ONLY: "false", BILLING_ENABLED: "true", MCP_ENABLED: "true",
    })) {
      const old = vars[name];
      vars[name] = bad;
      await writeFile(configPath, JSON.stringify(config));
      assert.equal((await check({ smokeOnly: true })).status, "pending", name);
      vars[name] = old;
    }
    bindings.durable_objects.bindings = [];
    await writeFile(configPath, JSON.stringify(config));
    assert.ok((await check({ smokeOnly: true })).missing.includes("SMOKE_REQUIRES_PILOT_BUDGET_BINDING"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release gates require passing evidence for the exact candidate commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resumatic-release-"));
  const commit = "a".repeat(40);
  const evidence = Object.fromEntries(
    [
      "models",
      "googleSignin",
      "extraction",
      "grounding",
      "ats",
      "stagingE2e",
      "billing",
      "security",
      "deletion",
      "latency",
      "betaOperations",
    ].map((name) => [
      name,
      {
        status: "passed",
        commit,
        reportUrl: `https://reports.example.test/${name}`,
      },
    ]),
  );
  const { config: production } = await readConfig("production", fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)));
  Object.assign(evidence.models, {
    writerModel: production.vars.MODEL_WRITE,
    judgeModel: production.vars.MODEL_JUDGE,
    writerFamily: "writer-family",
    judgeFamily: "judge-family",
  });
  Object.assign(evidence.extraction, {
    trapLeaks: 0,
    unsupportedClaims: 0,
    failureRate: 0,
    evaluatedUploads: 15,
    factRecall: 0.85,
    factPrecision: 0.95,
    promotion: {
      version: 1,
      mode: "human-audited",
      profile: "full",
      runId: "12345678-1234-4234-8234-123456789abc",
      environment: "production",
      strategies: ["llm:default"],
      manifestHash: "a".repeat(64),
      snapshotSha256: "b".repeat(64),
      configurationHash: extractionConfiguration(["llm:default"], "production", { root: fileURLToPath(new URL("../", import.meta.url)), priceOverrides: {} }).hash,
      winner: "llm:default",
      rankingPending: false,
      results: [{
        strategy: "llm:default",
        status: "eligible",
        pending: [],
        failed: [],
        sampleSeed: "d".repeat(64),
        sampleKeys: Array.from({ length: 50 }, (_, i) => i.toString(16).padStart(64, "0")),
        metrics: {
          cases: 15, runs: 15, failures: 0, failureRate: 0,
          recall: 0.85, precision: 0.95, trapLeaks: 0,
          reviewedFacts: 50, disagreements: 0, reviewCost: 1, meanCostUsd: 0.01, p95Ms: 1000, levelInflation: 0, levelUnverified: 0, levelReviewed: 0,
        },
      }],
    },
  });
  const seededConfig = extractionConfiguration(["llm:default"], "production", { root: fileURLToPath(new URL("../", import.meta.url)), priceOverrides: {} });
  Object.assign(evidence.grounding, {
    unsupportedClaims: 0,
    evaluatedLines: 100,
    seeded: {
      mode: "live", commit, environment: "production", seedVersion: SEED_VERSION,
      sourceConfigurationHash: seededConfig.hash, configurationHash: "c".repeat(64), datasetHash: "d".repeat(64),
      models: seededConfig.models,
      baseline: { cases: 3, inputLines: 9, outputLines: 7, deterministicViolations: 0 },
      seeds: SEED_KINDS.map((kind) => ({ kind, planted: 2, caught: 1, uncertain: 0, catchRate: 0.5, skipped: 1, failed: 0, notRun: 0 })),
    },
  });
  Object.assign(evidence.ats, {
    syntheticPdfPassed: true,
    syntheticDocxPassed: true,
    externalParsersTested: 2,
    unresolvedFailures: 0,
  });
  Object.assign(evidence.latency, { p95Seconds: 70, sampleSize: 100 });
  Object.assign(evidence.security, { openHighFindings: 0, openCriticalFindings: 0 });
  Object.assign(evidence.billing, {
    testModePassed: true,
    livePaymentPassed: true,
    liveCancellationPassed: true,
  });
  Object.assign(evidence.betaOperations, {
    quietDays: 14, unexplainedAlerts: 0,
    reportedFabrications: 2, fabricationReportsWithPassingTests: 2,
    uploadCostSamples: 3, resumeCostSamples: 4,
    meanUploadCostUsd: 0.01, meanResumeCostUsd: 0.02,
    extractionArms: [
      { strategy: "llm:default", sources: 3, proposed: 12, confirmed: 9, edited: 4, windowComplete: true },
      { strategy: "clairic", sources: 2, proposed: 10, confirmed: 8, edited: 2, windowComplete: true },
    ],
  });
  const run = (input) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./check-release.mjs", import.meta.url))],
      {
        cwd: directory,
        env: {
          GITHUB_SHA: commit,
          RELEASE_EVIDENCE_JSON: JSON.stringify(input),
          DELETION_INVENTORY_COMPLETE: "true",
          MANUAL_RESUME_EDIT_GROUNDING_AVAILABLE: "true",
        },
        encoding: "utf8",
      },
    );
  const assertMissing = (input, reason) => {
    const result = run(input);
    assert.equal(result.status, 2);
    assert.ok(JSON.parse(result.stdout).missing.includes(reason));
  };
  try {
    assert.equal(run({}).status, 2);
    for (const security of [
      { ...evidence.security, openHighFindings: 1 },
      { ...evidence.security, openCriticalFindings: 1 },
      { ...evidence.security, openCriticalFindings: undefined },
      { ...evidence.security, openCriticalFindings: null },
      { ...evidence.security, openCriticalFindings: -1 },
      { ...evidence.security, openCriticalFindings: "0" },
    ]) assertMissing({ ...evidence, security }, "SECURITY_FINDINGS");
    // An operator attestation and environment flag cannot manufacture the
    // complete Workflow inventory that the deletion audit cannot yet prove.
    assert.equal(run(evidence).status, 2);
    assert.ok(!JSON.parse(run(evidence).stdout).missing.includes("SECURITY_FINDINGS"));
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "release-report.json"), "utf8")).missing,
      ["DELETION_INVENTORY_AUDIT_UNAVAILABLE", "MANUAL_RESUME_EDIT_GROUNDING_UNAVAILABLE"],
    );
    // Seeded coverage must be a complete live measurement bound to this
    // commit and configuration; a synthetic harness report cannot promote.
    const seeded = evidence.grounding.seeded;
    for (const patch of [
      { mode: "harness-self-check" }, { commit: "b".repeat(40) }, { environment: "invalid" },
      { sourceConfigurationHash: "f".repeat(64) },
      { seedVersion: SEED_VERSION + 1 }, { models: { ...seeded.models, MODEL_JUDGE: "different/model" } },
      { baseline: { ...seeded.baseline, cases: 0 } }, { baseline: { ...seeded.baseline, outputLines: 0 } },
      { baseline: { ...seeded.baseline, deterministicViolations: 1 } }, { seeds: [] },
      { seeds: [...seeded.seeds.slice(0, -1), seeded.seeds[0]] },
      { seeds: [{ ...seeded.seeds[0], planted: 0 }, ...seeded.seeds.slice(1)] },
      { seeds: [{ ...seeded.seeds[0], caught: 3 }, ...seeded.seeds.slice(1)] },
      { seeds: [{ ...seeded.seeds[0], uncertain: 2 }, ...seeded.seeds.slice(1)] },
      { seeds: [{ ...seeded.seeds[0], catchRate: 1 }, ...seeded.seeds.slice(1)] },
      { seeds: [{ ...seeded.seeds[0], failed: 1 }, ...seeded.seeds.slice(1)] },
      { seeds: [{ ...seeded.seeds[0], notRun: 1 }, ...seeded.seeds.slice(1)] },
      { seeds: [{ ...seeded.seeds[0], skipped: 0 }, ...seeded.seeds.slice(1)] },
    ]) assertMissing({ ...evidence, grounding: { ...evidence.grounding, seeded: { ...seeded, ...patch } } }, "SEEDED_FABRICATION_MEASUREMENTS");
    assertMissing({ ...evidence, grounding: { ...evidence.grounding, seeded: undefined } }, "SEEDED_FABRICATION_MEASUREMENTS");
    for (const [patch, reason] of [
      [{ unexplainedAlerts: 1 }, "BETA_UNEXPLAINED_ALERTS"],
      [{ unexplainedAlerts: "0" }, "BETA_UNEXPLAINED_ALERTS"],
      [{ reportedFabrications: 3 }, "BETA_FABRICATION_REGRESSIONS"],
      [{ fabricationReportsWithPassingTests: undefined }, "BETA_FABRICATION_REGRESSIONS"],
      [{ reportedFabrications: -1 }, "BETA_FABRICATION_REGRESSIONS"],
      [{ uploadCostSamples: 0 }, "BETA_COST_MEASUREMENTS"],
      [{ resumeCostSamples: 1.5 }, "BETA_COST_MEASUREMENTS"],
      [{ meanUploadCostUsd: -0.01 }, "BETA_COST_MEASUREMENTS"],
      [{ meanResumeCostUsd: "0.02" }, "BETA_COST_MEASUREMENTS"],
      [{ extractionArms: [] }, "BETA_EXTRACTION_FEEDBACK"],
      [{ extractionArms: [evidence.betaOperations.extractionArms[0]] }, "BETA_EXTRACTION_FEEDBACK"],
      [{ extractionArms: [evidence.betaOperations.extractionArms[0], evidence.betaOperations.extractionArms[0]] }, "BETA_EXTRACTION_FEEDBACK"],
      [{ extractionArms: [{ ...evidence.betaOperations.extractionArms[0], strategy: "other" }, evidence.betaOperations.extractionArms[1]] }, "BETA_EXTRACTION_FEEDBACK"],
      [{ extractionArms: [evidence.betaOperations.extractionArms[0], { ...evidence.betaOperations.extractionArms[1], strategy: "not-an-extractor" }] }, "BETA_EXTRACTION_FEEDBACK"],
      [{ extractionArms: [{ ...evidence.betaOperations.extractionArms[0], proposed: 0 }, evidence.betaOperations.extractionArms[1]] }, "BETA_EXTRACTION_FEEDBACK"],
      [{ extractionArms: [{ ...evidence.betaOperations.extractionArms[0], edited: 13 }, evidence.betaOperations.extractionArms[1]] }, "BETA_EXTRACTION_FEEDBACK"],
      [{ extractionArms: [{ ...evidence.betaOperations.extractionArms[0], confirmed: "9" }, evidence.betaOperations.extractionArms[1]] }, "BETA_EXTRACTION_FEEDBACK"],
      [{ extractionArms: [{ ...evidence.betaOperations.extractionArms[0], windowComplete: false }, evidence.betaOperations.extractionArms[1]] }, "BETA_EXTRACTION_FEEDBACK"],
    ]) assertMissing({ ...evidence, betaOperations: { ...evidence.betaOperations, ...patch } }, reason);
    // Decisions overlap: an edited fact may also have been confirmed.
    const overlapping = { ...evidence, betaOperations: { ...evidence.betaOperations, extractionArms: [
      { ...evidence.betaOperations.extractionArms[0], confirmed: 12, edited: 12 }, evidence.betaOperations.extractionArms[1],
    ] } };
    assert.equal(JSON.parse(run(overlapping).stdout).missing.includes("BETA_EXTRACTION_FEEDBACK"), false);
    // Zero reported fabrications and zero measured costs are valid when attested.
    const zero = { ...evidence, betaOperations: { ...evidence.betaOperations, reportedFabrications: 0,
      fabricationReportsWithPassingTests: 0, meanUploadCostUsd: 0, meanResumeCostUsd: 0 } };
    const zeroMissing = JSON.parse(run(zero).stdout).missing;
    assert.equal(zeroMissing.includes("BETA_FABRICATION_REGRESSIONS"), false);
    assert.equal(zeroMissing.includes("BETA_COST_MEASUREMENTS"), false);
    for (const field of ["testModePassed", "livePaymentPassed", "liveCancellationPassed"]) {
      for (const value of [false, undefined, "true"]) {
        assert.equal(run({ ...evidence, billing: { ...evidence.billing, [field]: value } }).status, 2);
        const result = JSON.parse(await readFile(join(directory, "release-report.json"), "utf8"));
        assert.ok(result.missing.includes("BILLING_VALIDATION"));
      }
    }
    assertMissing({ ...evidence, models: { ...evidence.models, status: "pending" } }, "models");
    for (const models of [
      { ...evidence.models, writerModel: "other/model" },
      { ...evidence.models, judgeModel: evidence.models.writerModel },
      { ...evidence.models, writerFamily: "same", judgeFamily: "same" },
      { ...evidence.models, writerFamily: "" },
      { ...evidence.models, judgeFamily: undefined },
      { ...evidence.models, judgeFamily: "unreviewed family" },
    ]) assertMissing({ ...evidence, models }, "MODEL_INDEPENDENCE");
    assertMissing({
        ...evidence,
        models: { ...evidence.models, commit: "b".repeat(40) },
      }, "models");
    assertMissing({
        ...evidence,
        extraction: { ...evidence.extraction, failureRate: 0.01 },
      }, "EXTRACTION_MEASUREMENTS");
    for (const ats of [
      { ...evidence.ats, syntheticPdfPassed: false },
      { ...evidence.ats, syntheticDocxPassed: false },
      { ...evidence.ats, externalParsersTested: 1 },
      { ...evidence.ats, externalParsersTested: 2.5 },
      { ...evidence.ats, unresolvedFailures: 1 },
    ]) {
      assert.equal(run({ ...evidence, ats }).status, 2);
      const result = JSON.parse(
        await readFile(join(directory, "release-report.json"), "utf8"),
      );
      assert.ok(result.missing.includes("ATS_VALIDATION"));
    }
    for (const extraction of [
      { ...evidence.extraction, factRecall: 0.849 },
      { ...evidence.extraction, factPrecision: 0.949 },
      { ...evidence.extraction, factRecall: 1.01 },
      { ...evidence.extraction, factPrecision: null },
      { ...evidence.extraction, factRecall: undefined },
    ]) {
      assert.equal(run({ ...evidence, extraction }).status, 2);
      const result = JSON.parse(
        await readFile(join(directory, "release-report.json"), "utf8"),
      );
      assert.ok(result.missing.includes("EXTRACTION_QUALITY"));
    }
    const promotion = evidence.extraction.promotion;
    const winner = promotion.results[0];
    for (const invalid of [
      undefined,
      { ...promotion, profile: "round-1" },
      { ...promotion, environment: "unknown" },
      { ...promotion, strategies: ["clairic"] },
      { ...promotion, mode: "offline" },
      { ...promotion, winner: null },
      { ...promotion, rankingPending: true },
      { ...promotion, configurationHash: "" },
      { ...promotion, results: [{ ...winner, status: "pending" }] },
      { ...promotion, results: [{ ...winner, pending: ["human_audit_missing"] }] },
      { ...promotion, results: [{ ...winner, sampleKeys: winner.sampleKeys.slice(0, 49) }] },
      { ...promotion, results: [{ ...winner, sampleKeys: Array(50).fill(winner.sampleKeys[0]) }] },
      { ...promotion, results: [{ ...winner, metrics: { ...winner.metrics, cases: 14 } }] },
      { ...promotion, results: [{ ...winner, metrics: { ...winner.metrics, reviewedFacts: 49 } }] },
      { ...promotion, results: [{ ...winner, metrics: { ...winner.metrics, levelInflation: 1 } }] },
      { ...promotion, results: [{ ...winner, metrics: { ...winner.metrics, levelInflation: undefined } }] },
      { ...promotion, results: [{ ...winner, metrics: { ...winner.metrics, levelUnverified: 1, levelReviewed: 0 } }] },
      { ...promotion, results: [{ ...winner, metrics: { ...winner.metrics, levelUnverified: undefined } }] },
      { ...promotion, results: [{ ...winner, metrics: { ...winner.metrics, reviewCost: undefined } }] },
      { ...promotion, results: [{ ...winner, metrics: { ...winner.metrics, p95Ms: undefined } }] },
      { ...promotion, results: [{ ...winner, metrics: { ...winner.metrics, reviewCost: -1 } }] },
      { ...promotion, results: [{ ...winner, metrics: { ...winner.metrics, recall: 0.9 } }] },
      { ...promotion, results: [{ ...winner, metrics: { ...winner.metrics, failureRate: 0.001 } }] },
    ]) {
      assert.equal(run({ ...evidence, extraction: { ...evidence.extraction, promotion: invalid } }).status, 2);
      const result = JSON.parse(await readFile(join(directory, "release-report.json"), "utf8"));
      assert.ok(result.missing.includes("EXTRACTION_PROMOTION"));
    }
    const challenger = { ...winner, strategy: "clairic", metrics: { ...winner.metrics } };
    const compare = (change) => ({
      ...evidence,
      extraction: { ...evidence.extraction, promotion: {
        ...promotion, strategies: [winner.strategy, challenger.strategy],
        results: [winner, { ...challenger, ...change, metrics: { ...challenger.metrics, ...change.metrics } }],
      } },
    });
    // Eligible competitors are ranked by review cost, then cost, then p95.
    for (const metrics of [
      { reviewCost: 0.5 },
      { meanCostUsd: 0.005 },
      { p95Ms: 999 },
      { p95Ms: undefined },
      { cases: 16 },
    ]) assertMissing(compare({ metrics }), "EXTRACTION_PROMOTION");
    assertMissing(compare({ status: "eligible", pending: ["missing"] }), "EXTRACTION_PROMOTION");
    // A worse eligible challenger should not invalidate the aggregate. The
    // independent configuration binding may still reject this synthetic case.
    const lowerRank = run(compare({ metrics: { reviewCost: 2 } }));
    assert.equal(JSON.parse(lowerRank.stdout).missing.includes("EXTRACTION_PROMOTION"), false);
    for (const [candidate, reason] of [
      [{ ...evidence, extraction: { ...evidence.extraction, evaluatedUploads: 1 } }, "EXTRACTION_MEASUREMENTS"],
      [{ ...evidence, extraction: { ...evidence.extraction, evaluatedUploads: "15" } }, "EXTRACTION_MEASUREMENTS"],
      [{ ...evidence, grounding: { ...evidence.grounding, evaluatedLines: "1" } }, "GROUNDING_MEASUREMENTS"],
      [{ ...evidence, latency: { ...evidence.latency, p95Seconds: "70" } }, "LATENCY_MEASUREMENTS"],
      [{ ...evidence, latency: { ...evidence.latency, sampleSize: 1.5 } }, "LATENCY_MEASUREMENTS"],
      [{ ...evidence, betaOperations: { ...evidence.betaOperations, quietDays: "14" } }, "BETA_OBSERVATION_WINDOW"],
    ]) assertMissing(candidate, reason);
    const badConfiguration = {
      ...evidence,
      extraction: { ...evidence.extraction, promotion: { ...promotion, configurationHash: "f".repeat(64) } },
    };
    assert.equal(run(badConfiguration).status, 2);
    assert.ok(JSON.parse(await readFile(join(directory, "release-report.json"), "utf8")).missing.includes("EXTRACTION_CONFIGURATION"));
    const otherRoute = {
      ...evidence,
      extraction: { ...evidence.extraction, promotion: { ...promotion, strategies: ["clairic"], winner: "clairic", results: [{ ...winner, strategy: "clairic" }], configurationHash: extractionConfiguration(["clairic"], "staging", { root: fileURLToPath(new URL("../", import.meta.url)), priceOverrides: {} }).hash } },
    };
    assert.equal(run(otherRoute).status, 2);
    assert.ok(JSON.parse(await readFile(join(directory, "release-report.json"), "utf8")).missing.includes("EXTRACTION_CONFIGURATION"));
    assert.equal(
      JSON.parse(await readFile(join(directory, "release-report.json"), "utf8"))
        .status,
      "pending",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
