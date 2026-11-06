import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectPilotDeployment, validPilotObservation } from "./lib/pilot-deployment.mjs";
import { runPilotInspection } from "./inspect-pilot-deployment.mjs";
import { SharedPilotBudget } from "../test/evals/shared-pilot.mjs";

const account = "a".repeat(32);
const version = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const deployment = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const nonce = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const token = "synthetic-token-never-in-output";
const secret = "synthetic-pilot-key-for-test-only-1234567890";
const origin = "https://staging.example.test";
const observation = {
  path: "distill", vaultId: "c".repeat(64), runId: "synthetic-run", step: "convert",
  workerVersion: version, runtimeVersion: version,
};
const bindings = () => [
  { type: "durable_object_namespace", name: "PILOT_BUDGET", class_name: "PilotBudget" },
  { type: "version_metadata", name: "PILOT_VERSION_METADATA" },
  { type: "secret_text", name: "PILOT_BUDGET_KEY" },
  { type: "plain_text", name: "PILOT_SHARED_BUDGET", text: "true" },
  { type: "plain_text", name: "ALLOW_TEST_SIGNIN", text: "true" },
];
const active = () => ({ success: true, result: { deployments: [
  { id: deployment, strategy: "percentage", versions: [{ version_id: version, percentage: 100 }] },
] } });
const config = () => ({ success: true, result: { id: version, resources: { bindings: bindings() } } });
const respond = (body, status = 200) => new Response(JSON.stringify(body), { status });
const env = { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, STAGING_URL: origin };
const deps = { readConfig: async (name, path) => {
  assert.equal(name, "staging");
  assert.ok(path.endsWith("/wrangler.jsonc"));
  return { name: "resumatic-staging", config: { vars: { CF_ACCOUNT_ID: account, APP_ORIGIN: origin } } };
} };

async function probe(options = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/identity/begin")) return respond({ nonce, expiresAt: Date.now() + 60_000 }, 201);
    if (url.endsWith("/identity/status")) return respond({ state: options.waiting ? "waiting" : "observed" });
    if (url.endsWith("/identity/consume")) {
      if (options.consumeFailure) throw new Error(`private ${secret}`);
      return respond(options.observation ?? observation);
    }
    throw new Error("unexpected pilot operation");
  };
  const pilot = new SharedPilotBudget(origin, secret, fetcher);
  await pilot.beginIdentity(observation.path, observation.vaultId);
  return { pilot, nonce, runId: observation.runId, calls };
}

const provider = (options = {}) => {
  const calls = [];
  let deployments = 0;
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (options.failure) throw new Error(`private ${token}`);
    if (options.oversized) return new Response("x".repeat(512 * 1024 + 1), { status: 200 });
    if (url.includes("/versions/")) return respond(options.version ?? config());
    return respond(++deployments === 1 ? (options.before ?? active()) : (options.after ?? active()));
  };
  return { calls, fetcher };
};

async function inspect(options = {}) {
  const p = await probe(options);
  const c = provider(options);
  const result = await inspectPilotDeployment({ pilot: p.pilot, nonce: p.nonce, runId: p.runId, env, fetcher: c.fetcher }, deps);
  return { result, pilotCalls: p.calls, providerCalls: c.calls, pilot: p.pilot };
}

