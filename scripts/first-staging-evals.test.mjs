import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  createPilotLedger,
  reservePilotLedger,
  settlePilotAttempt,
  finishPilotSuite,
} from "../test/extract-evals/budget-ledger.mjs";

test("an overrun in another process freezes reservations across both suites", () =>
  temporary(async (dir) => {
    const ledger = createPilotLedger(dir, 10_000_000, 50);
    reservePilotLedger(
      ledger.file,
      "extraction",
      5_000_000,
      25,
      100,
      1,
      "attempt-one",
    );
    const moduleUrl = new URL(
      "../test/extract-evals/budget-ledger.mjs",
      import.meta.url,
    ).href;
    const code = `import { settlePilotAttempt } from ${JSON.stringify(moduleUrl)}; settlePilotAttempt(${JSON.stringify(ledger.file)}, "extraction", "attempt-one", 101);`;
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      code,
    ]);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.throws(
      () => reservePilotLedger(ledger.file, "tailoring", 5_000_000, 25, 1),
      /live_eval_campaign_frozen/,
    );
    assert.throws(
      () => reservePilotLedger(ledger.file, "extraction", 5_000_000, 25, 1),
      /live_eval_campaign_frozen/,
    );
  }));

test("unknown or unresolved attempts freeze the next suite", () =>
  temporary(async (dir) => {
    const ledger = createPilotLedger(dir, 10_000_000, 50);
    reservePilotLedger(
      ledger.file,
      "extraction",
      5_000_000,
      25,
      100,
      1,
      "attempt-two",
    );
    settlePilotAttempt(ledger.file, "extraction", "attempt-two", null);
    assert.equal(finishPilotSuite(ledger.file, "extraction", true), false);
    assert.throws(
      () => reservePilotLedger(ledger.file, "tailoring", 5_000_000, 25, 1),
      /live_eval_campaign_frozen/,
    );
  }));

test("a crashed worker with an unsettled reservation freezes the next suite", () =>
  temporary(async (dir) => {
    const ledger = createPilotLedger(dir, 10_000_000, 50);
    reservePilotLedger(
      ledger.file,
      "extraction",
      5_000_000,
      25,
      100,
      1,
      "attempt-three",
    );
    assert.equal(finishPilotSuite(ledger.file, "extraction", true), false);
    assert.throws(
      () => reservePilotLedger(ledger.file, "tailoring", 5_000_000, 25, 1),
      /live_eval_campaign_frozen/,
    );
  }));
import { runFirstStagingEvals } from "./first-staging-evals.mjs";

