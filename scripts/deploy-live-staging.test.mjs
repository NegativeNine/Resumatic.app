import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deployLiveStaging, stagingOverlay, stagingCredentials } from "./deploy-live-staging.mjs";

const accountId = "a".repeat(32);
const config = () => ({ name: "resumatic-staging", targetEnvironment: "staging", vars: { CF_ACCOUNT_ID: "", OIDC_CLIENT_ID: "", DAILY_SPEND_CAP_USD: "0" },
  durable_objects: { bindings: [{ name: "VAULT", class_name: "Vault" }] }, ai: { binding: "AI" }, assets: { binding: "ASSETS", directory: "../client" },
  browser: { binding: "BROWSER" }, version_metadata: { binding: "VERSION" }, workflows: [{ binding: "TAILOR", name: "tailor-staging", class_name: "TailorWorkflow" }] });
const live = () => [
  { name: "CF_ACCOUNT_ID", type: "plain_text", text: accountId },
  { name: "OIDC_CLIENT_ID", type: "plain_text", text: "public-google-client" },
  { name: "AI_GATEWAY_ID", type: "plain_text", text: "resumatic-staging" },
  { name: "DAILY_SPEND_CAP_USD", type: "plain_text", text: "10" },
  { name: "RECORD_PROPOSAL_REVIEW_ENABLED", type: "plain_text", text: "false" },
  { name: "SESSION_KEY", type: "secret_text", text: "must-not-be-copied" },
  { name: "VAULT", type: "durable_object_namespace", class_name: "Vault", namespace_id: "original-namespace" },
  { name: "TAILOR", type: "workflow", class_name: "TailorWorkflow", workflow_name: "tailor-staging" },
  { name: "TAXONOMY", type: "d1", id: "existing-database" },
  { name: "TAXONOMY_VECTORS", type: "vectorize", index_name: "existing-index" },
  { name: "AUTH", type: "kv_namespace", namespace_id: "original-oauth-kv" },
  { name: "FILES", type: "r2_bucket", bucket_name: "original-files" },
  { name: "METRICS", type: "analytics_engine", dataset: "original-metrics" },
  { name: "WRITE_LIMIT", type: "ratelimit", namespace_id: "1102", simple: { limit: 60, period: 60 } },
  { name: "SERVICE", type: "service", service: "existing-service", environment: "production" },
  ...["AI", "ASSETS", "BROWSER", "VERSION"].map((name, i) => ({ name, type: ["ai", "assets", "browser", "version_metadata"][i] })),
];
const reply = (bindings) => new Response(JSON.stringify({ success: true, result: { bindings } }));
function harness(snapshots = [live(), live()], options = {}) {
  const calls = [], writes = [];
  let reads = 0;
  return { calls, writes, deps: {
    fetch: async () => { calls.push("fetch"); const x = snapshots[reads++]; return x instanceof Response ? x : reply(x); },
    readFile: async () => JSON.stringify(config()),
    writeFile: async (_path, text) => { writes.push(JSON.parse(text)); calls.push("write"); },
    rename: async () => { calls.push("rename"); },
    execute: async (command, args) => { calls.push(args[0] === "run" ? "build" : "deploy"); if (options.buildFails && command === "npm") throw Error("build-failed"); },
  } };
}
const options = { accountId, token: "private-token", project: "/synthetic/project" };

test("the normal staging deployment command also uses the guarded live path", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["deploy:staging"], "node scripts/deploy-live-staging.mjs");
  assert.equal(pkg.scripts["deploy:live-staging"], pkg.scripts["deploy:staging"]);
});

test("preserves real staging settings and resources instead of deploying template defaults", async () => {
  const h = harness(); const result = await deployLiveStaging(options, h.deps);
  assert.deepEqual(h.calls, ["fetch", "build", "fetch", "write", "rename", "deploy"]);
  assert.equal(result.worker, "resumatic-staging"); const out = h.writes[0];
  assert.equal(out.vars.CF_ACCOUNT_ID, accountId); assert.equal(out.vars.OIDC_CLIENT_ID, "public-google-client");
  assert.equal(out.vars.DAILY_SPEND_CAP_USD, "10"); assert.equal(out.vars.RECORD_PROPOSAL_REVIEW_ENABLED, "false");
  assert.deepEqual(out.d1_databases, [{ binding: "TAXONOMY", database_id: "existing-database" }]);
  assert.deepEqual(out.vectorize, [{ binding: "TAXONOMY_VECTORS", index_name: "existing-index" }]);
  assert.equal(out.kv_namespaces[0].id, "original-oauth-kv"); assert.equal(out.r2_buckets[0].bucket_name, "original-files");
  assert.equal(out.services[0].service, "existing-service"); assert.equal(out.ratelimits[0].namespace_id, "1102");
  assert.equal(out.analytics_engine_datasets[0].dataset, "original-metrics");
  assert.ok(!JSON.stringify(out).includes("must-not-be-copied")); assert.equal(out.vars.SESSION_KEY, undefined);
});

