#!/usr/bin/env node
// Evidence is entered in the protected production environment after reviewing real reports.
// Local tests, unavailable integrations and pending audits can never satisfy launch gates.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readConfig } from "./lib/config.mjs";
import { configuredExtractors } from "./lib/extractor-routes.mjs";
import { workflowInventoryAuditCapability } from "./lib/deletion-audit.mjs";
import { extractionConfiguration } from "../test/extract-evals/configuration.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
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
const hex256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
/** Validate the aggregate returned by the full-corpus human-audited promotion assessor.
 * The protected environment remains an operator attestation: this cannot authenticate
 * the report, underlying dataset, consent or audit independently. */
function validResult(winner) {
  const metrics = winner?.metrics;
  return Boolean(
    winner?.status === "eligible" && Array.isArray(winner.pending) && winner.pending.length === 0 &&
    Array.isArray(winner.failed) && winner.failed.length === 0 && hex256(winner.sampleSeed) &&
    Array.isArray(winner.sampleKeys) && winner.sampleKeys.length === 50 &&
    new Set(winner.sampleKeys).size === 50 && winner.sampleKeys.every(hex256) &&
    metrics && count(metrics.cases, 15) && count(metrics.runs, metrics.cases) &&
    count(metrics.failures, 0) && metrics.failures <= metrics.runs &&
    finite(metrics.failureRate) && metrics.failureRate === metrics.failures / metrics.runs &&
    metrics.failureRate >= 0 && metrics.failureRate < 0.01 &&
    finite(metrics.recall) && metrics.recall >= 0.85 && metrics.recall <= 1 &&
    finite(metrics.precision) && metrics.precision >= 0.95 && metrics.precision <= 1 &&
    metrics.trapLeaks === 0 && metrics.levelInflation === 0 &&
    count(metrics.levelUnverified, 0) && metrics.levelReviewed === metrics.levelUnverified &&
    count(metrics.reviewedFacts, 50) &&
    count(metrics.disagreements, 0) &&
    finite(metrics.reviewCost) && metrics.reviewCost >= 0 &&
    finite(metrics.meanCostUsd) && metrics.meanCostUsd >= 0 &&
    finite(metrics.p95Ms) && metrics.p95Ms >= 0
  );
}
function validPromotion(extraction) {
  const promotion = extraction?.promotion;
  if (
    !promotion || promotion.version !== 1 || promotion.mode !== "human-audited" ||
    promotion.profile !== "full" || promotion.rankingPending !== false ||
    typeof promotion.runId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(promotion.runId) ||
    !hex256(promotion.manifestHash) || !hex256(promotion.snapshotSha256) ||
    !hex256(promotion.configurationHash) ||
    typeof promotion.winner !== "string" || !promotion.winner ||
    !["staging", "production"].includes(promotion.environment) ||
    !Array.isArray(promotion.strategies) || promotion.strategies.length === 0 ||
    promotion.strategies.length > 20 || new Set(promotion.strategies).size !== promotion.strategies.length ||
    promotion.strategies.some((strategy) => typeof strategy !== "string" || !/^[A-Za-z0-9_@/:.\-]{1,240}$/.test(strategy)) ||
    !Array.isArray(promotion.results) || promotion.results.length !== promotion.strategies.length ||
    promotion.results.some((result, i) => result?.strategy !== promotion.strategies[i])
  ) return false;
  const winners = promotion.results.filter((result) => result?.strategy === promotion.winner);
  if (winners.length !== 1) return false;
  const winner = winners[0], metrics = winner.metrics;
  if (!validResult(winner)) return false;
  // The protected environment is an attestation, but its aggregate must be
  // internally consistent with the assessor's ranking. Do not accept a worse
  // eligible default or an eligible competitor whose ranking data is missing.
  if (promotion.results.some((result) => {
    if (!Array.isArray(result?.pending) || !Array.isArray(result?.failed) ||
        [...result.pending, ...result.failed].some((reason) => typeof reason !== "string" || !reason)) return true;
    if (result.status === "eligible") return !validResult(result);
    if (result.status === "failed") return result.failed.length === 0;
    if (result.status === "pending") return result.failed.length > 0 || result.pending.length === 0;
    return true;
  })) return false;
  const eligible = promotion.results.filter((result) => result.status === "eligible");
  if (eligible.some((result) => result.metrics.cases !== metrics.cases || result.metrics.runs !== metrics.runs)) return false;
  eligible.sort((a, b) =>
    a.metrics.reviewCost - b.metrics.reviewCost ||
    a.metrics.meanCostUsd - b.metrics.meanCostUsd ||
    a.metrics.p95Ms - b.metrics.p95Ms,
  );
  if (eligible[0]?.strategy !== promotion.winner) return false;
  return extraction.evaluatedUploads === metrics.cases &&
    extraction.failureRate === metrics.failureRate && extraction.factRecall === metrics.recall &&
    extraction.factPrecision === metrics.precision && extraction.trapLeaks === metrics.trapLeaks;
}
/** Every configured production route must be an eligible measured strategy. */
async function validExtractionConfiguration(extraction) {
  try {
    const promotion = extraction.promotion;
    const { config } = await readConfig("production", join(root, "wrangler.jsonc"));
    const vars = config.vars ?? {};
    const { fallback, selected } = configuredExtractors(vars);
    if (fallback !== promotion.winner) return false;
    for (const strategy of selected) {
      const result = promotion.results.find((item) => item.strategy === strategy);
      if (!result || !validResult(result) || result.metrics.cases !== promotion.results.find((item) => item.strategy === promotion.winner).metrics.cases) return false;
    }
    const opts = { root, priceOverrides: extraction.priceOverrides ?? {} };
    const tested = extractionConfiguration(promotion.strategies, promotion.environment, opts);
    const production = extractionConfiguration(promotion.strategies, "production", opts);
    return tested.hash === promotion.configurationHash &&
      JSON.stringify(tested.models) === JSON.stringify(production.models) &&
      JSON.stringify(tested.behavior) === JSON.stringify(production.behavior) &&
      !production.behavior.roleUnknownEnd;
  } catch {
    return false;
  }
}
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
    !count(evidence.extraction?.evaluatedUploads, 15)
  )
    report.missing.push("EXTRACTION_MEASUREMENTS");
  if (!validPromotion(evidence.extraction))
    report.missing.push("EXTRACTION_PROMOTION");
  else if (!(await validExtractionConfiguration(evidence.extraction)))
    report.missing.push("EXTRACTION_CONFIGURATION");
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
    !count(evidence.grounding?.evaluatedLines, 1)
  )
    report.missing.push("GROUNDING_MEASUREMENTS");
  if (
    !(finite(evidence.latency?.p95Seconds) && evidence.latency.p95Seconds > 0 && evidence.latency.p95Seconds < 90) ||
    !count(evidence.latency?.sampleSize, 1)
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
  if (
    evidence.billing?.testModePassed !== true ||
    evidence.billing?.livePaymentPassed !== true ||
    evidence.billing?.liveCancellationPassed !== true
  )
    report.missing.push("BILLING_VALIDATION");
  // The protected environment is an attestation, but cannot supply a capability
  // that the deletion audit itself does not implement.
  if (workflowInventoryAuditCapability().complete !== true)
    report.missing.push("DELETION_INVENTORY_AUDIT_UNAVAILABLE");
  // Exact new edits are checked, but full legacy remediation, shared-evidence
  // handling and historic share/refinement guarantees remain incomplete.
  // Operator evidence cannot replace the missing implementation or live tests.
  report.missing.push("MANUAL_RESUME_EDIT_GROUNDING_UNAVAILABLE");
  if (!count(evidence.betaOperations?.quietDays, 14))
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
