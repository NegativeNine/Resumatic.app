import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

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
if (
  environment.SEEDED_LIVE === "1" &&
  (!environment.CF_ACCOUNT_ID ||
    !environment.CF_AI_TOKEN ||
    !Number.isFinite(Number(environment.EVAL_BUDGET_USD)) ||
    Number(environment.EVAL_BUDGET_USD) <= 0 ||
    !Number.isSafeInteger(Number(environment.EVAL_MAX_CALLS)) ||
    Number(environment.EVAL_MAX_CALLS) < 1)
) {
  writeFileSync(
    "seeded-report.json",
    JSON.stringify(
      {
        status: "pending",
        reason: "credentials_and_explicit_budget_required",
        promotionEligible: false,
      },
      null,
      2,
    ),
  );
  process.stderr.write(
    "Live seeded evaluation is pending credentials, EVAL_BUDGET_USD and EVAL_MAX_CALLS. No calls made.\n",
  );
  process.exit(2);
}
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
