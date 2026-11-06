import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonc, httpsOrigin, readConfig } from "./lib/config.mjs";
import { livePrerequisites, validate } from "./validate-config.mjs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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

test("release gates require passing evidence for the exact candidate commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resumatic-release-"));
  const commit = "a".repeat(40);
  const evidence = Object.fromEntries(
    [
      "models",
      "googleSignin",
      "extraction",
      "grounding",
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
  Object.assign(evidence.extraction, {
    trapLeaks: 0,
    unsupportedClaims: 0,
    failureRate: 0,
    evaluatedUploads: 40,
    factRecall: 0.85,
    factPrecision: 0.95,
  });
  Object.assign(evidence.grounding, {
    unsupportedClaims: 0,
    evaluatedLines: 100,
  });
  Object.assign(evidence.latency, { p95Seconds: 70, sampleSize: 100 });
  Object.assign(evidence.security, { openHighFindings: 0 });
  Object.assign(evidence.betaOperations, { quietDays: 14 });
  const run = (input) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./check-release.mjs", import.meta.url))],
      {
        cwd: directory,
        env: {
          GITHUB_SHA: commit,
          RELEASE_EVIDENCE_JSON: JSON.stringify(input),
        },
        encoding: "utf8",
      },
    );
  try {
    assert.equal(run({}).status, 2);
    assert.equal(run(evidence).status, 0);
    assert.equal(
      run({ ...evidence, models: { ...evidence.models, status: "pending" } })
        .status,
      2,
    );
    assert.equal(
      run({
        ...evidence,
        models: { ...evidence.models, commit: "b".repeat(40) },
      }).status,
      2,
    );
    assert.equal(
      run({
        ...evidence,
        extraction: { ...evidence.extraction, failureRate: 0.01 },
      }).status,
      2,
    );
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
    assert.equal(
      JSON.parse(await readFile(join(directory, "release-report.json"), "utf8"))
        .status,
      "pending",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
