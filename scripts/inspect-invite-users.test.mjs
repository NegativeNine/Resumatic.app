import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PassThrough, Writable } from "node:stream";
import { inspectInviteUsers, privateEmail, validateInventory } from "./inspect-invite-users.mjs";

const account = "a".repeat(32), email = "private-person@example.test";
const origin = "https://staging.example.test";
const config = { vars: { APP_ORIGIN: origin, CF_ACCOUNT_ID: account } };
const env = { STAGING_URL: origin, CLOUDFLARE_ACCOUNT_ID: account, ACCESS_CLIENT_ID: "secret-id", ACCESS_CLIENT_SECRET: "secret-value" };
const args = { args: ["staging"], env, input: { isTTY: true }, prompt: { isTTY: true } };
const deps = { readConfig: async () => ({ config }), readEmail: async () => `  ${email}  ` };
const inventory = () => ({ status: "pending", scope: "current_rows_only", complete: false,
  reasons: ["unfenced_concurrent_and_legacy_writes", "snapshots_at_different_times"],
  observations: ["global", ...Array.from({ length: 16 }, (_, i) => `directory-${i}`)]
    .map((directory) => ({ directory, status: "observed", active: 0, deleting: 0 })) });

function noSecrets(value) {
  const output = JSON.stringify(value);
  for (const secret of [email, "secret-id", "secret-value"]) assert.ok(!output.includes(secret));
}

test("terminal input is read without echoing the address", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  let promptText = "";
  const prompt = new Writable({ write(chunk, _encoding, callback) { promptText += chunk.toString(); callback(); } });
  prompt.isTTY = true;
  const result = privateEmail(input, prompt);
  input.write(`${email}\n`);
  assert.equal(await result, email);
  assert.match(promptText, /input hidden/);
  assert.ok(!promptText.includes(email));
});

test("terminal closure aborts a pending private prompt", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const prompt = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const result = privateEmail(input, prompt);
  input.end();
  await assert.rejects(result, { name: "AbortError" });
});

test("the private input goes only in the fixed POST body and the sanitized result stays pending", async () => {
  let calls = 0;
  const report = await inspectInviteUsers({ ...args, fetcher: async (url, init) => {
    calls++;
    assert.equal(url, `${origin}/admin/invite-user-inventory`);
    assert.equal(init.redirect, "error");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), { email });
    assert.equal(init.headers["CF-Access-Client-Secret"], "secret-value");
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(JSON.stringify(inventory()), { status: 200 });
  } }, deps);
  assert.equal(calls, 1);
  assert.equal(report.status, "pending");
  assert.equal(report.complete, false);
  assert.equal(report.observations.length, 17);
  noSecrets(report);
});

test("configuration and terminal failures occur before private input or network", async () => {
  let reads = 0, calls = 0;
  const isolated = { ...deps, readEmail: async () => { reads++; return email; } };
  const fetcher = async () => { calls++; throw new Error(email); };
  for (const params of [
    { ...args, args: ["staging", email] },
    { ...args, input: { isTTY: false } },
    { ...args, env: { ...env, STAGING_URL: "https://wrong.example.test" } },
    { ...args, env: { ...env, CLOUDFLARE_ACCOUNT_ID: "b".repeat(32) } },
    { ...args, env: { ...env, ACCESS_CLIENT_SECRET: "" } },
  ]) {
    const report = await inspectInviteUsers({ ...params, fetcher }, isolated);
    assert.equal(report.status, "pending");
    noSecrets(report);
  }
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test("unknown fields, counts, provider errors and redirects never leak into output", async () => {
  const bad = inventory();
  bad.observations[0].email = email;
  const reports = [];
  reports.push(await inspectInviteUsers({ ...args, fetcher: async () => new Response(JSON.stringify(bad)) }, deps));
  reports.push(await inspectInviteUsers({ ...args, fetcher: async () => { throw new Error(`${email} secret-value`); } }, deps));
  reports.push(await inspectInviteUsers({ ...args, fetcher: async () => new Response("", { status: 302, headers: { location: "https://other.example.test" } }) }, deps));
  for (const report of reports) { assert.equal(report.complete, false); noSecrets(report); }
  assert.equal(reports[0].reasons[0], "INVENTORY_INVALID_RESPONSE");
  const oversizedCount = inventory(); oversizedCount.observations[0].active = 10_001;
  assert.equal(validateInventory(oversizedCount), null);
});

test("oversized or malformed response bodies are rejected", async () => {
  for (const response of [
    new Response("x".repeat(65_537)),
    new Response("{}", { headers: { "content-length": "99999999" } }),
    new Response(new Uint8Array([0xff])),
  ]) {
    const report = await inspectInviteUsers({ ...args, fetcher: async () => response }, deps);
    assert.equal(report.complete, false);
    assert.equal(report.reasons[0], "INVENTORY_UNAVAILABLE");
    noSecrets(report);
  }
});

test("a non-closing error response is cancelled without exposing its contents or waiting for cancellation", async () => {
  for (const cancel of [() => new Promise(() => {}), () => Promise.reject(new Error(`${email} secret-value`))]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel() { cancelled = true; return cancel(); },
    }), { status: 503 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const report = await inspectInviteUsers({ ...args, fetcher: async () => response }, { ...deps, deadlineSignal: () => controller.signal });
      assert.equal(report.reasons[0], "INVENTORY_UNAVAILABLE");
      assert.equal(cancelled, true);
      noSecrets(report);
    } finally { clearTimeout(timer); }
  }
});

test("deadline bounds a transport or response stream that ignores cancellation", async () => {
  for (const fetcher of [
    () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })),
  ]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    try {
      const report = await inspectInviteUsers({ ...args, fetcher }, { ...deps, deadlineSignal: () => controller.signal });
      assert.equal(report.reasons[0], "INVENTORY_UNAVAILABLE");
      noSecrets(report);
    } finally { clearTimeout(timer); }
  }
});

test("noninteractive CLI refuses before reading or sending personal data", () => {
  const script = fileURLToPath(new URL("./inspect-invite-users.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [script, "staging"], { input: email, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.equal(child.status, 2);
  assert.equal(JSON.parse(child.stdout).reasons[0], "INTERACTIVE_TERMINAL_REQUIRED");
  assert.ok(!child.stdout.includes(email));
  assert.ok(!child.stderr.includes(email));
});