test("expired credentials stop before build, artifact write or deployment", async () => {
  const h = harness([new Response("private provider diagnostic", { status: 401 })]);
  await assert.rejects(deployLiveStaging(options, h.deps), /LIVE_STAGING_SETTINGS_READ_FAILED/);
  assert.deepEqual(h.calls, ["fetch"]); assert.deepEqual(h.writes, []);
});
test("a failed second settings read leaves the artifact untouched and never deploys", async () => {
  const h = harness([live(), new Response("no", { status: 503 })]);
  await assert.rejects(deployLiveStaging(options, h.deps), /LIVE_STAGING_SETTINGS_READ_FAILED/);
  assert.deepEqual(h.calls, ["fetch", "build", "fetch"]); assert.deepEqual(h.writes, []);
});
test("network and malformed API responses stop without exposing provider text", async () => {
  for (const response of [new Response("not-json"), new Response(JSON.stringify({ success: false, result: { bindings: live() } }))]) {
    const h = harness([response]); await assert.rejects(deployLiveStaging(options, h.deps), /^Error: LIVE_STAGING_SETTINGS_READ_FAILED$/); assert.ok(!h.calls.includes("deploy"));
  }
  const h = harness(); h.deps.fetch = async () => { throw Error("private token in upstream exception"); };
  await assert.rejects(deployLiveStaging(options, h.deps), /^Error: LIVE_STAGING_SETTINGS_READ_FAILED$/); assert.deepEqual(h.writes, []);
});
test("a concurrent runtime change during build requires a fresh read rather than overwriting it", async () => {
  const changed = live(); changed.find((b) => b.name === "DAILY_SPEND_CAP_USD").text = "5";
  const h = harness([live(), changed]); await assert.rejects(deployLiveStaging(options, h.deps), /LIVE_STAGING_CHANGED_DURING_BUILD/); assert.deepEqual(h.writes, []);
});
test("binding response ordering does not constitute a runtime change", async () => {
  const h = harness([live(), live().reverse()]); await deployLiveStaging(options, h.deps); assert.equal(h.calls.at(-1), "deploy");
});
test("build failure cannot fall through into a deployment", async () => {
  const h = harness(undefined, { buildFails: true }); await assert.rejects(deployLiveStaging(options, h.deps), /build-failed/); assert.deepEqual(h.calls, ["fetch", "build"]);
});
test("unknown bindings and changed Durable Object classes are rejected, never dropped", () => {
  assert.throws(() => stagingOverlay(config(), [...live(), { name: "NEW", type: "unrecognized" }], accountId), /UNSUPPORTED_BINDING/);
  const changed = live(); changed.find((b) => b.name === "VAULT").class_name = "ReplacementVault";
  assert.throws(() => stagingOverlay(config(), changed, accountId), /DURABLE_OBJECT_CHANGED/);
  assert.throws(() => stagingOverlay(config(), live().filter((b) => b.name !== "VAULT"), accountId), /NEW_DURABLE_OBJECT/);
});
test("existing workflow identity is preserved and new workflows or platform bindings require a separate configuration change", () => {
  assert.deepEqual(stagingOverlay(config(), live(), accountId).workflows, config().workflows);
  const changed = live(); changed.find((b) => b.name === "TAILOR").workflow_name = "replacement-tailor";
  assert.throws(() => stagingOverlay(config(), changed, accountId), /WORKFLOW_CHANGED/);
  assert.throws(() => stagingOverlay(config(), live().filter((b) => b.name !== "TAILOR"), accountId), /NEW_WORKFLOW/);
  assert.throws(() => stagingOverlay(config(), live().filter((b) => b.name !== "AI"), accountId), /NEW_PLATFORM_BINDING/);
});
test("a secret cannot shadow an evaluated or template setting", () => {
  for (const name of ["MODEL_JUDGE", "EXTRACTOR", "DAILY_SPEND_CAP_USD"]) {
    const bindings = live().filter((b) => b.name !== name);
    assert.throws(() => stagingOverlay(config(), [...bindings, { name, type: "secret_text" }], accountId), /SECRET_SHADOWS_CONFIGURATION/);
  }
});
test("artifact write or rename failure cannot fall through into deployment", async () => {
  for (const stage of ["writeFile", "rename"]) {
    const h = harness(); h.deps[stage] = async () => { throw Error("disk error"); };
    await assert.rejects(deployLiveStaging(options, h.deps), /disk error/); assert.ok(!h.calls.includes("deploy"));
  }
});
test("wrong target or account, incomplete settings and plaintext secrets are refused", () => {
  assert.throws(() => stagingOverlay({ ...config(), name: "resumatic" }, live(), accountId), /TARGET_INVALID/);
  assert.throws(() => stagingOverlay(config(), live(), "b".repeat(32)), /SETTINGS_INCOMPLETE/);
  assert.throws(() => stagingOverlay(config(), live().filter((b) => b.name !== "OIDC_CLIENT_ID"), accountId), /SETTINGS_INCOMPLETE/);
  assert.throws(() => stagingOverlay(config(), [...live().filter((b) => b.name !== "SESSION_KEY"), { name: "SESSION_KEY", type: "plain_text", text: "secret" }], accountId), /PLAINTEXT_SECRET/);
});
test("credential refresh and token retrieval capture their output privately", () => {
  const calls = [];
  const token = stagingCredentials({}, (_command, args, options) => { calls.push({ args, options }); return { status: 0, stdout: args.includes("token") ? JSON.stringify({ type: "oauth", token: "private-token" }) : "account metadata" }; });
  assert.equal(token, "private-token"); assert.equal(calls.length, 2); assert.equal(calls[0].args.at(-1), "whoami");
  assert.ok(calls.every((c) => c.options.stdio === "pipe" && c.options.env.CI === "true"));
  assert.throws(() => stagingCredentials({}, () => ({ status: 1, stderr: "private upstream text" })), /^Error: LIVE_STAGING_AUTH_REQUIRED$/);
});
