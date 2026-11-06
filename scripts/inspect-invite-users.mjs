#!/usr/bin/env node
// Read-only, deliberately non-authoritative inspection of a shared invitation.
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { readConfig, httpsOrigin } from "./lib/config.mjs";

const MAX_RESPONSE = 64 * 1024;
const reasons = ["unfenced_concurrent_and_legacy_writes", "snapshots_at_different_times"];
const incomplete = new Set(["row_limit", "invalid_rows", "unavailable"]);
const exactKeys = (object, keys) => object && typeof object === "object" && !Array.isArray(object) &&
  Object.keys(object).sort().join("\0") === [...keys].sort().join("\0");
const pending = (reason) => ({ status: "pending", complete: false, reasons: [reason] });

/** Never return arbitrary server fields, exception text, or the requested email. */
export function validateInventory(value) {
  if (!exactKeys(value, ["status", "scope", "complete", "reasons", "observations"]) ||
      value.status !== "pending" || value.scope !== "current_rows_only" || value.complete !== false ||
      !Array.isArray(value.reasons) || value.reasons.length !== reasons.length ||
      !reasons.every((reason) => value.reasons.includes(reason)) ||
      !Array.isArray(value.observations) || value.observations.length !== 17) return null;
  const names = ["global", ...Array.from({ length: 16 }, (_, i) => `directory-${i}`)];
  const observations = [];
  for (let i = 0; i < names.length; i++) {
    const row = value.observations[i];
    if (!row || row.directory !== names[i]) return null;
    if (row.status === "observed") {
      if (!exactKeys(row, ["directory", "status", "active", "deleting"]) ||
          !Number.isSafeInteger(row.active) || row.active < 0 || row.active > 10_000 ||
          !Number.isSafeInteger(row.deleting) || row.deleting < 0 || row.deleting > 10_000 ||
          row.active + row.deleting > 10_000) return null;
      observations.push({ directory: names[i], status: "observed", active: row.active, deleting: row.deleting });
    } else {
      if (!incomplete.has(row.status) || !exactKeys(row, ["directory", "status"])) return null;
      observations.push({ directory: names[i], status: row.status });
    }
  }
  return { status: "pending", scope: "current_rows_only", complete: false, reasons: [...reasons], observations };
}

/** Enforce the same deadline even if a transport fails to honor its signal. */
function untilAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error()); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

async function readBounded(response, signal) {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE)) throw new Error();
  if (!response.body) throw new Error();
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const result = await untilAbort(reader.read(), signal);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_RESPONSE) throw new Error();
      chunks.push(result.value);
    }
  } finally { void reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Prompt without echo; the address never appears in the prompt or output. */
export async function privateEmail(input, prompt) {
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const rl = createInterface({ input, output: sink, terminal: true });
  const abort = new AbortController();
  rl.once("close", () => abort.abort());
  prompt.write("Email to inspect (input hidden): ");
  try { return await rl.question("", { signal: abort.signal }); }
  finally { rl.close(); prompt.write("\n"); }
}

export async function inspectInviteUsers({ args, env = process.env, input = process.stdin, prompt = process.stderr, fetcher = fetch }, dependencies = {}) {
  const environment = args?.length === 1 ? args[0] : "";
  if (!["staging", "production"].includes(environment)) return pending("ENVIRONMENT_REQUIRED");
  if (!input?.isTTY || !prompt?.isTTY) return pending("INTERACTIVE_TERMINAL_REQUIRED");
  try {
    const { config } = await (dependencies.readConfig ?? readConfig)(environment);
    const configuredOrigin = httpsOrigin(config.vars?.APP_ORIGIN);
    const requestedOrigin = httpsOrigin(environment === "staging" ? env.STAGING_URL : env.APP_ORIGIN);
    const account = env.CLOUDFLARE_ACCOUNT_ID;
    if (!configuredOrigin || !requestedOrigin || configuredOrigin !== requestedOrigin ||
        !/^[a-f0-9]{32}$/i.test(account ?? "") || config.vars?.CF_ACCOUNT_ID !== account ||
        typeof env.ACCESS_CLIENT_ID !== "string" || !env.ACCESS_CLIENT_ID ||
        typeof env.ACCESS_CLIENT_SECRET !== "string" || !env.ACCESS_CLIENT_SECRET)
      return pending("INVENTORY_CONFIGURATION_UNVERIFIED");
    const email = await (dependencies.readEmail ?? privateEmail)(input, prompt);
    if (typeof email !== "string" || !email.trim() || email.length > 320 || email.trim().toLowerCase().length > 320)
      return pending("INVALID_PRIVATE_INPUT");
    const signal = dependencies.deadlineSignal?.() ?? AbortSignal.timeout(10_000);
    const response = await untilAbort(fetcher(`${requestedOrigin}/admin/invite-user-inventory`, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", "CF-Access-Client-Id": env.ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": env.ACCESS_CLIENT_SECRET },
      body: JSON.stringify({ email: email.trim() }),
    }), signal);
    if (response.status !== 200) {
      // Do not keep receiving an error body. Cancellation is best effort and
      // must not delay the bounded, sanitized result if a stream misbehaves.
      void response.body?.cancel().catch(() => {});
      return pending("INVENTORY_UNAVAILABLE");
    }
    return validateInventory(await readBounded(response, signal)) ?? pending("INVENTORY_INVALID_RESPONSE");
  } catch {
    return pending("INVENTORY_UNAVAILABLE");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await inspectInviteUsers({ args: process.argv.slice(2) });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = 2; // An observation never proves deletion safety.
}
