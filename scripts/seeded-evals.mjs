import { spawnSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Replace generated reports without following an existing output symlink. */
function pendingReports(reason) {
  const directory = mkdtempSync(join(process.cwd(), ".seeded-report-"));
  try {
    const json = join(directory, "report.json");
    const markdown = join(directory, "report.md");
    writeFileSync(json, JSON.stringify({ status: "pending", reason, promotionEligible: false }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    writeFileSync(markdown, `# Seeded fabrication evaluation\n\nStatus: pending. Reason: ${reason}.\n`, { mode: 0o600, flag: "wx" });
    renameSync(json, "seeded-report.json");
    renameSync(markdown, "seeded-report.md");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const environment = { ...process.env, SEEDED_LIVE: "0" };
for (const arg of process.argv.slice(2)) {
  if (arg === "--live") environment.SEEDED_LIVE = "1";
  else if (arg.startsWith("--repeat="))
    environment.SEEDED_REPEAT = arg.slice(9);
  else {
    process.stderr.write(
      "Usage: node scripts/seeded-evals.mjs [--live] [--repeat=1..10]\n",
    );
    process.exit(2);
  }
}
const repeats = Number(environment.SEEDED_REPEAT || 1);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10) {
  process.stderr.write("Usage: node scripts/seeded-evals.mjs [--live] [--repeat=1..10]\n");
  process.exit(2);
}
if (
  environment.SEEDED_LIVE === "1" &&
  (!environment.CF_ACCOUNT_ID ||
    !environment.CF_AI_TOKEN ||
    !Number.isFinite(Number(environment.EVAL_BUDGET_USD)) ||
    Number(environment.EVAL_BUDGET_USD) <= 0 ||
    !Number.isSafeInteger(Number(environment.EVAL_MAX_CALLS)) ||
    Number(environment.EVAL_MAX_CALLS) < 1)
) {
  pendingReports("credentials_and_explicit_budget_required");
  process.stderr.write(
    "Live seeded evaluation is pending credentials, EVAL_BUDGET_USD and EVAL_MAX_CALLS. No calls made.\n",
  );
  process.exit(2);
}
// Invalidate prior results before the child can fail during initialization.
// afterAll replaces these only when this run reaches report generation.
pendingReports("evaluation_not_completed");
const child = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--project",
    "evals",
    "test/evals/seeded.eval.ts",
  ],
  { stdio: "inherit", env: environment },
);
process.exit(child.status ?? 1);