async function temporary(fn) {
  const dir = await mkdtemp(join(tmpdir(), "resumatic-pilot-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const input = {
  live: true,
  budgetUsd: 10,
  maxCalls: 50,
  dataset: "unused",
  strategy: "llm:default",
};
const env = {
  CF_ACCOUNT_ID: "account",
  CF_AI_TOKEN: "secret",
  CF_GATEWAY_READ_TOKEN: "gateway-read-secret",
  AI_GATEWAY_ID: "gateway",
  STAGING_URL: "https://staging.example.com",
  PILOT_BUDGET_KEY: "local-test-only-pilot-key-0123456789",
  EVAL_PRICE_REVIEW_DATE: new Date().toISOString().slice(0, 10),
  EVAL_BILLING_GUARD_REVIEW_DATE: new Date().toISOString().slice(0, 10),
  EVAL_BILLING_GUARD_SCOPE: "all-model-paths",
  EVAL_BILLING_GUARD_USD: "10",
  SEEDED_LIVE: "1",
  RECORD_MODE: "1",
  EVAL_ENV: "production",
};
const vars = {
  CF_ACCOUNT_ID: "account",
  AI_GATEWAY_ID: "gateway",
  MODEL_EXTRACT: "provider/a",
  MODEL_ANALYZE: "provider/b",
  MODEL_WRITE: "provider/c",
  MODEL_JUDGE: "provider/d",
};
const prices = Object.fromEntries(
  [
    "provider/a",
    "provider/b",
    "provider/c",
    "provider/d",
    "@cf/baai/bge-m3",
    "@cf/baai/bge-reranker-base",
  ].map((x) => [x, [1, 1]]),
);
const cases = Array.from({ length: 30 }, (_, i) => ({
  id: `case-${String(i + 1).padStart(16, "0")}`,
  split: i < 20 ? "dev" : "holdout",
  meta: { origin: i < 20 ? "synthetic" : "real" },
}));
function deps(dir, spawn) {
  return {
    stateRoot: dir,
    readConfig: async () => ({ config: { vars } }),
    loadDataset: () => ({ root: dir, cases }),
    knownPrices: prices,
    sharedPilot: { status: async () => ({ initialized: true, frozen: false, maxMicros: 10_000_000, maxCalls: 50, reservedMicros: 0, reservedCalls: 0, pending: 0, unknown: 0, overrun: 0 }) },
    sharedIdentityVerified: true,
    gatewayPrivacyObserved: async () => true,
    spawn,
  };
}

test("one-shot campaign passes only explicit pilot files and fixed partitions", () =>
  temporary(async (dir) => {
    const calls = [];
    const spawn = (exe, args, opts) => {
      calls.push({ exe, args, opts });
      const names =
        opts.env.EVAL_BUDGET_LEDGER_SUITE === "extraction"
          ? [cases[0].id]
          : ["confirmed-facts tailoring"];
      const output = args
        .find((a) => a.startsWith("--outputFile="))
        .slice("--outputFile=".length);
      writeFileSync(
        output,
        JSON.stringify({
          numFailedTests: 0,
          testResults: [
            {
              assertionResults: names.map((fullName) => ({
                status: "passed",
                fullName,
              })),
            },
          ],
        }),
      );
      return { status: 0 };
    };
    const result = await runFirstStagingEvals(
      { ...input, env },
      deps(dir, spawn),
    );
    assert.equal(result.promotionEligible, false);
    assert.equal(result.status, "completed");
    assert.equal(result.extractionCases, 1);
    assert.equal(result.tailoringCases, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((c) => [
        c.opts.env.EVAL_BUDGET_LEDGER_SUITE,
        c.opts.env.EVAL_BUDGET_USD,
        c.opts.env.EVAL_MAX_CALLS,
      ]),
      [
        ["extraction", "5", "12"],
        ["tailoring", "5", "38"],
      ],
    );
    assert.ok(calls[0].args.includes("test/extract-evals/run.eval.ts"));
    assert.ok(calls[1].args.includes("test/evals/pilot-tailor.eval.ts"));
    assert.deepEqual(result.coverage, { extraction: "separate-synthetic-case", tailoring: "confirmed-synthetic-facts", conversion: "not-run", workflows: "not-run" });
    assert.equal(calls[0].opts.env.PILOT_REQUIRE_EVIDENCE, "1");
    assert.equal(calls[1].opts.env.PILOT_REQUIRE_EVIDENCE, "0");
    assert.ok(
      calls.every(
        (c) =>
          c.args.includes("--maxWorkers=1") &&
          c.args.includes("--no-file-parallelism") &&
          c.opts.env.EVAL_ENV === "staging" &&
          c.opts.env.SEEDED_LIVE === "0" &&
          c.opts.env.RECORD_MODE === "0",
      ),
    );
    assert.ok(calls.every((c) => !("CF_GATEWAY_READ_TOKEN" in c.opts.env)));
    await assert.rejects(
      () => runFirstStagingEvals({ ...input, env }, deps(dir, spawn)),
      /live_eval_campaign_already_started/,
    );
    assert.equal(calls.length, 2);
  }));

test("preflight failures make no subprocess calls or campaign marker", () =>
  temporary(async (dir) => {
    let count = 0;
    const d = deps(dir, () => {
      count++;
      return { status: 0 };
    });
    await assert.rejects(
      () => runFirstStagingEvals({ ...input, live: false, env }, d),
      /EXPLICIT_LIVE_REQUIRED/,
    );
    await assert.rejects(
      () => runFirstStagingEvals({ ...input, budgetUsd: 10.01, env }, d),
      /PILOT_AUTHORIZATION_INVALID/,
    );
    await assert.rejects(
      () => runFirstStagingEvals({ ...input, maxCalls: 51, env }, d),
      /PILOT_AUTHORIZATION_INVALID/,
    );
    await assert.rejects(
      () => runFirstStagingEvals({ ...input, maxCalls: 37, env }, d),
      /PILOT_CALL_BUDGET_TOO_SMALL/,
    );
    await assert.rejects(
      () =>
        runFirstStagingEvals({ ...input, env: { ...env, CF_AI_TOKEN: "" } }, d),
      /PILOT_CREDENTIALS_REQUIRED/,
    );
    await assert.rejects(
      () =>
        runFirstStagingEvals(
          { ...input, env },
          {
            ...d,
            loadDataset: () => ({ root: dir, cases: cases.slice(0, 29) }),
          },
        ),
      /PILOT_DATASET_INCOMPLETE/,
    );
    await assert.rejects(
      () => runFirstStagingEvals({ ...input, env }, { ...d, knownPrices: {} }),
      /PILOT_MODEL_PRICE_REQUIRED/,
    );
    await assert.rejects(
      () =>
        runFirstStagingEvals(
          {
            ...input,
            env: { ...env, EVAL_BILLING_GUARD_SCOPE: "gateway-only" },
          },
          d,
        ),
      /PILOT_BILLING_GUARD_REQUIRED/,
    );
    await assert.rejects(
      () =>
        runFirstStagingEvals(
          { ...input, env: { ...env, EVAL_BILLING_GUARD_USD: "11" } },
          d,
        ),
      /PILOT_BILLING_GUARD_REQUIRED/,
    );
    await assert.rejects(
      () =>
        runFirstStagingEvals(
          {
            ...input,
            env: { ...env, EVAL_MODEL_PRICES: '{"provider/a":[0,0]}' },
          },
          d,
        ),
      /PILOT_PRICES_INVALID/,
    );
    for (const status of [
      { initialized: false },
      { initialized: true, frozen: true, maxMicros: 10_000_000, maxCalls: 50, reservedMicros: 0, reservedCalls: 0, pending: 0, unknown: 0, overrun: 0 },
      { initialized: true, frozen: false, maxMicros: 10_000_000, maxCalls: 50, reservedMicros: 1, reservedCalls: 1, pending: 1, unknown: 0, overrun: 0 },
      { initialized: true, frozen: false, maxMicros: 10_000_001, maxCalls: 50, reservedMicros: 0, reservedCalls: 0, pending: 0, unknown: 0, overrun: 0 },
    ]) {
      await assert.rejects(
        () => runFirstStagingEvals({ ...input, env }, { ...d, sharedPilot: { status: async () => status } }),
        /PILOT_SHARED_LEDGER_REQUIRED/,
      );
    }
    await assert.rejects(
      () => runFirstStagingEvals({ ...input, env }, { ...d, sharedIdentityVerified: false }),
      /PILOT_SHARED_IDENTITY_UNVERIFIED/,
    );
    assert.equal(count, 0);
    assert.ok(createPilotLedger(dir, 10_000_000, 50).file);
  }));

test("unverified gateway exports stop the pilot before a campaign marker or child process", () =>
  temporary(async (dir) => {
    let started = false;
    const dependencies = { ...deps(dir, () => { started = true; }), gatewayPrivacyObserved: async () => false };
    await assert.rejects(() => runFirstStagingEvals({ ...input, env }, dependencies), /PILOT_GATEWAY_PRIVACY_UNVERIFIED/);
    assert.equal(started, false);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(dir), []);
  }));

test("preflight rejects zero input prices for every required model before creating the ledger", () =>
  temporary(async (dir) => {
    let subprocesses = 0;
    let ledgers = 0;
    const dependencies = {
      ...deps(dir, () => { subprocesses++; return { status: 0 }; }),
      createLedger: () => { ledgers++; throw new Error("unexpected ledger"); },
    };
    for (const model of Object.keys(prices)) {
      await assert.rejects(
        () => runFirstStagingEvals(
          { ...input, env: { ...env, EVAL_MODEL_PRICES: JSON.stringify({ [model]: [0, 1] }) } },
          dependencies,
        ),
        /PILOT_MODEL_PRICE_REQUIRED/,
      );
    }
    assert.equal(subprocesses, 0);
    assert.equal(ledgers, 0);
    assert.ok(createPilotLedger(dir, 10_000_000, 50).file);
  }));

test("preflight checks remaining shared capacity before creating the one-shot marker", () =>
  temporary(async (dir) => {
    let subprocesses = 0;
    let ledgers = 0;
    const base = deps(dir, () => { subprocesses++; return { status: 0 }; });
    const status = { initialized: true, frozen: false, maxMicros: 10_000_000, maxCalls: 50, reservedMicros: 0, reservedCalls: 0, pending: 0, unknown: 0, overrun: 0 };
    const dependencies = (overrides) => ({
      ...base,
      sharedPilot: { status: async () => ({ ...status, ...overrides }) },
      createLedger: () => { ledgers++; throw new Error("ledger reached"); },
    });
    await assert.rejects(
      () => runFirstStagingEvals({ ...input, env }, dependencies({ reservedCalls: 3 })),
      /PILOT_SHARED_BUDGET_TOO_SMALL/,
    );
    await assert.rejects(
      () => runFirstStagingEvals({ ...input, env }, dependencies({ reservedCalls: 1, reservedMicros: 9_999_999 })),
      /PILOT_SHARED_BUDGET_TOO_SMALL/,
    );
    assert.equal(ledgers, 0);
    assert.equal(subprocesses, 0);
    // The exact minimum of 48 weighted attempts reaches ledger creation;
    // this is preflight evidence only, not a reservation of those attempts.
    await assert.rejects(
      () => runFirstStagingEvals({ ...input, env }, dependencies({ reservedCalls: 2, reservedMicros: 1 })),
      /ledger reached/,
    );
    assert.equal(ledgers, 1);
    assert.equal(subprocesses, 0);
  }));

test("only strategies whose minimum gateway reservations fit can start the first pilot", async () => {
  for (const [strategy, extractionCalls] of [
    ["llm:default", 12], ["llm:provider/a", 12],
  ]) {
    await temporary(async (dir) => {
      const allocations = [];
      const spawn = (_exe, args, opts) => {
        const suite = opts.env.EVAL_BUDGET_LEDGER_SUITE;
        allocations.push([suite, Number(opts.env.EVAL_MAX_CALLS)]);
        const output = args.find((a) => a.startsWith("--outputFile=")).slice("--outputFile=".length);
        writeFileSync(output, JSON.stringify({ numFailedTests: 0, testResults: [{ assertionResults: [{ status: "passed", fullName: suite === "extraction" ? cases[0].id : "confirmed-facts tailoring" }] }] }));
        return { status: 0 };
      };
      const dependencies = { ...deps(dir, spawn), knownPrices: { ...prices, "@cf/cloudflare/clairic": [0.1, 0] } };
      const result = await runFirstStagingEvals({ ...input, strategy, env }, dependencies);
      assert.equal(result.status, "completed");
      assert.deepEqual(allocations, [["extraction", extractionCalls], ["tailoring", 50 - extractionCalls]]);
    });
  }
  for (const strategy of ["clairic", "judge:llm:default", "judge:clairic"]) {
    await temporary(async (dir) => {
      let invoked = false;
      await assert.rejects(() => runFirstStagingEvals({ ...input, strategy, env }, deps(dir, () => { invoked = true; })), /PILOT_CALL_BUDGET_TOO_SMALL/);
      assert.equal(invoked, false);
    });
  }
});

test("invalid call partitions fail before creating a ledger", () =>
  temporary(async (dir) => {
    assert.throws(() => createPilotLedger(dir, 10_000_000, 50, 0), /live_eval_budget_invalid/);
    assert.throws(() => createPilotLedger(dir, 10_000_000, 50, 50), /live_eval_budget_invalid/);
    assert.ok(createPilotLedger(dir, 10_000_000, 50, 12).file);
  }));

test("every restart and concurrent worker shares durable reservations and separate caps", () =>
  temporary(async (dir) => {
    const l = createPilotLedger(dir, 10_000_000, 50);
    const code = `import {reservePilotLedger} from ${JSON.stringify(new URL("../test/extract-evals/budget-ledger.mjs", import.meta.url).href)};let n=0;for(let i=0;i<30;i++){try{reservePilotLedger(process.env.LEDGER,'extraction',5000000,25,200000);n++;}catch{}}process.stdout.write(String(n));`;
    const run = () =>
      new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ["--input-type=module", "-e", code], {
          env: { ...process.env, LEDGER: l.file },
          stdio: ["ignore", "pipe", "ignore"],
        });
        let out = "";
        p.stdout.on("data", (b) => (out += b));
        p.on("exit", (c) =>
          c === 0 ? resolve(Number(out)) : reject(new Error("child_failed")),
        );
      });
    const successes = (await Promise.all([run(), run(), run(), run()])).reduce(
      (a, b) => a + b,
      0,
    );
    assert.ok(successes > 0 && successes <= 25);
    // Fill remaining reservations from a new process context; none can be refunded on failure.
    let total = successes;
    while (true) {
      try {
        reservePilotLedger(l.file, "extraction", 5_000_000, 25, 200_000);
        total++;
      } catch (e) {
        assert.match(e.message, /live_eval_budget_exhausted/);
        break;
      }
    }
    assert.equal(total, 25);
    assert.deepEqual(
      reservePilotLedger(l.file, "tailoring", 5_000_000, 25, 100_000),
      { calls: 1, reservedUsd: 0.1 },
    );
    assert.throws(
      () => reservePilotLedger(l.file, "tailoring", 10_000_000, 50, 1),
      /live_eval_ledger_unavailable/,
    );
  }));

