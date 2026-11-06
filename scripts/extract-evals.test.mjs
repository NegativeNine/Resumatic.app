import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("../test/extract-evals/cli.mjs", import.meta.url));
const environment = () => ({ ...process.env, EXTRACT_LIVE: "1", RECORD_MODE: "1", RECORD_OUTPUT: "/synthetic/recording",
  CF_ACCOUNT_ID: "synthetic", CF_AI_TOKEN: "synthetic", EVAL_BUDGET_USD: "10", EVAL_MAX_CALLS: "50" });

test("the extraction CLI requires explicit --live even when a shell variable is inherited", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extract-cli-"));
  try {
    await mkdir(join(dir, "node_modules/vitest"), { recursive: true });
    // The child is a local stand-in; it cannot make provider calls.
    await writeFile(join(dir, "node_modules/vitest/vitest.mjs"), "process.stdout.write('mode=' + process.env.EXTRACT_LIVE + ',record=' + process.env.RECORD_MODE + ',output=' + (process.env.RECORD_OUTPUT ?? 'absent') + ',path=' + process.argv.at(-1));\n");
    const offline = spawnSync(process.execPath, [script], { cwd: dir, env: environment(), encoding: "utf8" });
    assert.equal(offline.status, 0);
    assert.equal(offline.stdout, "mode=0,record=0,output=absent,path=test/extract-evals/run.eval.ts");
    const live = spawnSync(process.execPath, [script, "--live"], { cwd: dir, env: environment(), encoding: "utf8" });
    assert.equal(live.status, 0);
    assert.equal(live.stdout, "mode=1,record=0,output=absent,path=test/extract-evals/run.eval.ts");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("startup failures replace both previous extraction reports with pending markers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extract-cli-"));
  try {
    await writeFile(join(dir, "extract-report.json"), '{"status":"passed"}');
    await writeFile(join(dir, "extract-report.md"), "previous success");
    // No Vitest child exists in this directory, so startup fails without I/O to providers.
    const failed = spawnSync(process.execPath, [script], { cwd: dir, env: environment(), encoding: "utf8" });
    assert.notEqual(failed.status, 0);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "extract-report.json"), "utf8")),
      { status: "pending", reason: "evaluation_not_completed", promotionEligible: false });
    assert.match(await readFile(join(dir, "extract-report.md"), "utf8"), /evaluation_not_completed/);
    const missing = spawnSync(process.execPath, [script, "--live"], { cwd: dir,
      env: { ...environment(), CF_AI_TOKEN: "" }, encoding: "utf8" });
    assert.equal(missing.status, 2);
    assert.equal(JSON.parse(await readFile(join(dir, "extract-report.json"), "utf8")).reason, "credentials_and_explicit_budget_required");
    assert.match(await readFile(join(dir, "extract-report.md"), "utf8"), /credentials_and_explicit_budget_required/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failed promotion cannot leave a stale successful assessment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extract-cli-"));
  try {
    await writeFile(join(dir, "extract-report.json"), '{"status":"passed"}');
    await writeFile(join(dir, "extract-report.md"), "previous success");
    const result = spawnSync(process.execPath, [script, "--private-dataset=/nonexistent", "--promote=bad"],
      { cwd: dir, env: environment(), encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "extract-report.json"), "utf8")),
      { status: "pending", reason: "promotion_not_completed", promotionEligible: false });
    assert.match(await readFile(join(dir, "extract-report.md"), "utf8"), /promotion_not_completed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("empty options and invalid promotion requests never fall through to a model runner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extract-cli-"));
  try {
    await mkdir(join(dir, "node_modules/vitest"), { recursive: true });
    await writeFile(join(dir, "node_modules/vitest/vitest.mjs"), "process.stdout.write('CHILD_STARTED');\n");
    for (const args of [
      ["--promote=", "--live"], ["--promote=abc", "--live"], ["--promote=abc"],
      ["--strategy="], ["--split="], ["--repeat="], ["--private-dataset="], ["--audit="],
    ]) {
      await writeFile(join(dir, "extract-report.json"), '{"status":"passed"}');
      const result = spawnSync(process.execPath, [script, ...args], { cwd: dir, env: environment(), encoding: "utf8" });
      assert.equal(result.status, 2, args.join(" "));
      assert.doesNotMatch(result.stdout, /CHILD_STARTED/);
      assert.equal(JSON.parse(await readFile(join(dir, "extract-report.json"), "utf8")).status, "pending");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a production environment cannot be selected by an inherited variable for a live extraction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extract-cli-"));
  try {
    await mkdir(join(dir, "node_modules/vitest"), { recursive: true });
    await writeFile(join(dir, "node_modules/vitest/vitest.mjs"), "process.stdout.write('CHILD_STARTED');\n");
    const result = spawnSync(process.execPath, [script, "--live"],
      { cwd: dir, env: { ...environment(), EVAL_ENV: "production" }, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout, /CHILD_STARTED/);
    assert.equal(JSON.parse(await readFile(join(dir, "extract-report.json"), "utf8")).reason, "staging_environment_required");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
