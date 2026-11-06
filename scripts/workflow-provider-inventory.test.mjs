import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compareWorkflowInventory } from "./lib/workflow-provider-inventory.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const vaultId = "a".repeat(64);
const accountId = "b".repeat(32);
const manifest = () => ({
  base: "https://staging.example", vaultId, userId: id(9),
  sources: [id(1)], resumes: [id(2)], deletionRequested: false,
  runs: [{ id: id(1), targetId: id(1), kind: "distill" }, { id: id(2), targetId: id(2), kind: "tailor" }],
});
const workflows = ["DISTILL", "TAILOR", "DOCUMENTS", "REEMBED"].map((binding) => ({ binding, name: binding.toLowerCase() }));
const ok = (result, info = {}) => Response.json({ success: true, result, result_info: info });

test("compares provider-visible instances without logging other users' payloads or proving erasure", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url), parts = parsed.pathname.split("/");
    const workflow = parts[6], instance = parts[8];
    if (!instance) {
      if (workflow === "distill" && !parsed.searchParams.has("cursor")) return ok([{ id: id(1) }], { cursor: "next" });
      if (workflow === "distill") return ok([{ id: id(3) }, { id: id(4) }]);
      if (workflow === "tailor") return ok([{ id: id(2) }]);
      return ok([]);
    }
    if (instance === id(1)) return ok({ status: "complete", params: { vaultId, sourceId: id(1), secret: "career text must stay private" } });
    if (instance === id(2)) return ok({ status: "running", params: { vaultId, resumeId: id(8) } });
    if (instance === id(3)) return ok({ status: "queued", params: { vaultId, sourceId: id(3) } });
    return ok({ status: "complete", params: { vaultId: "c".repeat(64), career: "another user's text" } });
  };
  const report = await compareWorkflowInventory({ manifest: manifest(), accountId, token: "secret-token", workflows, fetcher });
  assert.equal(report.status, "pending");
  assert.equal(report.inspected, 4);
  assert.deepEqual(report.ledgerNotObserved, []);
  assert.deepEqual(report.visibleNotInLedger, [{ binding: "DISTILL", id: id(3) }]);
  assert.deepEqual(report.payloadMismatch, [{ binding: "TAILOR", id: id(2) }]);
  assert.ok(report.reasons.includes("RETAINED_AND_FLEET_WORKFLOWS_NOT_AUDITED"));
  assert.doesNotMatch(JSON.stringify(report), /secret-token|career text|another user's text/);
  assert.ok(calls.every((c) => c.options.method === "GET" && c.options.redirect === "error"));
  assert.ok(calls.filter((c) => c.url.includes("/instances/")).every((c) => c.url.endsWith("?simple=true")));
});

test("missing details stay pending as missing or unattributed rather than being invented", async () => {
  const fetcher = async (url) => {
    const parts = new URL(url).pathname.split("/"), workflow = parts[6], instance = parts[8];
    if (!instance) return ok(workflow === "distill" ? [{ id: id(1) }] : []);
    return ok({ status: "complete", params: { secret: "not in report" } });
  };
  const report = await compareWorkflowInventory({ manifest: manifest(), accountId, token: "token", workflows, fetcher });
  assert.equal(report.unattributed, 1);
  assert.deepEqual(report.ledgerNotObserved, [{ binding: "DISTILL", id: id(1) }, { binding: "TAILOR", id: id(2) }]);
  assert.doesNotMatch(JSON.stringify(report), /not in report/);
});

test("rejects repeated pages, scan limits, full pages without continuation and provider failures", async () => {
  const config = { manifest: manifest(), accountId, token: "token", workflows };
  await assert.rejects(() => compareWorkflowInventory({ ...config, fetcher: async () => ok([], { cursor: "repeat" }) }), /INVALID_PROVIDER_PAGINATION/);
  await assert.rejects(() => compareWorkflowInventory({ ...config, maxInstances: 1, fetcher: async (url) => {
    if (new URL(url).pathname.endsWith("instances")) return ok([{ id: id(1) }, { id: id(2) }]);
    return ok({ status: "complete", params: { vaultId, sourceId: id(1) } });
  } }), /PROVIDER_SCAN_LIMIT/);
  await assert.rejects(() => compareWorkflowInventory({ ...config, fetcher: async () => ok(Array.from({ length: 100 }, (_, i) => ({ id: id(i) }))) }), /PROVIDER_PAGINATION_AMBIGUOUS/);
  await assert.rejects(() => compareWorkflowInventory({ ...config, fetcher: async () => new Response("career text", { status: 500 }) }), /PROVIDER_REQUEST_FAILED/);
  await assert.rejects(() => compareWorkflowInventory({ ...config, workflows: workflows.slice(1), fetcher: async () => { throw new Error("not called"); } }), /INVALID_WORKFLOW_BINDINGS/);
  await assert.rejects(() => compareWorkflowInventory({ ...config, fetcher: async () => Response.json({ success: true, result: [], result_info: {}, errors: [{ message: "private" }] }) }), /INVALID_PROVIDER_RESPONSE/);
  await assert.rejects(() => compareWorkflowInventory({ ...config, fetcher: async () => ok([{ id: ".." }]) }), /INVALID_PROVIDER_RESPONSE/);
});

test("CLI remains pending, bounds its credentials to the configured account, and writes owner-only metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-inventory-"));
  try {
    await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify({
      name: "resumatic", env: { staging: { workflows, vars: { CF_ACCOUNT_ID: accountId } } },
    }));
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest()));
    await writeFile(join(dir, "fetch.mjs"), `globalThis.fetch=async (url,opts)=>{if(opts.method!=='GET'||opts.redirect!=='error')throw Error('bad');return Response.json({success:true,result:[],result_info:{}})};`);
    const script = fileURLToPath(new URL("./compare-workflow-inventory.mjs", import.meta.url));
    const args = ["--import", join(dir, "fetch.mjs"), script, "--environment", "staging", "--manifest", join(dir, "manifest.json"), "--report", join(dir, "report.json")];
    const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: "secret-token", STAGING_URL: "https://staging.example" };
    const result = spawnSync(process.execPath, args, { cwd: dir, env, encoding: "utf8" });
    assert.equal(result.status, 2);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "pending");
    assert.equal(output.ledgerNotObserved.length, 2);
    assert.doesNotMatch(result.stdout + result.stderr, /secret-token/);
    assert.equal((await stat(join(dir, "report.json"))).mode & 0o077, 0);
    assert.equal(JSON.parse(await readFile(join(dir, "report.json"), "utf8")).status, "pending");
    const wrongAccount = spawnSync(process.execPath, args, { cwd: dir, env: { ...env, CLOUDFLARE_ACCOUNT_ID: "c".repeat(32) }, encoding: "utf8" });
    assert.equal(wrongAccount.status, 2);
    assert.deepEqual(JSON.parse(wrongAccount.stdout).reasons, ["INVALID_INVENTORY_CONFIGURATION"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