test("tampered or symlink ledger fails closed", () =>
  temporary(async (dir) => {
    const l = createPilotLedger(dir, 10_000_000, 50);
    await rm(l.file);
    await writeFile(join(dir, "other"), "not a ledger", { mode: 0o600 });
    await symlink(join(dir, "other"), l.file);
    assert.throws(
      () => reservePilotLedger(l.file, "extraction", 5_000_000, 25, 1),
      /live_eval_ledger_unavailable/,
    );
  }));

test("synthetic mode clears inherited private dataset and rejects ambiguous modes", () =>
  temporary(async (dir) => {
    const syntheticCases = Array.from({ length: 3 }, (_, i) => ({
      id: `synthetic-0${i + 1}`,
      split: "dev",
      meta: { origin: "synthetic" },
    }));
    let privateReads = 0;
    const calls = [];
    const spawn = (exe, args, opts) => {
      calls.push(opts.env);
      const names =
        opts.env.EVAL_BUDGET_LEDGER_SUITE === "extraction"
          ? ["synthetic-01"]
          : ["confirmed-facts tailoring"];
      const output = args
        .find((a) => a.startsWith("--outputFile="))
        .slice("--outputFile=".length);
      writeFileSync(
        output,
        JSON.stringify({
          numFailedTests: 0,
          testResults: [
            {
              assertionResults: names.map((fullName) => ({
                status: "passed",
                fullName,
              })),
            },
          ],
        }),
      );
      return { status: 0 };
    };
    const d = {
      ...deps(dir, spawn),
      syntheticCases,
      loadDataset: () => {
        privateReads++;
        throw Error("must not load private data");
      },
    };
    await assert.rejects(
      () => runFirstStagingEvals({ ...input, synthetic: true, env }, d),
      /PILOT_DATASET_MODE_REQUIRED/,
    );
    const result = await runFirstStagingEvals(
      {
        ...input,
        dataset: undefined,
        synthetic: true,
        env: { ...env, EXTRACT_DATASET_DIR: "private-inherited" },
      },
      d,
    );
    assert.equal(result.status, "completed");
    assert.equal(privateReads, 0);
    assert.ok(calls.every((e) => !("EXTRACT_DATASET_DIR" in e)));
  }));

