import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectPilotAttempts } from "./inspect-pilot-attempts.mjs";

const account = "a".repeat(32), origin = "https://staging.example.test";
const version = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", deployment = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const key = "synthetic-pilot-key-for-test-only-1234567890", token = "synthetic-token-not-for-output";
const env = { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, STAGING_URL: origin, PILOT_BUDGET_KEY: key };
const dependencies = { readConfig: async () => ({ name: "resumatic-staging", config: { vars: { CF_ACCOUNT_ID: account, APP_ORIGIN: origin } } }) };
const bindings = [
  { type: "durable_object_namespace", name: "PILOT_BUDGET", class_name: "PilotBudget" },
  { type: "version_metadata", name: "PILOT_VERSION_METADATA" },
  { type: "secret_text", name: "PILOT_BUDGET_KEY" },
  { type: "plain_text", name: "PILOT_SHARED_BUDGET", text: "true" },
  { type: "plain_text", name: "ALLOW_TEST_SIGNIN", text: "true" },
];
const providerFetch = async (url) => Response.json({ success: true, result: url.includes("/versions/")
  ? { id: version, resources: { bindings } }
  : { deployments: [{ id: deployment, strategy: "percentage", versions: [{ version_id: version, percentage: 100 }] }] } });
const attempt = () => ({ idMac: "d".repeat(64), reservedMicros: 7, reservedCalls: 1, state: "pending", actualMicros: null });
const totals = () => ({ maxMicros: 10_000_000, maxCalls: 50, reservedMicros: 7, reservedCalls: 1,
  frozen: false, count: 1, pending: 1, unknown: 0, overrun: 0 });

test("attempt audit reads only opaque bounded metadata and remains pending", async () => {
  const calls = [];
  const pilotFetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ totals: totals(), attempts: [attempt()] });
  };
  const report = await inspectPilotAttempts({ env, providerFetch, pilotFetch }, dependencies);
  assert.equal(report.status, "pending");
  assert.deepEqual(report.attempts, [attempt()]);
  assert.deepEqual(report.totals, totals());
  assert.ok(report.pending.includes("attempt_outcome_and_provider_bounds_unverified"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers["x-pilot-budget-key"], key);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-token|synthetic-pilot-key/);
});

test("rejects untrusted origins and invalid or oversized audit responses", async () => {
  let calls = 0;
  const denied = await inspectPilotAttempts({ env: { ...env, STAGING_URL: "https://other.example.test" }, providerFetch, pilotFetch: async () => { calls++; } }, dependencies);
  assert.equal(denied.status, "pending"); assert.equal(calls, 0);
  for (const body of [
    { totals: totals(), attempts: [ { ...attempt(), idMac: "raw-id" } ] },
    { totals: totals(), attempts: [ { ...attempt(), arbitraryText: "private" } ] },
    { totals: totals(), attempts: [ { ...attempt(), state: "settled" } ] },
    { totals: totals(), attempts: [attempt(), attempt()] },
    { totals: totals(), attempts: Array.from({ length: 51 }, attempt) },
    // A valid-looking subset cannot match the counters from the same snapshot.
    { totals: totals(), attempts: [] },
    { totals: { ...totals(), reservedMicros: 8 }, attempts: [attempt()] },
    { totals: { ...totals(), pending: 0, unknown: 1 }, attempts: [{ ...attempt(), state: "unknown" }] },
    { totals: { ...totals(), pending: 0, overrun: 1 }, attempts: [{ ...attempt(), state: "overrun", actualMicros: 8 }] },
  ]) {
    const result = await inspectPilotAttempts({ env, providerFetch, pilotFetch: async () => Response.json(body) }, dependencies);
    assert.deepEqual(result, { status: "pending", pending: ["pilot_attempt_audit_unavailable"] });
  }
  const large = await inspectPilotAttempts({ env, providerFetch, pilotFetch: async () => new Response("x".repeat(32_769)) }, dependencies);
  assert.deepEqual(large, { status: "pending", pending: ["pilot_attempt_audit_unavailable"] });
  const partial = await inspectPilotAttempts({ env, providerFetch, pilotFetch: async () => Response.json({ totals: totals(), attempts: [attempt()] }, { status: 206 }) }, dependencies);
  assert.deepEqual(partial, { status: "pending", pending: ["pilot_attempt_audit_unavailable"] });
});
