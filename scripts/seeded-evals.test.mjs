import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

test("an invalid command leaves prior reports untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seeded-invalid-"));
  try {
    await writeFile(join(dir, "seeded-report.json"), old);
    await writeFile(join(dir, "seeded-report.md"), old);
    for (const arg of ["--invalid", "--repeat=0", "--repeat=2.5", "--repeat=11"]) {
      assert.equal(run(dir, [arg]).status, 2);
      assert.equal(await readFile(join(dir, "seeded-report.json"), "utf8"), old);
      assert.equal(await readFile(join(dir, "seeded-report.md"), "utf8"), old);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
