#!/usr/bin/env node
// Run after the deployed synthetic lifecycle has produced a deletion manifest.
// A denied session proves access revocation, not erasure. Missing store probes remain pending.
import { readFile, writeFile } from "node:fs/promises";
import { httpsOrigin } from "./lib/config.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const report = {
  status: "pending",
  checkedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? null,
  checks: {},
  reasons: [],
};
try {
  const base = httpsOrigin(process.env.STAGING_URL);
  const id = process.env.ACCESS_CLIENT_ID;
  const secret = process.env.ACCESS_CLIENT_SECRET;
  if (!base || !id || !secret || !arg("--manifest"))
    throw new Error("MISSING_AUDIT_CONFIGURATION");
  const manifest = JSON.parse(await readFile(arg("--manifest"), "utf8"));
  if (
    !/^[a-f0-9]{64}$/i.test(manifest.vaultId ?? "") ||
    typeof manifest.userId !== "string" ||
    manifest.base !== base ||
    manifest.deletionRequested !== true
  )
    throw new Error("INVALID_DELETION_MANIFEST");
  const timeout = Number(arg("--timeout-seconds", "180"));
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 7200)
    throw new Error("INVALID_TIMEOUT");
  const deadline = Date.now() + timeout * 1000;
  const countKeys = [
    "directoryRows",
    "vaultRows",
    "r2Objects",
    "oauthRecords",
    "activeRuns",
  ];
  while (Date.now() < deadline) {
    const url = `${base}/admin/deletion-audits/${manifest.vaultId}`;
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({
        userId: manifest.userId,
        sources: manifest.sources ?? [],
        resumes: manifest.resumes ?? [],
        documents: manifest.documents ?? [],
        reembeddings: manifest.reembeddings ?? [],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        "CF-Access-Client-Id": id,
        "CF-Access-Client-Secret": secret,
      },
    });
    if ([404, 501].includes(response.status))
      throw new Error("STORE_PROBE_UNAVAILABLE");
    if (!response.ok) throw new Error(`STORE_PROBE_HTTP_${response.status}`);
    const result = await response.json();
    if (
      result.vaultId !== manifest.vaultId ||
      result.userId !== manifest.userId
    )
      throw new Error("STORE_PROBE_IDENTITY_MISMATCH");
    for (const key of countKeys)
      report.checks[key] =
        Number.isSafeInteger(result[key]) && result[key] >= 0
          ? result[key]
          : null;
    report.checks.retentionReviewed = result.retentionReviewed === true;
    if (countKeys.some((key) => report.checks[key] === null))
      throw new Error("STORE_PROBE_INCOMPLETE");
    if (countKeys.every((key) => report.checks[key] === 0)) {
      if (!report.checks.retentionReviewed)
        throw new Error("PLATFORM_RETENTION_REVIEW_PENDING");
      report.status = "passed";
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (report.status !== "passed") {
    report.status = "failed";
    report.reasons.push("ERASURE_TIMEOUT");
  }
} catch (error) {
  // Only fixed error codes are persisted. Never store response bodies, cookies, or Access secrets.
  const code =
    error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "AUDIT_REQUEST_FAILED";
  report.reasons.push(code);
}
await writeFile(
  arg("--report", "deletion-audit.json"),
  JSON.stringify(report, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify(report));
process.exitCode =
  report.status === "passed" ? 0 : report.status === "pending" ? 2 : 1;