test("consumes the live one-use probe and compares a stable single-version deployment without enabling the pilot", async () => {
  const { result, pilotCalls, providerCalls, pilot } = await inspect();
  assert.equal(result.status, "pending");
  assert.equal(result.deployment, "single_version_observed");
  assert.equal(result.bindings, "expected_bindings_observed");
  assert.equal(result.observation, "https_probe_version_matches");
  assert.ok(result.pending.includes("staging_url_account_binding_unverified"));
  assert.ok(result.pending.includes("worker_code_revision_unverified"));
  assert.ok(result.pending.includes("workflow_and_old_version_drain_unverified"));
  assert.ok(result.pending.includes("provider_spend_bound_unverified"));
  assert.ok(result.pending.includes("test_configuration_override"));
  assert.equal(result.versionId, version);
  assert.equal(providerCalls.length, 3);
  assert.equal(pilotCalls.filter((c) => c.url.endsWith("/identity/consume")).length, 1);
  for (const call of providerCalls) {
    assert.ok(call.url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/resumatic-staging/`));
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.headers.authorization, `Bearer ${token}`);
  }
  assert.doesNotMatch(JSON.stringify(result), /synthetic-token|synthetic-pilot-key|synthetic-run|cccccccc/);
  await assert.rejects(pilot.consumeIdentity(nonce, observation.runId), /shared_pilot_identity_invalid/);
});

test("rejects untrusted claims, invalid config and mismatched origins without consuming a challenge", async () => {
  for (const extra of [
    { pilot: { origin, consumeIdentity: async () => observation } },
    { nonce: "not-a-nonce" }, { runId: "../run" },
    { env: { ...env, CLOUDFLARE_ACCOUNT_ID: "d".repeat(32) } },
    { env: { ...env, STAGING_URL: "https://other.example.test" } },
    { env: { ...env, CLOUDFLARE_API_TOKEN: "" } },
  ]) {
    const p = await probe();
    const c = provider();
    const result = await inspectPilotDeployment({ pilot: p.pilot, nonce, runId: p.runId, env, fetcher: c.fetcher, ...extra }, deps);
    assert.equal(result.status, "pending");
    assert.ok(result.pending.includes("configuration_or_probe_invalid"));
    assert.equal(c.calls.length, 0);
    assert.equal(p.calls.filter((call) => call.url.endsWith("/identity/consume")).length, 0);
  }
  assert.equal(validPilotObservation(observation), true);
  assert.equal(validPilotObservation({ ...observation, runId: undefined }), false);
  assert.equal(validPilotObservation({ ...observation, extra: "career text" }), false);
  const p = await probe();
  const c = provider();
  const alteredConfig = { readConfig: async () => ({ name: "resumatic-staging", config: { vars: {
    CF_ACCOUNT_ID: account, APP_ORIGIN: "https://other.example.test",
  } } }) };
  const result = await inspectPilotDeployment({ pilot: p.pilot, nonce, runId: p.runId, env, fetcher: c.fetcher }, alteredConfig);
  assert.ok(result.pending.includes("configuration_or_probe_invalid"));
  assert.equal(p.calls.length, 1); // only the initial begin; no status or consume
  assert.equal(c.calls.length, 0);
});

test("does not consume a waiting challenge or one whose provider deployment is split", async () => {
  const waiting = await inspect({ waiting: true });
  assert.ok(waiting.result.pending.includes("probe_not_observed"));
  assert.equal(waiting.providerCalls.length, 0);
  assert.equal(waiting.pilotCalls.filter((c) => c.url.endsWith("/identity/consume")).length, 0);
  const split = active();
  split.result.deployments[0].versions = [
    { version_id: version, percentage: 50 },
    { version_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", percentage: 50 },
  ];
  const result = await inspect({ before: split });
  assert.equal(result.result.deployment, "unverified");
  assert.ok(result.result.pending.includes("single_active_deployment_unverified"));
  assert.equal(result.pilotCalls.filter((c) => c.url.endsWith("/identity/consume")).length, 0);
});

test("detects deployment changes and probe version mismatches", async () => {
  const changed = active();
  changed.result.deployments[0].id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const changedResult = await inspect({ after: changed });
  assert.equal(changedResult.result.deployment, "unverified");
  assert.ok(changedResult.result.pending.includes("deployment_changed_or_unavailable"));
  const mismatch = await inspect({ observation: { ...observation, runtimeVersion: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } });
  assert.equal(mismatch.result.observation, "version_mismatch");
  assert.ok(mismatch.result.pending.includes("observation_version_mismatch"));
});

test("requires unambiguous pilot bindings before consuming a challenge", async () => {
  for (const change of [
    (b) => b.filter((v) => v.name !== "PILOT_BUDGET"),
    (b) => [...b, b[0]],
    (b) => b.map((v) => v.name === "PILOT_BUDGET" ? { ...v, script_name: "other-worker" } : v),
    (b) => b.map((v) => v.name === "PILOT_SHARED_BUDGET" ? { ...v, type: "secret_text" } : v),
    (b) => b.map((v) => v.name === "ALLOW_TEST_SIGNIN" ? { ...v, text: "false" } : v),
  ]) {
    const v = config();
    v.result.resources.bindings = change(v.result.resources.bindings);
    const { result, pilotCalls } = await inspect({ version: v });
    assert.equal(result.bindings, "unverified");
    assert.ok(result.pending.includes("version_bindings_unverified"));
    assert.equal(pilotCalls.filter((c) => c.url.endsWith("/identity/consume")).length, 0);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-token|synthetic-pilot-key|PILOT_BUDGET_KEY/);
  }
});

test("provider and consume failures remain pending without exposing details", async () => {
  for (const options of [{ failure: true }, { oversized: true }, { before: { success: true, result: { deployments: [] } } }, { consumeFailure: true }]) {
    const { result } = await inspect(options);
    assert.equal(result.status, "pending");
    assert.equal(result.deployment, "unverified");
    assert.doesNotMatch(JSON.stringify(result), /synthetic-token|synthetic-pilot-key/);
  }
});

test("interactive wrapper opens and consumes only its own challenge, never starts a workflow or model call", async () => {
  const providerCalls = provider();
  const pilotCalls = [];
  const messages = [];
  let checks = 0;
  const pilotFetch = async (url, init) => {
    pilotCalls.push({ url, init });
    if (url.endsWith("/identity/begin")) return respond({ nonce, expiresAt: Date.now() + 60_000 }, 201);
    if (url.endsWith("/identity/status")) return respond({ state: ++checks === 1 ? "waiting" : "observed" });
    if (url.endsWith("/identity/consume")) return respond(observation);
    throw new Error("unexpected operation");
  };
  let waits = 0;
  const result = await runPilotInspection({
    args: ["--path", "distill", "--vault-id", observation.vaultId],
    env: { ...env, PILOT_BUDGET_KEY: secret }, input: { isTTY: true },
    output: { isTTY: true, write: (s) => messages.push(s) },
    providerFetch: providerCalls.fetcher, pilotFetch, promptRun: async () => observation.runId,
    wait: async (ms) => { assert.equal(ms, 1000); waits++; },
  }, deps);
  assert.equal(result.status, "pending");
  assert.equal(result.observation, "https_probe_version_matches");
  assert.equal(waits, 1);
  assert.equal(providerCalls.calls.length, 6);
  assert.deepEqual(pilotCalls.map((c) => new URL(c.url).pathname), [
    "/auth/test/pilot-budget/identity/begin",
    "/auth/test/pilot-budget/identity/status",
    "/auth/test/pilot-budget/identity/status",
    "/auth/test/pilot-budget/identity/status",
    "/auth/test/pilot-budget/identity/consume",
  ]);
  assert.ok(messages.join("").includes("will not start it"));
  assert.doesNotMatch(JSON.stringify({ result, messages }), /synthetic-token|synthetic-pilot-key|synthetic-run|cccccccc/);
});

test("wrapper fails before a challenge on invalid inputs, noninteractive use, or an unsafe preflight", async () => {
  const args = ["--path", "distill", "--vault-id", observation.vaultId];
  for (const override of [
    { args: ["--path", "unknown", "--vault-id", observation.vaultId] },
    { input: { isTTY: false } },
    { env: { ...env, STAGING_URL: "https://other.example.test", PILOT_BUDGET_KEY: secret } },
  ]) {
    const c = provider();
    let pilotCalls = 0;
    const result = await runPilotInspection({ args, env: { ...env, PILOT_BUDGET_KEY: secret },
      input: { isTTY: true }, output: { isTTY: true, write() {} }, providerFetch: c.fetcher,
      pilotFetch: async () => { pilotCalls++; throw new Error("unexpected"); }, ...override }, deps);
    assert.equal(result.status, "pending");
    assert.equal(pilotCalls, 0);
    assert.equal(c.calls.length, 0);
  }
  const c = provider({ before: { success: true, result: { deployments: [] } } });
  let pilotCalls = 0;
  const result = await runPilotInspection({ args, env: { ...env, PILOT_BUDGET_KEY: secret },
    input: { isTTY: true }, output: { isTTY: true, write() {} }, providerFetch: c.fetcher,
    pilotFetch: async () => { pilotCalls++; throw new Error("unexpected"); } }, deps);
  assert.ok(result.pending.includes("single_active_deployment_unverified"));
  assert.equal(pilotCalls, 0);
});

test("wrapper rejects invalid run IDs and implausible probe expiry without revealing input", async () => {
  for (const invalidExpiry of [false, true]) {
    const c = provider();
    const calls = [];
    const pilotFetch = async (url) => {
      calls.push(url);
      if (url.endsWith("/identity/begin")) return respond({ nonce, expiresAt: Date.now() + (invalidExpiry ? 3_600_000 : 60_000) }, 201);
      throw new Error("unexpected operation");
    };
    const result = await runPilotInspection({ args: ["--path", "distill", "--vault-id", observation.vaultId],
      env: { ...env, PILOT_BUDGET_KEY: secret }, input: { isTTY: true }, output: { isTTY: true, write() {} },
      providerFetch: c.fetcher, pilotFetch, promptRun: async () => "private invalid run id", wait: async () => {} }, deps);
    assert.ok(result.pending.includes(invalidExpiry ? "probe_expiry_invalid" : "run_id_invalid"));
    assert.equal(calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /private invalid run id|synthetic-pilot-key/);
  }
});
