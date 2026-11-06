import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("paid CI stays blocked before both live model entry points", () => {
  const result = spawnSync(process.execPath, ["scripts/ci-paid-budget-guard.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, EVAL_BUDGET_USD: "10", EVAL_MAX_CALLS: "50" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /pending shared budget accounting/);
  for (const [file, command] of [
    [".github/workflows/evals.yml", "npm run evals"],
    [".github/workflows/ci.yml", "npm run e2e:staging"],
  ]) {
    const yaml = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const guard = yaml.indexOf("run: node scripts/ci-paid-budget-guard.mjs");
    const entry = yaml.indexOf(`run: ${command}`);
    assert.ok(guard >= 0 && entry > guard, `${file} must guard its live entry point`);
  }
});
