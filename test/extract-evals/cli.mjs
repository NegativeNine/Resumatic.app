import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Serialize CLI users in the canonical working directory. A killed parent or
// uncertain report write leaves the lock for an operator to investigate.
const workdir = realpathSync(process.cwd());
const lockPath = join(workdir, ".extract-report.lock");
try {
  mkdirSync(lockPath, { mode: 0o700 });
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
  process.stderr.write("Extraction report is locked; verify the prior process has stopped before recovery.\n");
  process.exit(2);
}
let safeToUnlock = false;
async function main() {
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
  // A shell value must not redirect this run's output to another location.
  delete environment.EXTRACT_REPORT_DIR;
  let promotionRun;
  let promotionRequested = false;
  let audit;
  let invalidArguments = false;
  function pendingReports(reason) {
    safeToUnlock = false;
    const directory = mkdtempSync(join(workdir, ".extract-report-"));
    try {
      const json = join(directory, "report.json");
      const markdown = join(directory, "report.md");
      writeFileSync(json, JSON.stringify({ status: "pending", reason, promotionEligible: false }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      writeFileSync(markdown, `# Extraction evaluation\n\nStatus: pending. Reason: ${reason}.\n`, { mode: 0o600, flag: "wx" });
      // The machine-readable report is authoritative if interrupted between renames.
      renameSync(json, "extract-report.json");
      renameSync(markdown, "extract-report.md");
      safeToUnlock = true;
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
    return 2;
  }
  if (promotionRequested) {
    pendingReports("promotion_not_completed");
    if (!environment.EXTRACT_DATASET_DIR || environment.EXTRACT_LIVE === "1") {
      process.stderr.write(
        "Promotion assessment requires a private dataset and cannot make model calls.\n",
      );
      return 2;
    }
    try {
      const { assessPromotion } = await import("./promotion.mjs");
      const report = assessPromotion(
        environment.EXTRACT_DATASET_DIR,
        promotionRun,
        audit,
      );
      safeToUnlock = false;
      const directory = mkdtempSync(join(workdir, ".extract-report-"));
      try {
        const file = join(directory, "report.json");
        writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        renameSync(file, "extract-report.json");
      } finally { rmSync(directory, { recursive: true, force: true }); }
      safeToUnlock = true;
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return report.winner ? 0 : 2;
    } catch {
      process.stderr.write(
        "Promotion evidence is invalid or unavailable. No model calls made.\n",
      );
      return 2;
    }
  }
  if (audit) {
    pendingReports("evaluation_invalid_arguments");
    process.stderr.write("An audit may be supplied only with --promote.\n");
    return 2;
  }

  if (environment.EXTRACT_LIVE === "1" && environment.EVAL_ENV && environment.EVAL_ENV !== "staging") {
    pendingReports("staging_environment_required");
    process.stderr.write("Live extraction through this CLI requires the staging environment. No calls made.\n");
    return 2;
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
    return 2;
  }
  // An early child startup or configuration failure must not leave an older
  // successful-looking report behind. Direct Vitest runs still need separate directories.
  pendingReports("evaluation_not_completed");
  safeToUnlock = false;
  const outputDir = mkdtempSync(join(workdir, ".extract-run-"));
  try {
    // Workers publish only to this unique directory. A worker surviving its
    // parent cannot later overwrite the shared reports of another run.
    environment.EXTRACT_REPORT_DIR = outputDir;
    const child = spawnSync(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", "--project", "extract-evals", "test/extract-evals/run.eval.ts"],
      { env: environment, stdio: "inherit" },
    );
    if (child.status !== 0) {
      try { pendingReports("evaluation_not_completed"); }
      finally {
        // An exited Vitest parent does not prove its workers have stopped,
        // even if publishing or cleaning up the pending marker failed.
        safeToUnlock = false;
      }
      return child.status ?? 1;
    }
    const jsonPath = join(outputDir, "extract-report.json");
    const markdownPath = join(outputDir, "extract-report.md");
    const jsonStat = lstatSync(jsonPath), markdownStat = lstatSync(markdownPath);
    if (!jsonStat.isFile() || !markdownStat.isFile() ||
        jsonStat.size > 64 * 1024 * 1024 || markdownStat.size > 1024 * 1024)
      throw new Error("evaluation_report_too_large");
    const json = readFileSync(jsonPath, "utf8");
    const markdown = readFileSync(markdownPath, "utf8");
    const report = JSON.parse(json);
    if (!report || typeof report !== "object" || Array.isArray(report) ||
        report.mode !== (environment.EXTRACT_LIVE === "1" ? "live" : "harness-self-check") ||
        report.promotionEligible !== false || !Array.isArray(report.cases) ||
        !markdown.startsWith("# Extraction evaluation\n"))
      throw new Error("evaluation_report_invalid");
    const publishDir = mkdtempSync(join(workdir, ".extract-report-"));
    try {
      const jsonFile = join(publishDir, "report.json"), markdownFile = join(publishDir, "report.md");
      writeFileSync(jsonFile, json, { mode: 0o600, flag: "wx" });
      writeFileSync(markdownFile, markdown, { mode: 0o600, flag: "wx" });
      renameSync(jsonFile, "extract-report.json");
      renameSync(markdownFile, "extract-report.md");
    } finally { rmSync(publishDir, { recursive: true, force: true }); }
  } finally { rmSync(outputDir, { recursive: true, force: true }); }
  safeToUnlock = true;
  return 0;
}
try {
  process.exitCode = await main();
} catch {
  process.stderr.write("Extraction evaluation did not complete; report may need recovery.\n");
  process.exitCode = 2;
} finally {
  if (safeToUnlock) rmdirSync(lockPath);
}
