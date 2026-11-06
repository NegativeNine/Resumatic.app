import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const environment = { ...process.env };
for (const arg of process.argv.slice(2)) {
  if (arg === "--live") environment.EXTRACT_LIVE = "1";
  else if (arg.startsWith("--strategy="))
    environment.EXTRACT_STRATEGY = arg.slice(11);
  else if (arg.startsWith("--split=")) environment.EXTRACT_SPLIT = arg.slice(8);
  else if (arg.startsWith("--repeat="))
    environment.EXTRACT_REPEAT = arg.slice(9);
  else {
    process.stderr.write(
      "Use --live, --strategy=..., --split=dev|holdout, --repeat=1..10.\n",
    );
    process.exit(2);
  }
}
if (
  environment.EXTRACT_LIVE === "1" &&
  (!environment.CF_ACCOUNT_ID ||
    !environment.CF_AI_TOKEN ||
    !(Number(environment.EVAL_BUDGET_USD) > 0) ||
    !(Number(environment.EVAL_MAX_CALLS) >= 1))
) {
  writeFileSync(
    "extract-report.json",
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
    "Live extraction evaluation is pending credentials and an explicit EVAL_BUDGET_USD / EVAL_MAX_CALLS allowance. No calls made.\n",
  );
  process.exit(2);
}
const child = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "--project", "extract-evals"],
  { env: environment, stdio: "inherit" },
);
process.exit(child.status ?? 1);
