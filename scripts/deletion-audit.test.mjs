import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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
