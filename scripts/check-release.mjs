#!/usr/bin/env node
// Evidence is entered in the protected production environment after reviewing real reports.
// Local tests, unavailable integrations and pending audits can never satisfy launch gates.
import { writeFile } from "node:fs/promises";
const required = [
  "models",
  "googleSignin",
  "extraction",
  "grounding",
  "ats",
  "stagingE2e",
  "billing",
  "security",
  "deletion",
  "latency",
  "betaOperations",
];
const report = {
  status: "pending",
  commit: process.env.GITHUB_SHA ?? null,
  missing: [],
};
try {
  const evidence = JSON.parse(process.env.RELEASE_EVIDENCE_JSON ?? "{}");
  if (!/^[a-f0-9]{40}$/.test(report.commit ?? ""))
    report.missing.push("COMMIT_SHA");
  for (const key of required) {
    const check = evidence[key];
    let url;
    try {
      url = new URL(check?.reportUrl);
    } catch {
      /* missing evidence */
    }
    if (
      check?.status !== "passed" ||
      check?.commit !== report.commit ||
      url?.protocol !== "https:" ||
      url.username ||
      url.password
    )
      report.missing.push(key);
  }
  if (
    evidence.extraction?.trapLeaks !== 0 ||
    evidence.extraction?.unsupportedClaims !== 0 ||
    !(
      evidence.extraction?.failureRate >= 0 &&
      evidence.extraction?.failureRate < 0.01
    ) ||
    !(evidence.extraction?.evaluatedUploads > 0)
  )
    report.missing.push("EXTRACTION_MEASUREMENTS");
  // A strategy must satisfy the agreed quality thresholds as well as the
  // no-fabrication gates. Missing, NaN, and impossible values fail closed.
  if (
    !Number.isFinite(evidence.extraction?.factRecall) ||
    evidence.extraction.factRecall < 0.85 ||
    evidence.extraction.factRecall > 1 ||
    !Number.isFinite(evidence.extraction?.factPrecision) ||
    evidence.extraction.factPrecision < 0.95 ||
    evidence.extraction.factPrecision > 1
  )
    report.missing.push("EXTRACTION_QUALITY");
  if (
    evidence.grounding?.unsupportedClaims !== 0 ||
    !(evidence.grounding?.evaluatedLines > 0)
  )
    report.missing.push("GROUNDING_MEASUREMENTS");
  if (
    !(evidence.latency?.p95Seconds > 0 && evidence.latency?.p95Seconds < 90) ||
    !(evidence.latency?.sampleSize > 0)
  )
    report.missing.push("LATENCY_MEASUREMENTS");
  // Local text extraction is necessary, but separate independent ATS parser checks remain required.
  if (
    evidence.ats?.syntheticPdfPassed !== true ||
    evidence.ats?.syntheticDocxPassed !== true ||
    !Number.isSafeInteger(evidence.ats?.externalParsersTested) ||
    evidence.ats.externalParsersTested < 2 ||
    evidence.ats?.unresolvedFailures !== 0
  )
    report.missing.push("ATS_VALIDATION");
  if (evidence.security?.openHighFindings !== 0)
    report.missing.push("SECURITY_FINDINGS");
  if (!(evidence.betaOperations?.quietDays >= 14))
    report.missing.push("BETA_OBSERVATION_WINDOW");
  if (report.missing.length === 0) report.status = "passed";
} catch {
  report.missing.push("INVALID_EVIDENCE");
}
await writeFile("release-report.json", JSON.stringify(report, null, 2) + "\n", {
  mode: 0o600,
});
console.log(JSON.stringify(report));
process.exitCode = report.status === "passed" ? 0 : 2;