test("a zero-test subprocess cannot produce a completed pilot", () =>
  temporary(async (dir) => {
    const spawn = (exe, args) => {
      const output = args
        .find((a) => a.startsWith("--outputFile="))
        .slice("--outputFile=".length);
      writeFileSync(
        output,
        JSON.stringify({
          numFailedTests: 0,
          testResults: [{ assertionResults: [] }],
        }),
      );
      return { status: 0 };
    };
    const result = await runFirstStagingEvals(
      { ...input, env },
      deps(dir, spawn),
    );
    assert.equal(result.status, "incomplete");
    assert.equal(result.promotionEligible, false);
  }));

test("weighted reservations count possible hidden gateway attempts", () =>
  temporary(async (dir) => {
    const l = createPilotLedger(dir, 10_000_000, 50);
    for (let i = 0; i < 4; i++)
      reservePilotLedger(l.file, "extraction", 5_000_000, 25, 100, 6);
    assert.throws(
      () => reservePilotLedger(l.file, "extraction", 5_000_000, 25, 100, 6),
      /live_eval_budget_exhausted/,
    );
    assert.deepEqual(
      reservePilotLedger(l.file, "tailoring", 5_000_000, 25, 100, 6),
      { calls: 6, reservedUsd: 0.0001 },
    );
  }));

