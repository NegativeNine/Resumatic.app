import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectPilotAttempts } from "./inspect-pilot-attempts.mjs";
import { createHmac, createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { auditPilotLedger, createPilotLedger, reservePilotLedger, settlePilotAttempt } from "../test/extract-evals/budget-ledger.mjs";

const account = "a".repeat(32), origin = "https://resumatic-staging.account-example.workers.dev";
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
const providerFetch = async (url) => Response.json({ success: true, result:
  url.endsWith("/workers/subdomain") ? { subdomain: "account-example" }
    : url.endsWith("/scripts/resumatic-staging/subdomain") ? { enabled: true }
    : url.includes("/versions/") ? { id: version, resources: { bindings } }
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

test("attempt audit does not send its key to a custom domain", async () => {
  const customOrigin = "https://staging.example.test";
  const customEnv = { ...env, STAGING_URL: customOrigin };
  const customDeps = { readConfig: async () => ({ name: "resumatic-staging", config: { vars: {
    CF_ACCOUNT_ID: account, APP_ORIGIN: customOrigin,
  } } }) };
  let calls = 0;
  const result = await inspectPilotAttempts({ env: customEnv, providerFetch, pilotFetch: async () => { calls++; } }, customDeps);
  assert.ok(result.pending.includes("staging_origin_unverified"));
  assert.equal(calls, 0);
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

test("compares a private local ledger by keyed fingerprint without modifying it or authorizing spend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-reconcile-"));
  try {
    const local = createPilotLedger(dir, 10_000_000, 50);
    reservePilotLedger(local.file, "extraction", local.extraction.micros, local.extraction.calls, 7, 6, "attempt-one");
    reservePilotLedger(local.file, "tailoring", local.tailoring.micros, local.tailoring.calls, 8, 1, "attempt-two");
    settlePilotAttempt(local.file, "extraction", "attempt-one", 5);
    const mac = (id) => createHmac("sha256", key).update(`resumatic-pilot-attempt-v1:${id}`).digest("hex");
    const attempts = [
      { idMac: mac("attempt-one"), reservedMicros: 7, reservedCalls: 6, state: "settled", actualMicros: 5 },
      { idMac: mac("other-host"), reservedMicros: 4, reservedCalls: 1, state: "pending", actualMicros: null },
    ];
    const snapshot = { totals: { maxMicros: 10_000_000, maxCalls: 50, reservedMicros: 11, reservedCalls: 7,
      frozen: false, count: 2, pending: 1, unknown: 0, overrun: 0 }, attempts };
    const hash = () => createHash("sha256").update(readFileSync(local.file)).digest("hex");
    const before = hash();
    const report = await inspectPilotAttempts({ env: { ...env, PILOT_LOCAL_LEDGER: local.file }, providerFetch,
      pilotFetch: async () => Response.json(snapshot) }, dependencies);
    assert.equal(report.status, "pending");
    assert.equal(report.local.status, "pending");
    assert.equal(report.local.sharedOnly, 1);
    assert.deepEqual(report.local.attempts.map((row) => [row.idMac, row.comparison]), [
      [mac("attempt-one"), "matching_reservation_and_state"], [mac("attempt-two"), "local_only"],
    ]);
    assert.equal(report.local.attempts[0].reservedCalls, 6);
    assert.ok(!report.local.limitations.includes("local_attempt_call_weights_unavailable"));
    assert.ok(report.local.limitations.includes("snapshots_not_atomic"));
    assert.equal(hash(), before);
    assert.doesNotMatch(JSON.stringify(report), /attempt-one|attempt-two|other-host|synthetic-pilot-key/);
    snapshot.attempts[0].reservedCalls = 5;
    snapshot.totals.reservedCalls = 6;
    const differentCalls = await inspectPilotAttempts({ env: { ...env, PILOT_LOCAL_LEDGER: local.file }, providerFetch,
      pilotFetch: async () => Response.json(snapshot) }, dependencies);
    assert.equal(differentCalls.local.attempts[0].comparison, "different");
    snapshot.attempts[0].reservedCalls = 6;
    snapshot.totals.reservedCalls = 7;
    snapshot.attempts[0].actualMicros = 6;
    const changed = await inspectPilotAttempts({ env: { ...env, PILOT_LOCAL_LEDGER: local.file }, providerFetch,
      pilotFetch: async () => Response.json(snapshot) }, dependencies);
    assert.equal(changed.local.attempts[0].comparison, "different");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy ledger retains unknown individual weights without inventing a match", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-legacy-"));
  try {
    const local = createPilotLedger(dir, 10_000_000, 50);
    reservePilotLedger(local.file, "extraction", local.extraction.micros, local.extraction.calls, 7, 6, "legacy-attempt");
    const db = new DatabaseSync(local.file);
    db.exec("ALTER TABLE attempts DROP COLUMN reserved_calls; UPDATE meta SET version=2");
    db.close();
    assert.throws(() => reservePilotLedger(local.file, "extraction", local.extraction.micros, local.extraction.calls, 7, 1, "new-attempt"), /live_eval_ledger_unavailable/);
    const sharedAttempt = { idMac: createHmac("sha256", key).update("resumatic-pilot-attempt-v1:legacy-attempt").digest("hex"),
      reservedMicros: 7, reservedCalls: 1, state: "pending", actualMicros: null };
    const snapshot = { totals: { ...totals(), reservedCalls: 1 }, attempts: [sharedAttempt] };
    const report = await inspectPilotAttempts({ env: { ...env, PILOT_LOCAL_LEDGER: local.file }, providerFetch,
      pilotFetch: async () => Response.json(snapshot) }, dependencies);
    assert.equal(report.local.attempts[0].reservedCalls, null);
    assert.equal(report.local.attempts[0].comparison, "matching_amount_and_state_calls_unknown");
    assert.ok(report.local.limitations.includes("local_attempt_call_weights_unavailable"));
    assert.equal(auditPilotLedger(local.file).budgets[0].reservedCalls, 6);
    settlePilotAttempt(local.file, "extraction", "legacy-attempt", 5);
    assert.equal(auditPilotLedger(local.file).attempts[0].actualMicros, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects malformed or inconsistent per-attempt call reservations", () => {
  for (const value of [0, -1, "invalid", 5, 7]) {
    const dir = mkdtempSync(join(tmpdir(), "pilot-call-weight-"));
    try {
      const local = createPilotLedger(dir, 10_000_000, 50);
      reservePilotLedger(local.file, "extraction", local.extraction.micros, local.extraction.calls, 1, 6, "attempt");
      const db = new DatabaseSync(local.file);
      db.prepare("UPDATE attempts SET reserved_calls=?").run(value);
      db.close();
      assert.throws(() => auditPilotLedger(local.file), /live_eval_ledger_unavailable/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("a corrupt or non-private local ledger stays unavailable without exposing its contents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-reconcile-"));
  try {
    const local = createPilotLedger(dir, 10_000_000, 50);
    reservePilotLedger(local.file, "extraction", local.extraction.micros, local.extraction.calls, 7, 1, "private-attempt");
    const db = new DatabaseSync(local.file);
    db.prepare("UPDATE budgets SET used_micros=8 WHERE suite='extraction'").run();
    db.close();
    const report = await inspectPilotAttempts({ env: { ...env, PILOT_LOCAL_LEDGER: local.file }, providerFetch,
      pilotFetch: async () => Response.json({ totals: totals(), attempts: [attempt()] }) }, dependencies);
    assert.deepEqual(report.local, { status: "pending", reason: "local_ledger_unavailable" });
    assert.doesNotMatch(JSON.stringify(report), /private-attempt|pilot-reconcile-/);
    const repaired = new DatabaseSync(local.file);
    repaired.prepare("UPDATE budgets SET used_micros=7 WHERE suite='extraction'").run();
    // SQLite rowid tables can contain NULL in a non-INTEGER PRIMARY KEY.
    repaired.prepare("UPDATE attempts SET id=NULL").run();
    repaired.close();
    const nullId = await inspectPilotAttempts({ env: { ...env, PILOT_LOCAL_LEDGER: local.file }, providerFetch,
      pilotFetch: async () => Response.json({ totals: totals(), attempts: [attempt()] }) }, dependencies);
    assert.deepEqual(nullId.local, { status: "pending", reason: "local_ledger_unavailable" });
    const fixedId = new DatabaseSync(local.file);
    fixedId.prepare("UPDATE attempts SET id='private-attempt' WHERE id IS NULL").run();
    fixedId.close();
    chmodSync(local.file, 0o644);
    const nonPrivate = await inspectPilotAttempts({ env: { ...env, PILOT_LOCAL_LEDGER: local.file }, providerFetch,
      pilotFetch: async () => Response.json({ totals: totals(), attempts: [attempt()] }) }, dependencies);
    assert.deepEqual(nonPrivate.local, { status: "pending", reason: "local_ledger_unavailable" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("accepts a complete 50-attempt local campaign within the audit bound", () => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-audit-full-"));
  try {
    const local = createPilotLedger(dir, 10_000_000, 50);
    for (let i = 0; i < 50; i++) {
      const suite = i < 25 ? "extraction" : "tailoring";
      reservePilotLedger(local.file, suite, local[suite].micros, local[suite].calls, 1, 1, `attempt-${String(i).padStart(2, "0")}`);
    }
    const before = createHash("sha256").update(readFileSync(local.file)).digest("hex");
    assert.equal(auditPilotLedger(local.file).attempts.length, 50);
    assert.equal(createHash("sha256").update(readFileSync(local.file)).digest("hex"), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects malformed metadata, substituted views, oversized values and an invalid nullable number", () => {
  for (const scenario of ["many meta rows", "many budgets", "view", "oversized id", "invalid actual"]) {
    const dir = mkdtempSync(join(tmpdir(), "pilot-audit-malformed-"));
    try {
      const local = createPilotLedger(dir, 10_000_000, 50);
      reservePilotLedger(local.file, "extraction", local.extraction.micros, local.extraction.calls, 1, 1, "valid-attempt");
      const db = new DatabaseSync(local.file);
      try {
        db.exec("BEGIN");
        if (scenario === "many meta rows") {
          const insert = db.prepare("INSERT INTO meta(version,total_micros,total_calls,frozen) VALUES(2,1,1,0)");
          for (let i = 0; i < 1000; i++) insert.run();
        } else if (scenario === "many budgets") {
          const insert = db.prepare("INSERT INTO budgets(suite,max_micros,max_calls) VALUES(?,1,1)");
          for (let i = 0; i < 1000; i++) insert.run(`extra-${i}`);
        } else if (scenario === "view") {
          db.exec("DROP TABLE meta; CREATE VIEW meta AS SELECT 2 AS version, 10000000 AS total_micros, 50 AS total_calls, 0 AS frozen");
        } else if (scenario === "oversized id") {
          db.prepare("UPDATE attempts SET id=?").run("private".repeat(100_000));
        } else {
          // This must not be mistaken for a genuine NULL while pending.
          db.prepare("UPDATE attempts SET actual_micros='invalid'").run();
        }
        db.exec("COMMIT");
      } finally { db.close(); }
      const hash = () => createHash("sha256").update(readFileSync(local.file)).digest("hex");
      const before = hash();
      assert.throws(() => auditPilotLedger(local.file), /live_eval_ledger_unavailable/, scenario);
      assert.equal(hash(), before, scenario);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("rejects oversized or unsafe SQLite files and sidecars without modifying them", () => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-audit-size-"));
  try {
    const local = createPilotLedger(dir, 10_000_000, 50);
    const wal = `${local.file}-wal`;
    symlinkSync(local.file, wal);
    assert.throws(() => auditPilotLedger(local.file), /live_eval_ledger_unavailable/);
    unlinkSync(wal);
    writeFileSync(wal, new Uint8Array(8 * 1024 * 1024), { mode: 0o600 });
    assert.throws(() => auditPilotLedger(local.file), /live_eval_ledger_unavailable/);
    unlinkSync(wal);
    truncateSync(local.file, 8 * 1024 * 1024 + 1);
    const before = createHash("sha256").update(readFileSync(local.file)).digest("hex");
    assert.throws(() => auditPilotLedger(local.file), /live_eval_ledger_unavailable/);
    assert.equal(createHash("sha256").update(readFileSync(local.file)).digest("hex"), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
