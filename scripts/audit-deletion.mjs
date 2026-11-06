#!/usr/bin/env node
// Run after the deployed synthetic lifecycle has produced a deletion manifest.
// A denied session proves access revocation, not erasure. Missing store probes remain pending.
import { mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { deletionProbeInput, workflowCoverage } from "./lib/deletion-audit.mjs";
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
const requestedReport = resolve(arg("--report", "deletion-audit.json"));
// Atomic rename replaces a directory entry, so aliases of its parent must
// share one lock even when callers use different directory symlinks.
const reportPath = join(await realpath(dirname(requestedReport)), basename(requestedReport));
const manifestArg = arg("--manifest");
async function existingRealPath(path) {
  try { return await realpath(path); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
if (manifestArg) {
  const manifestPath = resolve(manifestArg);
  const [resolvedManifest, resolvedReport] = await Promise.all([
    existingRealPath(manifestPath), existingRealPath(reportPath),
  ]);
  if (reportPath === manifestPath || (resolvedManifest && resolvedManifest === resolvedReport))
    throw new Error("REPORT_OVERWRITES_MANIFEST");
}

// Replace, rather than truncate, the visible report. Once the marker is
// published, a killed process leaves a parseable pending result.
async function publishReport(value) {
  const dir = await mkdtemp(join(dirname(reportPath), ".deletion-audit-"));
  try {
    const file = join(dir, "report.json");
    await writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(file, reportPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Never let overlapping runs publish older results over a newer pending
// marker. A crash leaves the lock for an operator to remove only after
// establishing that the prior process has stopped.
const lockPath = `${reportPath}.lock`;
await mkdir(lockPath, { mode: 0o700 });
let reportPublished = false;
try {
  // Fail before making any request if we cannot invalidate the preceding audit.
  await publishReport({ ...report, reasons: ["AUDIT_IN_PROGRESS"] });
  try {
    const base = httpsOrigin(process.env.STAGING_URL);
    const id = process.env.ACCESS_CLIENT_ID;
    const secret = process.env.ACCESS_CLIENT_SECRET;
    if (!base || !id || !secret || !arg("--manifest"))
      throw new Error("MISSING_AUDIT_CONFIGURATION");
    const manifest = JSON.parse(await readFile(arg("--manifest"), "utf8"));
    const probeInput = deletionProbeInput(manifest, base);
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
        body: JSON.stringify(probeInput),
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
        result.vaultId !== manifest.vaultId.toLowerCase() ||
        result.userId !== manifest.userId
      )
        throw new Error("STORE_PROBE_IDENTITY_MISMATCH");
      for (const key of countKeys)
        report.checks[key] =
          Number.isSafeInteger(result[key]) && result[key] >= 0
            ? result[key]
            : null;
      report.checks.retentionReviewed = result.retentionReviewed === true;
      if (
        result.billingEventCoverage?.scope !== "user_id_only" ||
        result.billingEventCoverage?.complete !== false
      )
        throw new Error("INVALID_BILLING_EVENT_COVERAGE");
      report.checks.billingEventCoverage = {
        scope: "user_id_only",
        complete: false,
      };
      report.checks.workflowCoverage = workflowCoverage(
        result.workflowCoverage,
        probeInput,
      );
      if (countKeys.some((key) => report.checks[key] === null))
        throw new Error("STORE_PROBE_INCOMPLETE");
      if (countKeys.every((key) => report.checks[key] === 0)) {
        if (!report.checks.workflowCoverage.complete)
          throw new Error("WORKFLOW_INVENTORY_ATTESTATION_PENDING");
        if (!report.checks.billingEventCoverage.complete)
          throw new Error("BILLING_EVENT_ATTRIBUTION_PENDING");
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
  await publishReport(report);
  reportPublished = true;
  console.log(JSON.stringify(report));
  process.exitCode =
    report.status === "passed" ? 0 : report.status === "pending" ? 2 : 1;
} finally {
  // A failed publication can leave an old or incomplete report. Keep the
  // lock until both report replacement and temporary-file cleanup succeed.
  if (reportPublished) await rmdir(lockPath);
}
