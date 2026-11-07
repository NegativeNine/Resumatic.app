import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("manual staging E2E stops before network work until shared spend safety is verified", async () => {
  const dir = await mkdtemp(join(tmpdir(), "e2e-spend-guard-"));
  try {
    await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify({
      name: "synthetic",
      env: { staging: { vars: { ALLOW_TEST_SIGNIN: "true", DAILY_SPEND_CAP_USD: "1" } } },
    }));
    const marker = join(dir, "network-called");
    const hook = join(dir, "intercept.mjs");
    await writeFile(hook, `import { writeFileSync } from "node:fs";\nglobalThis.fetch = async () => { writeFileSync(${JSON.stringify(marker)}, "called"); throw new Error("unexpected network call"); };\n`);
    const script = fileURLToPath(new URL("./e2e-staging.mjs", import.meta.url));
    const key = "synthetic-test-signin-key-not-a-secret";
    for (const [usd, calls] of [["10", "50"], ["999", "999"]]) {
      const run = spawnSync(process.execPath, ["--import", hook, script], {
        cwd: dir,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          STAGING_URL: "https://staging.example",
          TEST_SIGNIN_KEY: key,
          EVAL_BUDGET_USD: usd,
          EVAL_MAX_CALLS: calls,
          STAGING_E2E_SPEND_SAFETY_VERIFIED: "true",
          PILOT_SHARED_BUDGET: "true",
        },
      });
      assert.equal(run.status, 2);
      assert.equal(existsSync(marker), false);
      const report = JSON.parse(await readFile(join(dir, "e2e-report.json"), "utf8"));
      assert.equal(report.status, "pending");
      assert.deepEqual(report.missing, ["STAGING_E2E_SPEND_SAFETY_UNVERIFIED"]);
      assert.doesNotMatch(run.stdout + run.stderr, new RegExp(key));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
