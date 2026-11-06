import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./seeded-evals.mjs", import.meta.url));
const run = (cwd, args) => spawnSync(process.execPath, [script, ...args], {
  cwd,
  encoding: "utf8",
  env: { PATH: process.env.PATH ?? "", CF_ACCOUNT_ID: "", CF_AI_TOKEN: "", EVAL_BUDGET_USD: "", EVAL_MAX_CALLS: "" },
});
const old = "prior successful report";
async function waitFor(path) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch { /* Child has not reached the checkpoint. */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("checkpoint timed out");
}

test("a child startup failure leaves both generated reports pending and private", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seeded-startup-"));
  try {
    const protectedFile = join(dir, "user-document");
    await writeFile(protectedFile, "do not alter");
    await symlink(protectedFile, join(dir, "seeded-report.json"));
    await writeFile(join(dir, "seeded-report.md"), old);
    // There is deliberately no node_modules in this temporary working directory.
    const result = run(dir, []);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(protectedFile, "utf8"), "do not alter");
    const report = JSON.parse(await readFile(join(dir, "seeded-report.json"), "utf8"));
    assert.deepEqual(report, { status: "pending", reason: "evaluation_not_completed", promotionEligible: false });
    assert.match(await readFile(join(dir, "seeded-report.md"), "utf8"), /Status: pending/);
    for (const name of ["seeded-report.json", "seeded-report.md"])
      assert.equal((await stat(join(dir, name))).mode & 0o077, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing credentials invalidate both old reports before returning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seeded-credentials-"));
  try {
    await writeFile(join(dir, "seeded-report.json"), old);
    await writeFile(join(dir, "seeded-report.md"), old);
    const result = run(dir, ["--live"]);
    assert.equal(result.status, 2);
    assert.match(await readFile(join(dir, "seeded-report.md"), "utf8"), /credentials_and_explicit_budget_required/);
    const report = JSON.parse(await readFile(join(dir, "seeded-report.json"), "utf8"));
    assert.equal(report.reason, "credentials_and_explicit_budget_required");
    assert.equal(report.promotionEligible, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("machine-readable report is invalidated before a Markdown rename failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seeded-rename-"));
  try {
    await writeFile(join(dir, "seeded-report.json"), old);
    await writeFile(join(dir, "seeded-report.md"), old);
    const hook = join(dir, "rename-hook.mjs");
    await writeFile(hook, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const rename = fs.renameSync; fs.renameSync = (from, to) => { if (to === "seeded-report.md") throw new Error("synthetic failure"); return rename(from, to); }; syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, ["--import", hook, script], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(await readFile(join(dir, "seeded-report.json"), "utf8")).status, "pending");
    assert.equal(await readFile(join(dir, "seeded-report.md"), "utf8"), old);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an invalid command replaces prior reports with a pending marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seeded-invalid-"));
  try {
    await writeFile(join(dir, "seeded-report.json"), old);
    await writeFile(join(dir, "seeded-report.md"), old);
    for (const arg of ["--invalid", "--repeat=", "--repeat=0", "--repeat=2.5", "--repeat=11"]) {
      assert.equal(run(dir, [arg]).status, 2);
      assert.equal(JSON.parse(await readFile(join(dir, "seeded-report.json"), "utf8")).reason, "evaluation_invalid_arguments");
      assert.match(await readFile(join(dir, "seeded-report.md"), "utf8"), /evaluation_invalid_arguments/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("live evaluation rejects an inherited production environment before starting a child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seeded-production-"));
  try {
    const result = spawnSync(process.execPath, [script, "--live"], { cwd: dir, encoding: "utf8", env: {
      PATH: process.env.PATH ?? "", EVAL_ENV: "production", CF_ACCOUNT_ID: "synthetic", CF_AI_TOKEN: "synthetic",
      EVAL_BUDGET_USD: "10", EVAL_MAX_CALLS: "50",
    } });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(await readFile(join(dir, "seeded-report.json"), "utf8")).reason, "staging_environment_required");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an inherited live flag and repeat count cannot change an offline run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seeded-inherited-"));
  try {
    await mkdir(join(dir, "node_modules/vitest"), { recursive: true });
    await writeFile(join(dir, "node_modules/vitest/vitest.mjs"), `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync("observed", JSON.stringify({live: process.env.SEEDED_LIVE, repeat: process.env.SEEDED_REPEAT ?? null}));
writeFileSync(join(process.env.SEEDED_REPORT_DIR, "seeded-report.json"), JSON.stringify({mode:"harness-self-check", promotionEligible:false, seeds:[], cases:[]}));
writeFileSync(join(process.env.SEEDED_REPORT_DIR, "seeded-report.md"), "# Seeded fabrication evaluation\\n");
`);
    const env = { PATH: process.env.PATH ?? "", SEEDED_LIVE: "1", SEEDED_REPEAT: "10" };
    assert.equal(spawnSync(process.execPath, [script], { cwd: dir, env }).status, 0);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "observed"), "utf8")), { live: "0", repeat: null });
    assert.equal(spawnSync(process.execPath, [script, "--repeat=2"], { cwd: dir, env }).status, 0);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "observed"), "utf8")), { live: "0", repeat: "2" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failed child and a later worker cannot overwrite the pending shared report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seeded-worker-"));
  try {
    await mkdir(join(dir, "node_modules/vitest"), { recursive: true });
    await writeFile(join(dir, "worker.mjs"), `import { writeFileSync } from "node:fs"; setTimeout(() => { try { writeFileSync(process.argv[2] + "/seeded-report.json", '{"status":"passed"}'); } catch {} writeFileSync("worker-done", ""); }, 200);`);
    await writeFile(join(dir, "node_modules/vitest/vitest.mjs"), `import { spawn } from "node:child_process"; const p = spawn(process.execPath, ["worker.mjs", process.env.SEEDED_REPORT_DIR], { detached: true, stdio: "ignore" }); p.unref(); process.exit(1);`);
    const result = run(dir, []);
    assert.equal(result.status, 1);
    await waitFor(join(dir, "worker-done"));
    assert.equal(JSON.parse(await readFile(join(dir, "seeded-report.json"), "utf8")).reason, "evaluation_not_completed");
    await access(join(dir, ".seeded-report.lock"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("overlapping seeded runs cannot replace the active report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seeded-overlap-"));
  let first;
  try {
    await mkdir(join(dir, "node_modules/vitest"), { recursive: true });
    await writeFile(join(dir, "node_modules/vitest/vitest.mjs"), `import { existsSync, writeFileSync } from "node:fs"; writeFileSync("started", ""); const t=setInterval(() => { if (!existsSync("release")) return; clearInterval(t); writeFileSync("child-done", ""); }, 20);`);
    first = spawn(process.execPath, [script], { cwd: dir, stdio: "ignore", env: { PATH: process.env.PATH ?? "" } });
    const exited = once(first, "exit");
    await waitFor(join(dir, "started"));
    const overlap = run(dir, []);
    assert.equal(overlap.status, 2);
    assert.match(overlap.stderr, /locked/);
    first.kill("SIGKILL");
    await exited;
    assert.equal(run(dir, []).status, 2);
    await writeFile(join(dir, "release"), "");
    await waitFor(join(dir, "child-done"));
    assert.equal(JSON.parse(await readFile(join(dir, "seeded-report.json"), "utf8")).reason, "evaluation_not_completed");
  } finally {
    first?.kill("SIGKILL");
    await writeFile(join(dir, "release"), "").catch(() => {});
    if (await access(join(dir, "started")).then(() => true, () => false)) await waitFor(join(dir, "child-done")).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
