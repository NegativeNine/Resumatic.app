import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonc, httpsOrigin, readConfig } from "./lib/config.mjs";
import { livePrerequisites, validate } from "./validate-config.mjs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { extractionConfiguration } from "../test/extract-evals/configuration.mjs";
import { configuredExtractors } from "./lib/extractor-routes.mjs";
import { validEvaluationSecretNames, validProductionSecretNames } from "./lib/release-secret-names.mjs";

test("production secrets cannot shadow the evaluated extractor or model configuration", () => {
  assert.equal(validProductionSecretNames([{ name: "SESSION_KEY" }, { name: "CF_AI_TOKEN" }]), true);
  for (const name of ["TEST_SIGNIN_KEY", "MODEL_EXTRACT", "MODEL_JUDGE", "EXTRACTOR", "EXTRACTOR_BY_FORMAT", "EXTRACTOR_EXPERIMENT", "ROLE_UNKNOWN_END_ENABLED"]) {
    assert.equal(validProductionSecretNames([{ name }]), false);
    if (name !== "TEST_SIGNIN_KEY") assert.equal(validEvaluationSecretNames([{ name }]), false);
  }
  assert.equal(validEvaluationSecretNames([{ name: "TEST_SIGNIN_KEY" }]), true);
  assert.equal(validProductionSecretNames({}), false);
  assert.equal(validProductionSecretNames([{}]), false);
});

test("unknown-end behavior changes evaluation hash and production activation stays blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "role-date-config-"));
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    await symlink(join(root, "src"), join(dir, "src"), "dir");
    await symlink(join(root, "test"), join(dir, "test"), "dir");
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
    assert.equal(config.vars.MODEL_EXTRACT, "anthropic/claude-haiku-5.5");
    assert.equal(config.vars.MODEL_ANALYZE, "anthropic/claude-haiku-5.5");
    assert.equal(config.vars.MODEL_WRITE, "anthropic/claude-sonnet-5.5");
    assert.equal(config.vars.MODEL_JUDGE, "openai/gpt-5");
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
      environment: "staging",
      strategies: ["llm:default"],
      manifestHash: "a".repeat(64),
      snapshotSha256: "b".repeat(64),
      configurationHash: extractionConfiguration(["llm:default"], "staging", { root: fileURLToPath(new URL("../", import.meta.url)), priceOverrides: {} }).hash,
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
  Object.assign(evidence.grounding, {
    unsupportedClaims: 0,
    evaluatedLines: 100,
  });
  Object.assign(evidence.ats, {
    syntheticPdfPassed: true,
    syntheticDocxPassed: true,
    externalParsersTested: 2,
    unresolvedFailures: 0,
  });
  Object.assign(evidence.latency, { p95Seconds: 70, sampleSize: 100 });
  Object.assign(evidence.security, { openHighFindings: 0 });
  Object.assign(evidence.billing, {
    testModePassed: true,
    livePaymentPassed: true,
    liveCancellationPassed: true,
  });
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
          DELETION_INVENTORY_COMPLETE: "true",
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
    // An operator attestation and environment flag cannot manufacture the
    // complete Workflow inventory that the deletion audit cannot yet prove.
    assert.equal(run(evidence).status, 2);
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "release-report.json"), "utf8")).missing,
      ["DELETION_INVENTORY_AUDIT_UNAVAILABLE"],
    );
    for (const field of ["testModePassed", "livePaymentPassed", "liveCancellationPassed"]) {
      for (const value of [false, undefined, "true"]) {
        assert.equal(run({ ...evidence, billing: { ...evidence.billing, [field]: value } }).status, 2);
        const result = JSON.parse(await readFile(join(directory, "release-report.json"), "utf8"));
        assert.ok(result.missing.includes("BILLING_VALIDATION"));
      }
    }
    assertMissing({ ...evidence, models: { ...evidence.models, status: "pending" } }, "models");
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
