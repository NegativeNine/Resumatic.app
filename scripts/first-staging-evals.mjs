#!/usr/bin/env node
// One explicitly authorized exploratory campaign. The private ledger is shared by every
// Vitest worker and survives retries/crashes; creating the same campaign twice fails closed.
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, join, dirname } from "node:path";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  constants,
} from "node:fs";
import { homedir } from "node:os";
import { readConfig } from "./lib/config.mjs";
import { loadPrivateDataset } from "../test/extract-evals/private-dataset.mjs";
import {
  createPilotLedger,
  finishPilotSuite,
} from "../test/extract-evals/budget-ledger.mjs";

const PROJECT = fileURLToPath(new URL("../", import.meta.url));
const TAILORING_CASE = "scope and numbers";
const validStrategy = (s) =>
  s === "clairic" ||
  s === "llm:default" ||
  s === "judge:clairic" ||
  s === "judge:llm:default" ||
  /^(?:judge:)?(?:llm|segment):(?:@cf\/|[a-z0-9_-]+\/)[a-zA-Z0-9/_.-]+$/.test(
    s,
  );
function fail(code) {
  throw new Error(code);
}

/** Dependencies are injectable solely so tests can verify failure and subprocess behavior offline. */
export async function runFirstStagingEvals(options, dependencies = {}) {
  const env = { ...(options.env ?? process.env) };
  if (options.live !== true) fail("EXPLICIT_LIVE_REQUIRED");
  if (
    !Number.isSafeInteger(options.maxCalls) ||
    options.maxCalls < 2 ||
    options.maxCalls > 50 ||
    !Number.isFinite(options.budgetUsd) ||
    options.budgetUsd <= 0 ||
    options.budgetUsd > 10 ||
    Math.floor(options.budgetUsd * 1_000_000) < 2
  )
    fail("PILOT_AUTHORIZATION_INVALID");
  if (!validStrategy(options.strategy)) fail("PILOT_STRATEGY_INVALID");
  // One extractor call and one judge call reserve six upstream attempts each.
  // Clairic's outline and one role use nine field passes instead of one chat
  // call; the judge add-on adds another chat call. Extra fields or schema
  // retries may still exhaust the allocation, which is reported incomplete.
  const judged = options.strategy.startsWith("judge:");
  const baseStrategy = options.strategy.replace(/^judge:/, "");
  const extractionCalls = (baseStrategy === "clairic" ? 15 : 12) + (judged ? 6 : 0);
  // A useful tailoring pass needs four chat calls (24 reserved attempts) and
  // two embeddings, before reranking or repairs. Never start an impossible run.
  if (options.maxCalls < extractionCalls + 26)
    fail("PILOT_CALL_BUDGET_TOO_SMALL");
  if (!env.CF_ACCOUNT_ID || !env.CF_AI_TOKEN || !env.AI_GATEWAY_ID)
    fail("PILOT_CREDENTIALS_REQUIRED");
  const { config } = await (dependencies.readConfig ?? readConfig)("staging");
  const vars = config.vars ?? {};
  if (
    !vars.CF_ACCOUNT_ID ||
    vars.CF_ACCOUNT_ID !== env.CF_ACCOUNT_ID ||
    !vars.AI_GATEWAY_ID ||
    vars.AI_GATEWAY_ID !== env.AI_GATEWAY_ID
  )
    fail("PILOT_STAGING_CONFIGURATION_REQUIRED");
  if ((options.synthetic === true) === Boolean(options.dataset))
    fail("PILOT_DATASET_MODE_REQUIRED");
  const data = options.synthetic
    ? {
        cases:
          dependencies.syntheticCases ??
          (await import("../test/extract-evals/cases.ts")).CASES,
      }
    : (dependencies.loadDataset ?? loadPrivateDataset)(options.dataset);
  const cases = data.cases ?? [];
  if (
    !options.synthetic &&
    (cases.length < 30 ||
      cases.filter((c) => c.meta?.origin === "synthetic").length < 20 ||
      cases.filter((c) => c.meta?.origin === "real").length < 10 ||
      cases.filter((c) => c.split === "dev").length < 20 ||
      cases.filter((c) => c.split === "holdout").length < 10)
  )
    fail("PILOT_DATASET_INCOMPLETE");
  const selectedCases = cases
    .filter((c) => c.split === "dev" && c.meta?.origin === "synthetic")
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 1);
  if (
    selectedCases.length !== 1 ||
    selectedCases.some(
      (c) =>
        !(
          options.synthetic ? /^synthetic-[0-9]{2}$/ : /^case-[a-f0-9]{16,64}$/
        ).test(c.id),
    )
  )
    fail("PILOT_DATASET_INVALID");

  let overrides = {};
  if (env.EVAL_MODEL_PRICES) {
    try {
      overrides = JSON.parse(env.EVAL_MODEL_PRICES);
    } catch {
      fail("PILOT_PRICES_INVALID");
    }
  }
  if (
    !overrides ||
    typeof overrides !== "object" ||
    Array.isArray(overrides) ||
    Object.entries(overrides).some(
      ([model, p]) =>
        !/^[A-Za-z0-9_@/:.\-]{1,240}$/.test(model) ||
        !Array.isArray(p) ||
        p.length !== 2 ||
        p.some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0) ||
        p.every((n) => n === 0),
    )
  )
    fail("PILOT_PRICES_INVALID");
  const known =
    dependencies.knownPrices ??
    (await import("../src/ai/usage.ts")).MODEL_PRICES;
  const prices = { ...known, ...overrides };
  const explicit =
    baseStrategy === "clairic"
      ? "@cf/cloudflare/clairic"
      : baseStrategy === "llm:default"
        ? vars.MODEL_EXTRACT
        : baseStrategy.replace(/^(?:llm|segment):/, "");
  const chatModels = [
    vars.MODEL_EXTRACT,
    vars.MODEL_ANALYZE,
    vars.MODEL_WRITE,
    vars.MODEL_JUDGE,
  ];
  if (baseStrategy !== "clairic") chatModels.push(explicit);
  const required = [
    ...chatModels,
    "@cf/baai/bge-m3",
    "@cf/baai/bge-reranker-base",
    vars.EMBEDDING_MODEL ?? "@cf/baai/bge-m3",
    explicit,
  ];
  if (
    required.some(
      (model) =>
        typeof model !== "string" ||
        !Array.isArray(prices[model]) ||
        prices[model].length !== 2 ||
        prices[model].some(
          (n) => typeof n !== "number" || !Number.isFinite(n) || n < 0,
        ) ||
        prices[model].every((n) => n === 0),
    ) ||
    chatModels.some((model) => prices[model][1] <= 0)
  )
    fail("PILOT_MODEL_PRICE_REQUIRED");
  // Receipt is an operator attestation, not a guarantee of provider billing accuracy.
  const today = new Date().toISOString().slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(env.EVAL_PRICE_REVIEW_DATE ?? "") ||
    env.EVAL_PRICE_REVIEW_DATE !== today
  )
    fail("PILOT_CURRENT_PRICE_REVIEW_REQUIRED");
  // Operator attestation is required in addition to the local estimate. It is
  // not independently verified by this script or proof of a provider hard cap.
  if (
    env.EVAL_BILLING_GUARD_SCOPE !== "all-model-paths" ||
    env.EVAL_BILLING_GUARD_REVIEW_DATE !== today ||
    !Number.isFinite(Number(env.EVAL_BILLING_GUARD_USD)) ||
    Number(env.EVAL_BILLING_GUARD_USD) <= 0 ||
    Number(env.EVAL_BILLING_GUARD_USD) > options.budgetUsd
  )
    fail("PILOT_BILLING_GUARD_REQUIRED");

  // One account-scoped marker, independent of which copy of a dataset is supplied.
  // On this host a restart, changed dataset path or concurrent launch cannot reset it.
  const ledgerRoot =
    dependencies.stateRoot ?? join(homedir(), ".local", "state", "resumatic");
  mkdirSync(ledgerRoot, { recursive: true, mode: 0o700 });
  const budgetMicros = Math.floor(options.budgetUsd * 1_000_000);
  const ledger = (dependencies.createLedger ?? createPilotLedger)(
    ledgerRoot,
    budgetMicros,
    options.maxCalls,
    extractionCalls,
  );
  const child = dependencies.spawn ?? spawnSync;
  // Never let inherited environment options enable recording, seeded evals, a different
  // dataset/environment, extra strategy, or a separate unbudgeted test file.
  const base = {
    ...env,
    EVAL_ENV: "staging",
    RECORD_MODE: "0",
    SEEDED_LIVE: "0",
    EXTRACT_LIVE: "1",
    EXTRACT_STRATEGY: options.strategy,
    EXTRACT_SPLIT: "dev",
    EXTRACT_REPEAT: "1",
    EVAL_BUDGET_LEDGER: ledger.file,
  };
  delete base.EXTRACT_DATASET_DIR;
  if (!options.synthetic) base.EXTRACT_DATASET_DIR = data.root;
  const invoke = (suite, allocation, file, pattern, selectedNames) => {
    const e = {
      ...base,
      EVAL_BUDGET_LEDGER_SUITE: suite,
      EVAL_BUDGET_USD: String(allocation.micros / 1_000_000),
      EVAL_MAX_CALLS: String(allocation.calls),
    };
    const reportFile = join(
      dirname(ledger.file),
      `first-staging-${suite}-vitest.json`,
    );
    const fd = openSync(
      reportFile,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    closeSync(fd);
    const result = child(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "--project",
        suite === "extraction" ? "extract-evals" : "evals",
        file,
        "--maxWorkers=1",
        "--no-file-parallelism",
        `--testNamePattern=${pattern}`,
        "--reporter=json",
        `--outputFile=${reportFile}`,
      ],
      { cwd: PROJECT, env: e, stdio: "ignore" },
    );
    if (result?.status !== 0) return false;
    try {
      const report = JSON.parse(readFileSync(reportFile, "utf8"));
      const assertions = report.testResults.flatMap(
        (row) => row.assertionResults,
      );
      const passed = assertions.filter((row) => row.status === "passed");
      return (
        report.numFailedTests === 0 &&
        passed.length === selectedNames.length &&
        selectedNames.every((name) =>
          passed.some(
            (row) =>
              typeof row.fullName === "string" && row.fullName.includes(name),
          ),
        )
      );
    } catch {
      return false;
    }
  };
  const extractionPattern = selectedCases.map((c) => c.id).join("|");
  const extraction = invoke(
    "extraction",
    ledger.extraction,
    "test/extract-evals/run.eval.ts",
    extractionPattern,
    selectedCases.map((c) => c.id),
  );
  const safe = finishPilotSuite(ledger.file, "extraction", extraction);
  const tailoring =
    safe &&
    invoke(
      "tailoring",
      ledger.tailoring,
      "test/evals/no-fabrication.eval.ts",
      TAILORING_CASE,
      [TAILORING_CASE],
    );
  const tailoringSafe =
    safe && finishPilotSuite(ledger.file, "tailoring", tailoring);
  return {
    status:
      extraction && tailoring && tailoringSafe ? "completed" : "incomplete",
    promotionEligible: false,
    profile: "exploratory-pilot",
    extractionCases: 1,
    tailoringCases: 1,
    budgetUsd: options.budgetUsd,
    maxCalls: options.maxCalls,
    allocations: { extraction: ledger.extraction, tailoring: ledger.tailoring },
  };
}

async function main() {
  const options = { live: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--live") options.live = true;
    else if (arg === "--synthetic") options.synthetic = true;
    else if (arg.startsWith("--private-dataset="))
      options.dataset = arg.slice("--private-dataset=".length);
    else if (arg.startsWith("--strategy="))
      options.strategy = arg.slice("--strategy=".length);
    else if (arg.startsWith("--budget-usd="))
      options.budgetUsd = Number(arg.slice("--budget-usd=".length));
    else if (arg.startsWith("--max-calls="))
      options.maxCalls = Number(arg.slice("--max-calls=".length));
    else fail("PILOT_ARGUMENT_INVALID");
  }
  const report = await runFirstStagingEvals(options);
  console.log(JSON.stringify(report));
  process.exitCode = report.status === "completed" ? 0 : 2;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "PILOT_PREFLIGHT_FAILED";
    console.error(message);
    process.exitCode = 2;
  });
}
