import { spawnSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const environment = { ...process.env };
// A stale shell variable must not turn an ordinary harness check into a paid
// model run. The budgeted pilot invokes Vitest directly and is unaffected.
environment.EXTRACT_LIVE = "0";
// Model recording is a separate explicitly invoked workflow. Do not let an
// inherited recording flag activate its live test in this evaluation run.
environment.RECORD_MODE = "0";
delete environment.RECORD_OUTPUT;
// The exploratory pilot invokes Vitest directly. Ordinary evaluations must
// retain zero-recall cases even if a pilot flag was inherited from a shell.
delete environment.PILOT_REQUIRE_EVIDENCE;
let promotionRun;
let promotionRequested = false;
let audit;
let invalidArguments = false;
function pendingReports(reason) {
  const directory = mkdtempSync(join(process.cwd(), ".extract-report-"));
  try {
    const json = join(directory, "report.json");
    const markdown = join(directory, "report.md");
    writeFileSync(json, JSON.stringify({ status: "pending", reason, promotionEligible: false }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    writeFileSync(markdown, `# Extraction evaluation\n\nStatus: pending. Reason: ${reason}.\n`, { mode: 0o600, flag: "wx" });
    // The machine-readable report is authoritative if interrupted between renames.
    renameSync(json, "extract-report.json");
    renameSync(markdown, "extract-report.md");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
for (const arg of process.argv.slice(2)) {
  if (arg === "--live") environment.EXTRACT_LIVE = "1";
  else if (arg.startsWith("--private-dataset=")) {
    environment.EXTRACT_DATASET_DIR = arg.slice("--private-dataset=".length);
    if (!environment.EXTRACT_DATASET_DIR) invalidArguments = true;
  } else if (arg.startsWith("--promote=")) {
    promotionRequested = true;
    promotionRun = arg.slice("--promote=".length);
    if (!promotionRun) invalidArguments = true;
  } else if (arg.startsWith("--audit=")) {
    audit = arg.slice("--audit=".length);
    if (!audit) invalidArguments = true;
  } else if (arg.startsWith("--strategy=")) {
    environment.EXTRACT_STRATEGY = arg.slice(11);
    if (!environment.EXTRACT_STRATEGY) invalidArguments = true;
  } else if (arg.startsWith("--split=")) {
    environment.EXTRACT_SPLIT = arg.slice(8);
    if (!["dev", "holdout"].includes(environment.EXTRACT_SPLIT)) invalidArguments = true;
  } else if (arg.startsWith("--repeat=")) {
    environment.EXTRACT_REPEAT = arg.slice(9);
    if (!/^(?:[1-9]|10)$/.test(environment.EXTRACT_REPEAT)) invalidArguments = true;
  } else invalidArguments = true;
}
if (invalidArguments) {
  pendingReports(promotionRequested ? "promotion_not_completed" : "evaluation_invalid_arguments");
  process.stderr.write("Use --live, --strategy=..., --split=dev|holdout, --repeat=1..10, --private-dataset=/absolute/path, or --promote=<run-id> [--audit=relative/path].\n");
  process.exit(2);
}
if (promotionRequested) {
  pendingReports("promotion_not_completed");
  if (!environment.EXTRACT_DATASET_DIR || environment.EXTRACT_LIVE === "1") {
    process.stderr.write(
      "Promotion assessment requires a private dataset and cannot make model calls.\n",
    );
    process.exit(2);
  }
  try {
    const { assessPromotion } = await import("./promotion.mjs");
    const report = assessPromotion(
      environment.EXTRACT_DATASET_DIR,
      promotionRun,
      audit,
    );
    writeFileSync(
      "extract-report.json",
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exit(report.winner ? 0 : 2);
  } catch {
    process.stderr.write(
      "Promotion evidence is invalid or unavailable. No model calls made.\n",
    );
    process.exit(2);
  }
}
if (audit) {
  pendingReports("evaluation_invalid_arguments");
  process.stderr.write("An audit may be supplied only with --promote.\n");
  process.exit(2);
}

if (environment.EXTRACT_LIVE === "1" && environment.EVAL_ENV && environment.EVAL_ENV !== "staging") {
  pendingReports("staging_environment_required");
  process.stderr.write("Live extraction through this CLI requires the staging environment. No calls made.\n");
  process.exit(2);
}
if (
  environment.EXTRACT_LIVE === "1" &&
  (!environment.CF_ACCOUNT_ID ||
    !environment.CF_AI_TOKEN ||
    !(Number(environment.EVAL_BUDGET_USD) > 0) ||
    !(Number(environment.EVAL_MAX_CALLS) >= 1))
) {
  pendingReports("credentials_and_explicit_budget_required");
  process.stderr.write(
    "Live extraction evaluation is pending credentials and an explicit EVAL_BUDGET_USD / EVAL_MAX_CALLS allowance. No calls made.\n",
  );
  process.exit(2);
}
// An early child startup or configuration failure must not leave an older
// successful-looking report behind. Concurrent runs need separate directories.
pendingReports("evaluation_not_completed");
const child = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "--project", "extract-evals", "test/extract-evals/run.eval.ts"],
  { env: environment, stdio: "inherit" },
);
process.exit(child.status ?? 1);
