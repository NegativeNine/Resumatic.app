import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const live = args.includes("--live");
const output = args.find((a) => a.startsWith("--output="))?.slice(9);
if (args.some((a) => a !== "--live" && !a.startsWith("--output="))) {
  process.stderr.write(
    "Usage: node scripts/record-models.mjs [--live --output=directory]\n",
  );
  process.exit(2);
}
if (
  live &&
  (!output ||
    !process.env.CF_ACCOUNT_ID ||
    !process.env.CF_AI_TOKEN ||
    !(Number(process.env.EVAL_BUDGET_USD) > 0) ||
    !Number.isSafeInteger(Number(process.env.EVAL_MAX_CALLS)) ||
    Number(process.env.EVAL_MAX_CALLS) < 1)
) {
  process.stderr.write(
    "Live recording is pending an output directory, credentials and EVAL_BUDGET_USD / EVAL_MAX_CALLS. No calls made.\n",
  );
  process.exit(2);
}
const testArgs = live
  ? ["--project", "extract-evals", "test/extract-evals/record.eval.ts"]
  : ["--project", "unit", "test/unit/replay.test.ts"];
const child = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", ...testArgs],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      RECORD_MODE: live ? "1" : "0",
      RECORD_OUTPUT: output ?? "",
    },
  },
);
process.exit(child.status ?? 1);
