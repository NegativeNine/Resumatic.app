import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectFleetWorkflowInventory } from "./lib/fleet-workflow-inventory.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const vaultId = "a".repeat(64), otherVault = "b".repeat(64), accountId = "c".repeat(32);
const workflows = [{ binding: "FLEET_REEMBED", name: "fleet-reembed" }];
const cfg = { vaultId, accountId, token: "secret-token", workflows };
const ok = (result, result_info = {}) => Response.json({ success: true, result, result_info });

test("finds visible fleet references without returning step state or other users' data", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const path = new URL(url).pathname.split("/");
    const instance = path.at(-1);
    if (instance === "instances") return ok([{ id: id(1) }, { id: id(2) }]);
    if (instance === id(1)) return ok({ status: "running", params: { model: "secret-model" }, steps: [
      { name: "secret-step", output: JSON.stringify({ ids: [otherVault, vaultId] }) },
    ] });
    return ok({ status: "complete", params: { cursor: { after: otherVault } }, steps: [] });
  };
  const report = await inspectFleetWorkflowInventory({ ...cfg, fetcher });
  assert.equal(report.status, "pending");
  assert.equal(report.inspected, 2);
  assert.equal(report.uninspectable, 0);
  assert.deepEqual(report.references, [{ id: id(1), status: "running" }]);
  assert.doesNotMatch(JSON.stringify(report), /secret|bbbbbbbb/);
  assert.ok(calls.every(({ options }) => options.method === "GET" && options.redirect === "error"));
  assert.ok(calls.filter(({ url }) => url.includes("/instances/")).every(({ url }) => url.endsWith("?simple=false")));
});

test("reports unavailable step state, invalid instance IDs and limits without claiming absence", async () => {
  const fetcher = async (url) => {
    const instance = new URL(url).pathname.split("/").at(-1);
    if (instance === "instances") return ok([{ id: "external-id" }, { id: id(1) }, { id: id(2) }]);
    return ok({ status: "complete", params: { after: vaultId } });
  };
  const report = await inspectFleetWorkflowInventory({ ...cfg, maxInstances: 2, fetcher });
  assert.deepEqual(report.references, [{ id: id(1), status: "complete" }]);
  assert.equal(report.inspected, 1);
  assert.equal(report.uninspectable, 2);
  assert.equal(report.scanLimited, true);
  assert.ok(report.reasons.includes("STEP_OUTPUT_MAY_BE_REDACTED"));
});

test("marks redacted, missing and truncated step results as uninspectable", async () => {
  const details = [
    { status: "complete", steps: [{ type: "step", success: true, config: { sensitive: "output" } }] },
    { status: "complete", steps: [{ type: "step", success: true }] },
    { status: "complete", steps: [], step_count: 1 },
  ];
  let index = 0;
  const fetcher = async (url) => new URL(url).pathname.endsWith("/instances")
    ? ok(details.map((_, i) => ({ id: id(i + 1) }))) : ok(details[index++]);
  const report = await inspectFleetWorkflowInventory({ ...cfg, fetcher });
  assert.equal(report.inspected, 3);
  assert.equal(report.uninspectable, 3);
  assert.deepEqual(report.references, []);
  assert.equal(report.status, "pending");
});

test("bounds provider responses and rejects malformed scans without revealing response bodies", async () => {
  let cancelled = false;
  const fetcher = async (url) => {
    if (new URL(url).pathname.endsWith("/instances")) return ok([{ id: id(1) }]);
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }));
  };
  const report = await inspectFleetWorkflowInventory({ ...cfg, fetcher });
  assert.equal(cancelled, true);
  assert.equal(report.uninspectable, 1);
  assert.equal(report.inspected, 0);
  await assert.rejects(() => inspectFleetWorkflowInventory({ ...cfg, fetcher: async () => ok([], { cursor: "again" }) }), /INVALID_PROVIDER_PAGINATION/);
  await assert.rejects(() => inspectFleetWorkflowInventory({ ...cfg, fetcher: async () => new Response("private payload", { status: 403 }) }), /PROVIDER_REQUEST_FAILED/);
  await assert.rejects(() => inspectFleetWorkflowInventory({ ...cfg, workflows: [], fetcher }), /INVALID_FLEET_INVENTORY_CONFIGURATION/);
  await assert.rejects(() => inspectFleetWorkflowInventory({ ...cfg, fetcher: async (url) =>
    new URL(url).pathname.endsWith("/instances") ? ok([{ id: id(1) }]) : ok({ status: "complete", steps: [], step_count: -1 }) }), /INVALID_PROVIDER_RESPONSE/);
});

test("CLI remains pending, verifies account/origin, and writes an owner-only report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-workflows-"));
  try {
    await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify({ name: "resumatic", env: { staging: { workflows, vars: { CF_ACCOUNT_ID: accountId } } } }));
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ base: "https://staging.example", vaultId }));
    await writeFile(join(dir, "fetch.mjs"), `globalThis.fetch=async()=>Response.json({success:true,result:[],result_info:{}});`);
    const script = fileURLToPath(new URL("./inspect-fleet-workflows.mjs", import.meta.url));
    const args = ["--import", join(dir, "fetch.mjs"), script, "--environment", "staging", "--manifest", join(dir, "manifest.json"), "--report", join(dir, "report.json")];
    const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: "secret-token", STAGING_URL: "https://staging.example" };
    const run = spawnSync(process.execPath, args, { cwd: dir, env, encoding: "utf8" });
    assert.equal(run.status, 2);
    assert.equal(JSON.parse(run.stdout).status, "pending");
    assert.equal((await stat(join(dir, "report.json"))).mode & 0o077, 0);
    assert.equal(JSON.parse(await readFile(join(dir, "report.json"), "utf8")).references.length, 0);
    const wrong = spawnSync(process.execPath, args, { cwd: dir, env: { ...env, CLOUDFLARE_ACCOUNT_ID: "d".repeat(32) }, encoding: "utf8" });
    assert.equal(wrong.status, 2);
    assert.deepEqual(JSON.parse(wrong.stdout).reasons, ["INVALID_FLEET_INVENTORY_CONFIGURATION"]);
    assert.doesNotMatch(run.stdout + run.stderr + wrong.stdout + wrong.stderr, /secret-token/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
