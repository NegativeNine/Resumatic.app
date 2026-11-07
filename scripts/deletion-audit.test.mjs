import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { deletionProbeInput, preDeletionInventory, workflowCoverage, workflowInventoryAuditCapability } from "./lib/deletion-audit.mjs";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const manifest = () => ({
  base: "https://staging.example",
  vaultId: "a".repeat(64),
  userId: id(9),
  deletionRequested: true,
  sources: [id(1)],
  resumes: [id(2)],
  runs: [
    { id: id(1), targetId: id(1), kind: "distill" },
    { id: id(3), targetId: id(1), kind: "distill" },
    { id: id(2), targetId: id(2), kind: "tailor" },
    { id: id(4), targetId: id(4), kind: "embed" },
  ],
});
test("probe includes superseded workflow attempts and excludes local embedding calls", () => {
  const input = deletionProbeInput(manifest(), "https://staging.example");
  assert.deepEqual(workflowInventoryAuditCapability(), {
    scope: "supplied_ids_only",
    complete: false,
  });
  assert.deepEqual(input.sources, [id(1), id(3)]);
  assert.deepEqual(input.resumes, [id(2)]);
  assert.deepEqual(
    workflowCoverage(
      { scope: "supplied_ids_only", checked: 3, complete: false },
      input,
    ),
    { scope: "supplied_ids_only", checked: 3, complete: false },
  );
});
test("missing, truncated, incomplete or forged inventory cannot pass validation", () => {
  for (const modify of [
    (m) => {
      m.sources = [];
    },
    (m) => {
      m.resumes = [];
    },
    (m) => {
      m.runs = [];
    },
    (m) => {
      m.runs = m.runs.slice(0, 2);
    },
    (m) => {
      m.runs.push(m.runs[0]);
    },
    (m) => {
      m.runs[0].kind = "unknown";
    },
    (m) => {
      m.runs = Array.from({ length: 100 }, (_, i) => ({
        id: id(i),
        targetId: id(i),
        kind: "distill",
      }));
    },
  ]) {
    const m = manifest();
    modify(m);
    assert.throws(() => deletionProbeInput(m, "https://staging.example"));
  }
  const input = deletionProbeInput(manifest(), "https://staging.example");
  assert.throws(() =>
    workflowCoverage(
      { scope: "supplied_ids_only", checked: 3, complete: true },
      input,
    ),
  );
  assert.throws(() =>
    workflowCoverage(
      { scope: "supplied_ids_only", checked: 2, complete: false },
      input,
    ),
  );
});
test("pre-deletion snapshot requires valid ledger rows for both created targets", () => {
  const m = manifest();
  const rows = m.runs.map((r) => ({ ...r, privateDetail: "omitted" }));
  m.deletionRequested = false;
  m.runs = [];
  const result = preDeletionInventory(m, { runs: rows }, m.base);
  assert.deepEqual(result, manifest().runs);
  assert.equal(m.deletionRequested, false);
  for (const runs of [[], rows.slice(0, 2), [null], [rows[0], rows[0]], Array(100).fill(rows[0])]) {
    assert.throws(() => preDeletionInventory(m, { runs }, m.base));
  }
  assert.throws(() => preDeletionInventory(m, {}, m.base));
});
test("a killed audit leaves a pending report, not an earlier result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deletion-audit-interrupted-"));
  try {
    const body = manifest();
    await writeFile(join(dir, "manifest.json"), JSON.stringify(body));
    await writeFile(join(dir, "report.json"), JSON.stringify({ status: "passed" }));
    // Model a process disappearing during its first probe, after confirming
    // the pending marker was already visible before the network call.
    await writeFile(join(dir, "fetch.mjs"), `import { readFileSync } from 'node:fs';
globalThis.fetch = async () => {
  const report = JSON.parse(readFileSync('report.json', 'utf8'));
  process.exit(report.status === 'pending' && report.reasons[0] === 'AUDIT_IN_PROGRESS' ? 37 : 38);
};`);
    const script = fileURLToPath(new URL("./audit-deletion.mjs", import.meta.url));
    const child = spawnSync(process.execPath, ["--import", join(dir, "fetch.mjs"), script,
      "--manifest", join(dir, "manifest.json"), "--report", join(dir, "report.json")], {
      cwd: dir,
      env: { ...process.env, STAGING_URL: body.base, ACCESS_CLIENT_ID: "test", ACCESS_CLIENT_SECRET: "test" },
      encoding: "utf8",
    });
    assert.equal(child.status, 37, child.stderr);
    const report = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
    assert.equal(report.status, "pending");
    assert.deepEqual(report.reasons, ["AUDIT_IN_PROGRESS"]);
    assert.equal((await stat(join(dir, "report.json"))).mode & 0o777, 0o600);
    const blocked = spawnSync(process.execPath, ["--import", join(dir, "fetch.mjs"), script,
      "--manifest", join(dir, "manifest.json"), "--report", join(dir, "report.json")], {
      cwd: dir,
      env: { ...process.env, STAGING_URL: body.base, ACCESS_CLIENT_ID: "test", ACCESS_CLIENT_SECRET: "test" },
      encoding: "utf8",
    });
    assert.notEqual(blocked.status, 37, "a second run must not reach the probe");
    assert.match(blocked.stderr, /EEXIST/);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "report.json"), "utf8")), report);
    // Once the operator knows the previous process is gone, removing the
    // retained lock allows a fresh audit with a fresh pending marker.
    await rm(join(dir, "report.json.lock"), { recursive: true });
    const retried = spawnSync(process.execPath, ["--import", join(dir, "fetch.mjs"), script,
      "--manifest", join(dir, "manifest.json"), "--report", join(dir, "report.json")], {
      cwd: dir,
      env: { ...process.env, STAGING_URL: body.base, ACCESS_CLIENT_ID: "test", ACCESS_CLIENT_SECRET: "test" },
      encoding: "utf8",
    });
    assert.equal(retried.status, 37, retried.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("failure to publish the initial marker retains the lock and does not probe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deletion-audit-publish-error-"));
  try {
    const body = manifest();
    await writeFile(join(dir, "manifest.json"), JSON.stringify(body));
    await writeFile(join(dir, "report.json"), JSON.stringify({ status: "passed" }));
    await writeFile(join(dir, "fault.mjs"), `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
fs.rename = async () => { throw new Error('SYNTHETIC_RENAME_FAILURE'); };
syncBuiltinESMExports();
globalThis.fetch = async () => { throw new Error('UNEXPECTED_PROBE'); };`);
    const script = fileURLToPath(new URL("./audit-deletion.mjs", import.meta.url));
    const child = spawnSync(process.execPath, ["--import", join(dir, "fault.mjs"), script,
      "--manifest", join(dir, "manifest.json"), "--report", join(dir, "report.json")], {
      cwd: dir,
      env: { ...process.env, STAGING_URL: body.base, ACCESS_CLIENT_ID: "test", ACCESS_CLIENT_SECRET: "test" },
      encoding: "utf8",
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /SYNTHETIC_RENAME_FAILURE/);
    assert.doesNotMatch(child.stderr, /UNEXPECTED_PROBE/);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "report.json"), "utf8")), { status: "passed" });
    assert.equal((await stat(join(dir, "report.json.lock"))).isDirectory(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("failure to publish the final report retains the lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deletion-audit-final-error-"));
  try {
    const body = manifest();
    await writeFile(join(dir, "manifest.json"), JSON.stringify(body));
    await writeFile(join(dir, "fault.mjs"), `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.rename; let calls = 0;
fs.rename = async (...args) => { if (++calls === 2) throw new Error('SYNTHETIC_FINAL_FAILURE'); return rename(...args); };
syncBuiltinESMExports();
globalThis.fetch = async () => { throw new Error('synthetic network failure'); };`);
    const script = fileURLToPath(new URL("./audit-deletion.mjs", import.meta.url));
    const child = spawnSync(process.execPath, ["--import", join(dir, "fault.mjs"), script,
      "--manifest", join(dir, "manifest.json"), "--report", join(dir, "report.json")], {
      cwd: dir,
      env: { ...process.env, STAGING_URL: body.base, ACCESS_CLIENT_ID: "test", ACCESS_CLIENT_SECRET: "test" },
      encoding: "utf8",
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /SYNTHETIC_FINAL_FAILURE/);
    const report = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
    assert.equal(report.status, "pending");
    assert.deepEqual(report.reasons, ["AUDIT_IN_PROGRESS"]);
    assert.equal((await stat(join(dir, "report.json.lock"))).isDirectory(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("report cannot overwrite the source manifest, including through a symlink", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deletion-audit-conflict-"));
  try {
    const content = JSON.stringify(manifest());
    const input = join(dir, "manifest.json");
    await writeFile(input, content);
    const alias = join(dir, "manifest-link.json");
    await symlink(input, alias);
    const directoryAlias = join(dir, "dir-link");
    await symlink(dir, directoryAlias, "dir");
    const script = fileURLToPath(new URL("./audit-deletion.mjs", import.meta.url));
    for (const reportPath of [input, alias, join(directoryAlias, "manifest.json")]) {
      const child = spawnSync(process.execPath, [script, "--manifest", input, "--report", reportPath], {
        cwd: dir, env: process.env, encoding: "utf8",
      });
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, /REPORT_OVERWRITES_MANIFEST/);
      assert.equal(await readFile(input, "utf8"), content);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("an active audit excludes a concurrent audit of the same report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deletion-audit-concurrent-"));
  let child;
  try {
    const body = manifest();
    await writeFile(join(dir, "manifest.json"), JSON.stringify(body));
    const directoryAlias = join(dir, "dir-link");
    await symlink(dir, directoryAlias, "dir");
    await writeFile(join(dir, "fetch.mjs"), `import { writeFileSync } from 'node:fs';
globalThis.fetch = async () => {
  writeFileSync('probe-started', 'yes');
  return new Promise(() => setInterval(() => {}, 1000));
};`);
    const script = fileURLToPath(new URL("./audit-deletion.mjs", import.meta.url));
    const args = ["--import", join(dir, "fetch.mjs"), script, "--manifest", join(dir, "manifest.json")];
    const options = { cwd: dir, env: { ...process.env, STAGING_URL: body.base, ACCESS_CLIENT_ID: "test", ACCESS_CLIENT_SECRET: "test" } };
    child = spawn(process.execPath, args, { ...options, stdio: "ignore" });
    const stopped = once(child, "exit");
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await stat(join(dir, "probe-started")); break; }
      catch (error) { if (error?.code !== "ENOENT" || Date.now() >= deadline) throw error; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const concurrent = spawnSync(process.execPath, [...args, "--report", join(directoryAlias, "deletion-audit.json")],
      { ...options, encoding: "utf8", timeout: 3000 });
    assert.notEqual(concurrent.status, 0);
    assert.match(concurrent.stderr, /EEXIST/);
    const report = JSON.parse(await readFile(join(dir, "deletion-audit.json"), "utf8"));
    assert.equal(report.status, "pending");
    assert.deepEqual(report.reasons, ["AUDIT_IN_PROGRESS"]);
    child.kill("SIGKILL");
    await stopped;
    child = undefined;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGKILL");
      await stopped;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
test("zero results for supplied IDs stay pending without an independently complete inventory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deletion-audit-"));
  try {
    const body = manifest();
    // The server canonicalizes valid Durable Object ID spellings before
    // probing R2 and Directory rows. This remains an identity check.
    body.vaultId = body.vaultId.toUpperCase();
    body.workflowInventoryComplete = true;
    await writeFile(join(dir, "manifest.json"), JSON.stringify(body));
    const mock = `globalThis.fetch=async()=>new Response(JSON.stringify({vaultId:${JSON.stringify(body.vaultId.toLowerCase())},userId:${JSON.stringify(body.userId)},directoryRows:0,vaultRows:0,r2Objects:0,oauthRecords:0,activeRuns:0,retentionReviewed:true,billingEventCoverage:{scope:'user_id_only',complete:false},workflowCoverage:{scope:'supplied_ids_only',checked:3,complete:false}}),{status:200});`;
    await writeFile(join(dir, "fetch.mjs"), mock);
    const script = fileURLToPath(
      new URL("./audit-deletion.mjs", import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        join(dir, "fetch.mjs"),
        script,
        "--manifest",
        join(dir, "manifest.json"),
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          STAGING_URL: body.base,
          ACCESS_CLIENT_ID: "test",
          ACCESS_CLIENT_SECRET: "test",
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 2);
    const report = JSON.parse(
      await readFile(join(dir, "deletion-audit.json"), "utf8"),
    );
    assert.equal(report.status, "pending");
    assert.deepEqual(report.checks.billingEventCoverage, {
      scope: "user_id_only",
      complete: false,
    });
    assert.deepEqual(report.reasons, [
      "WORKFLOW_INVENTORY_ATTESTATION_PENDING",
    ]);
    assert.deepEqual(report.checks.workflowCoverage, {
      scope: "supplied_ids_only",
      checked: 3,
      complete: false,
    });
    // An older or incompatible server must not silently omit the limitation.
    await writeFile(join(dir, "fetch.mjs"), mock.replace(
      "billingEventCoverage:{scope:'user_id_only',complete:false},",
      "",
    ));
    const incompatible = spawnSync(
      process.execPath,
      ["--import", join(dir, "fetch.mjs"), script, "--manifest", join(dir, "manifest.json")],
      {
        cwd: dir,
        env: { ...process.env, STAGING_URL: body.base, ACCESS_CLIENT_ID: "test", ACCESS_CLIENT_SECRET: "test" },
        encoding: "utf8",
      },
    );
    assert.equal(incompatible.status, 2);
    const incompatibleReport = JSON.parse(await readFile(join(dir, "deletion-audit.json"), "utf8"));
    assert.deepEqual(incompatibleReport.reasons, ["INVALID_BILLING_EVENT_COVERAGE"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