test("one realistic nonempty pipeline per suite fits the authorized shared cap", () =>
  temporary(async (dir) => {
    const ledger = createPilotLedger(dir, 10_000_000, 50, 12);
    const result = spawnSync(process.execPath, [
      "node_modules/vitest/vitest.mjs", "run", "--project", "unit",
      "test/unit/pilot-budget-scenario.test.ts", "--maxWorkers=1", "--no-file-parallelism",
    ], {
      env: { ...process.env, TEST_PILOT_BUDGET_SCENARIO: "1", EVAL_BUDGET_LEDGER: ledger.file },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const db = new DatabaseSync(ledger.file, { readOnly: true });
    try {
      const rows = db.prepare("SELECT suite,max_calls,used_calls,max_micros,used_micros FROM budgets ORDER BY suite").all();
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => [r.suite, r.max_calls]), [["extraction", 12], ["tailoring", 38]]);
      assert.deepEqual(rows.map((r) => [r.suite, r.used_calls]), [["extraction", 12], ["tailoring", 36]]);
      assert.ok(rows.every((r) => r.used_calls > 0 && r.used_calls <= r.max_calls && r.used_micros <= r.max_micros));
      assert.ok(rows.reduce((sum, r) => sum + r.used_calls, 0) <= 50);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE state != 'settled'").get().n, 0);
    } finally {
      db.close();
    }
  }));

