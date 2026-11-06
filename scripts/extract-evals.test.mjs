import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const script = fileURLToPath(new URL("../test/extract-evals/cli.mjs", import.meta.url));
const environment = () => ({ ...process.env, EXTRACT_LIVE: "1", RECORD_MODE: "1", RECORD_OUTPUT: "/synthetic/recording",
  EXTRACT_REPORT_DIR: "/synthetic/untrusted-output", CF_ACCOUNT_ID: "synthetic", CF_AI_TOKEN: "synthetic", EVAL_BUDGET_USD: "10", EVAL_MAX_CALLS: "50" });

const fakeReport = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.EXTRACT_REPORT_DIR, 'extract-report.json'), JSON.stringify({mode: process.env.EXTRACT_LIVE === '1' ? 'live' : 'harness-self-check', promotionEligible: false, cases: []}));
writeFileSync(join(process.env.EXTRACT_REPORT_DIR, 'extract-report.md'), '# Extraction evaluation\\n\\nSynthetic report.\\n');
`;

async function waitFor(path) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch { /* Child has not reached the checkpoint. */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("checkpoint timed out");
}

test("the extraction CLI requires explicit --live even when a shell variable is inherited", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extract-cli-"));
  try {
    await mkdir(join(dir, "node_modules/vitest"), { recursive: true });
    // The child is a local stand-in; it cannot make provider calls.
    await writeFile(join(dir, "node_modules/vitest/vitest.mjs"), fakeReport + "process.stdout.write('mode=' + process.env.EXTRACT_LIVE + ',record=' + process.env.RECORD_MODE + ',output=' + (process.env.RECORD_OUTPUT ?? 'absent') + ',path=' + process.argv.at(-1));\n");
    const offline = spawnSync(process.execPath, [script], { cwd: dir, env: environment(), encoding: "utf8" });
    assert.equal(offline.status, 0);
    assert.equal(offline.stdout, "mode=0,record=0,output=absent,path=test/extract-evals/run.eval.ts");
    assert.equal(JSON.parse(await readFile(join(dir, "extract-report.json"), "utf8")).mode, "harness-self-check");
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
    // The failed child may have left workers behind; recover only after the
    // operator has independently confirmed that they stopped.
    await rm(join(dir, ".extract-report.lock"), { recursive: true });
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

test("a failing evaluation child cannot leave its partial report as a successful result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extract-cli-"));
  try {
    await mkdir(join(dir, "node_modules/vitest"), { recursive: true });
    await writeFile(join(dir, "node_modules/vitest/vitest.mjs"),
      `import { writeFileSync } from "node:fs"; import { join } from "node:path"; writeFileSync(join(process.env.EXTRACT_REPORT_DIR, "extract-report.json"), '{"status":"passed"}'); process.exit(1);`);
    const result = spawnSync(process.execPath, [script], { cwd: dir, env: environment(), encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "extract-report.json"), "utf8")),
      { status: "pending", reason: "evaluation_not_completed", promotionEligible: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a surviving worker cannot overwrite the shared report after its Vitest parent exits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extract-cli-"));
  try {
    await mkdir(join(dir, "node_modules/vitest"), { recursive: true });
    await writeFile(join(dir, "node_modules/vitest/vitest.mjs"), `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['node_modules/vitest/late-worker.mjs', process.env.EXTRACT_REPORT_DIR], { stdio: 'ignore' });
child.unref();
process.exit(1);
`);
    await writeFile(join(dir, "node_modules/vitest/late-worker.mjs"), `
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync('worker-started', '');
const timer = setInterval(() => {
  if (!existsSync('release-worker')) return;
  clearInterval(timer);
  mkdirSync(process.argv[2], { recursive: true });
  writeFileSync(join(process.argv[2], 'extract-report.json'), JSON.stringify({status:'passed'}));
  writeFileSync('worker-finished', '');
}, 20);
`);
    const result = spawnSync(process.execPath, [script], { cwd: dir, env: environment(), encoding: "utf8" });
    assert.equal(result.status, 1);
    await access(join(dir, ".extract-report.lock"));
    await waitFor(join(dir, "worker-started"));
    await writeFile(join(dir, "release-worker"), "");
    await waitFor(join(dir, "worker-finished"));
    assert.deepEqual(JSON.parse(await readFile(join(dir, "extract-report.json"), "utf8")),
      { status: "pending", reason: "evaluation_not_completed", promotionEligible: false });
  } finally {
    await writeFile(join(dir, "release-worker"), "").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed pending-marker cleanup does not unlock after a child failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extract-cli-"));
  try {
    await mkdir(join(dir, "node_modules/vitest"), { recursive: true });
    await writeFile(join(dir, "node_modules/vitest/vitest.mjs"), "process.exit(1);\n");
    const preload = join(dir, "fail-cleanup.mjs");
    await writeFile(preload, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
let calls = 0;
const original = fs.rmSync;
fs.rmSync = function(path, options) {
  if (String(path).includes('.extract-report-') && ++calls === 2) throw new Error('synthetic cleanup failure');
  return original.call(this, path, options);
};
syncBuiltinESMExports();
`);
    const result = spawnSync(process.execPath, [script], { cwd: dir,
      env: { ...environment(), NODE_OPTIONS: `--import=${preload}` }, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    await access(join(dir, ".extract-report.lock"));
    assert.equal(JSON.parse(await readFile(join(dir, "extract-report.json"), "utf8")).status, "pending");
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

test("overlapping runs and an interrupted parent retain the report lock until the child has stopped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extract-cli-"));
  let first;
  try {
    await mkdir(join(dir, "node_modules/vitest"), { recursive: true });
    await writeFile(join(dir, "node_modules/vitest/vitest.mjs"), `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync("started", "");
const timer = setInterval(() => {
  if (!existsSync("release")) return;
  clearInterval(timer);
  writeFileSync(join(process.env.EXTRACT_REPORT_DIR, 'extract-report.json'), JSON.stringify({mode:'harness-self-check', promotionEligible:false, cases:[]}));
  writeFileSync(join(process.env.EXTRACT_REPORT_DIR, 'extract-report.md'), '# Extraction evaluation\\n\\nSynthetic report.\\n');
  writeFileSync("child-finished", "");
}, 20);
`);
    first = spawn(process.execPath, [script], { cwd: dir, env: environment(), stdio: "ignore" });
    const exited = once(first, "exit");
    await waitFor(join(dir, "started"));
    const overlap = spawnSync(process.execPath, [script], { cwd: dir, env: environment(), encoding: "utf8" });
    assert.equal(overlap.status, 2);
    assert.match(overlap.stderr, /locked/);
    assert.equal(JSON.parse(await readFile(join(dir, "extract-report.json"), "utf8")).status, "pending");
    first.kill("SIGKILL");
    await exited;
    const interrupted = spawnSync(process.execPath, [script], { cwd: dir, env: environment(), encoding: "utf8" });
    assert.equal(interrupted.status, 2);
    assert.match(interrupted.stderr, /locked/);
    await writeFile(join(dir, "release"), "");
    await waitFor(join(dir, "child-finished"));
    await rm(join(dir, ".extract-report.lock"), { recursive: true });
    const recovered = spawnSync(process.execPath, [script], { cwd: dir, env: environment(), encoding: "utf8" });
    assert.equal(recovered.status, 0);
  } finally {
    first?.kill("SIGKILL");
    await writeFile(join(dir, "release"), "").catch(() => {});
    if (await access(join(dir, "started")).then(() => true, () => false))
      await waitFor(join(dir, "child-finished")).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
