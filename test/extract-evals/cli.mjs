import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const environment = { ...process.env };
// The exploratory pilot invokes Vitest directly. Ordinary evaluations must
// retain zero-recall cases even if a pilot flag was inherited from a shell.
delete environment.PILOT_REQUIRE_EVIDENCE;
let promotionRun;
let audit;
for (const arg of process.argv.slice(2)) {
  if (arg === "--live") environment.EXTRACT_LIVE = "1";
  else if (arg.startsWith("--private-dataset="))
    environment.EXTRACT_DATASET_DIR = arg.slice("--private-dataset=".length);
  else if (arg.startsWith("--promote="))
    promotionRun = arg.slice("--promote=".length);
  else if (arg.startsWith("--audit=")) audit = arg.slice("--audit=".length);
  else if (arg.startsWith("--strategy="))
    environment.EXTRACT_STRATEGY = arg.slice(11);
  else if (arg.startsWith("--split=")) environment.EXTRACT_SPLIT = arg.slice(8);
  else if (arg.startsWith("--repeat="))
    environment.EXTRACT_REPEAT = arg.slice(9);
  else {
    process.stderr.write(
      "Use --live, --strategy=..., --split=dev|holdout, --repeat=1..10, --private-dataset=/absolute/path, or --promote=<run-id> [--audit=relative/path].\n",
    );
    process.exit(2);
  }
}
if (promotionRun) {
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
  process.stderr.write("An audit may be supplied only with --promote.\n");
  process.exit(2);
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
