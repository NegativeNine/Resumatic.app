import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const workdir = realpathSync(process.cwd());
const lockPath = join(workdir, ".seeded-report.lock");
try {
  mkdirSync(lockPath, { mode: 0o700 });
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
  process.stderr.write("Seeded report is locked; verify the prior process and its workers have stopped before recovery.\n");
  process.exit(2);
}
let safeToUnlock = false;

/** Replace generated reports without following existing output symlinks. */
function publish(json, markdown) {
  safeToUnlock = false;
  const directory = mkdtempSync(join(workdir, ".seeded-report-"));
  try {
    const jsonPath = join(directory, "report.json"), markdownPath = join(directory, "report.md");
    writeFileSync(jsonPath, json, { mode: 0o600, flag: "wx" });
    writeFileSync(markdownPath, markdown, { mode: 0o600, flag: "wx" });
    // The JSON report is authoritative between the two renames.
    renameSync(jsonPath, "seeded-report.json");
    renameSync(markdownPath, "seeded-report.md");
  } finally { rmSync(directory, { recursive: true, force: true }); }
  safeToUnlock = true;
}
function pendingReports(reason) {
  publish(JSON.stringify({ status: "pending", reason, promotionEligible: false }, null, 2) + "\n",
    `# Seeded fabrication evaluation\n\nStatus: pending. Reason: ${reason}.\n`);
}

function main() {
  // Inherited settings do not make model calls or choose a report destination.
  const environment = { ...process.env, SEEDED_LIVE: "0" };
  delete environment.SEEDED_REPORT_DIR;
  delete environment.SEEDED_REPEAT;
  let invalid = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--live") environment.SEEDED_LIVE = "1";
    else if (arg.startsWith("--repeat=")) environment.SEEDED_REPEAT = arg.slice(9);
    else invalid = true;
  }
  const repeats = Number(environment.SEEDED_REPEAT || 1);
  if (invalid || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10 ||
      process.argv.slice(2).some((arg) => arg === "--repeat=")) {
    pendingReports("evaluation_invalid_arguments");
    process.stderr.write("Usage: node scripts/seeded-evals.mjs [--live] [--repeat=1..10]\n");
    return 2;
  }
  if (environment.SEEDED_LIVE === "1" && environment.EVAL_ENV && environment.EVAL_ENV !== "staging") {
    pendingReports("staging_environment_required");
    process.stderr.write("Live seeded evaluation requires the staging environment. No calls made.\n");
    return 2;
  }
  if (environment.SEEDED_LIVE === "1" &&
      (!environment.CF_ACCOUNT_ID || !environment.CF_AI_TOKEN ||
        !Number.isFinite(Number(environment.EVAL_BUDGET_USD)) || Number(environment.EVAL_BUDGET_USD) <= 0 ||
        !Number.isSafeInteger(Number(environment.EVAL_MAX_CALLS)) || Number(environment.EVAL_MAX_CALLS) < 1)) {
    pendingReports("credentials_and_explicit_budget_required");
    process.stderr.write("Live seeded evaluation is pending credentials, EVAL_BUDGET_USD and EVAL_MAX_CALLS. No calls made.\n");
    return 2;
  }
  pendingReports("evaluation_not_completed");
  safeToUnlock = false;
  const outputDir = mkdtempSync(join(workdir, ".seeded-run-"));
  try {
    environment.SEEDED_REPORT_DIR = outputDir;
    const child = spawnSync(process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", "--project", "evals", "test/evals/seeded.eval.ts"],
      { stdio: "inherit", env: environment });
    if (child.status !== 0) {
      try { pendingReports("evaluation_not_completed"); }
      finally { safeToUnlock = false; } // An exited parent does not prove all workers stopped.
      return child.status ?? 1;
    }
    const jsonPath = join(outputDir, "seeded-report.json"), markdownPath = join(outputDir, "seeded-report.md");
    const jsonStat = lstatSync(jsonPath), markdownStat = lstatSync(markdownPath);
    if (!jsonStat.isFile() || !markdownStat.isFile() || jsonStat.size > 64 * 1024 * 1024 || markdownStat.size > 1024 * 1024)
      throw new Error("invalid report");
    const json = readFileSync(jsonPath, "utf8"), markdown = readFileSync(markdownPath, "utf8");
    const report = JSON.parse(json);
    if (!report || typeof report !== "object" || Array.isArray(report) ||
        report.mode !== (environment.SEEDED_LIVE === "1" ? "live" : "harness-self-check") ||
        report.promotionEligible !== false || !Array.isArray(report.seeds) || !Array.isArray(report.cases) ||
        !markdown.startsWith("# Seeded fabrication evaluation\n")) throw new Error("invalid report");
    publish(json, markdown);
  } finally {
    safeToUnlock = false;
    rmSync(outputDir, { recursive: true, force: true });
  }
  safeToUnlock = true;
  return 0;
}
try {
  process.exitCode = main();
} catch {
  process.stderr.write("Seeded evaluation did not complete; report may need recovery.\n");
  process.exitCode = 2;
} finally {
  if (safeToUnlock) rmdirSync(lockPath);
}