test("actual isolated Vitest workers share the same durable ledger", () =>
  temporary(async (dir) => {
    const l = createPilotLedger(dir, 10_000_000, 50);
    const childEnv = {
      ...process.env,
      TEST_PILOT_LEDGER_WORKER: "1",
      EVAL_BUDGET_LEDGER: l.file,
      EVAL_BUDGET_LEDGER_SUITE: "extraction",
      EVAL_BUDGET_USD: "5",
      EVAL_MAX_CALLS: "25",
    };
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(
        process.execPath,
        [
          "node_modules/vitest/vitest.mjs",
          "run",
          "--project",
          "unit",
          "test/unit/pilot-ledger-worker.test.ts",
          "--maxWorkers=1",
          "--no-file-parallelism",
        ],
        { env: childEnv, stdio: "ignore" },
      );
      assert.equal(result.status, 0);
    }
    const db = new DatabaseSync(l.file, { readOnly: true });
    try {
      assert.equal(
        db
          .prepare("SELECT used_calls FROM budgets WHERE suite = 'extraction'")
          .get().used_calls,
        12,
      );
    } finally {
      db.close();
    }
  }));

test("a process dying after reservation cannot refund or reset the ledger", () =>
  temporary(async (dir) => {
    const l = createPilotLedger(dir, 10_000_000, 50);
    const code = `import {reservePilotLedger} from ${JSON.stringify(new URL("../test/extract-evals/budget-ledger.mjs", import.meta.url).href)};reservePilotLedger(process.env.LEDGER,'extraction',5000000,25,100,6);process.kill(process.pid,'SIGKILL');`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", code],
      { env: { ...process.env, LEDGER: l.file }, stdio: "ignore" },
    );
    assert.equal(result.signal, "SIGKILL");
    assert.deepEqual(
      reservePilotLedger(l.file, "extraction", 5_000_000, 25, 100, 6),
      { calls: 12, reservedUsd: 0.0002 },
    );
  }));
