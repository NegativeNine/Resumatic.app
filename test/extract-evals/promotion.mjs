import { createHash } from "node:crypto";
import { z } from "zod";
import { scoreVerified } from "./score-core.mjs";
import { extractionConfiguration } from "./configuration.mjs";
import { loadPrivateDataset, readPrivateJson } from "./private-dataset.mjs";

const Hex = z.string().regex(/^[a-f0-9]{64}$/);
const Opaque = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
const Strategy = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9_@/:.\-]+$/);
const Span = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
const Candidate = z
  .object({
    key: Hex,
    caseId: z.string().regex(/^case-[a-f0-9]{16,64}$/),
    strategy: Strategy,
    roleKey: z.string().nullable(),
    kind: z.enum(["accomplishment", "skill", "credential"]),
    span: Span,
    text: z.string().max(600),
    quote: z.string().max(800),
    judge: z.enum(["supported", "unsupported"]).nullable(),
  })
  .strict();
const PredRole = z
  .object({
    key: z.string().min(1).max(120),
    kind: z.enum(["job", "education", "project", "volunteer"]),
    org: z.string().min(1).max(200),
    title: z.string().max(200).nullable(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    unknownEndStartDate: z.string().regex(/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/).nullable().optional(),
    quote: z.string().max(800),
    span: Span,
  })
  .strict()
  .refine((r) => !r.unknownEndStartDate || (r.startDate === null && r.endDate === null));
const PredFact = z
  .object({
    roleKey: z.string().max(120).nullable(),
    kind: z.enum(["accomplishment", "skill", "credential"]),
    text: z.string().max(600),
    level: z
      .enum(["contributed", "implemented", "led", "owned", "founded"])
      .nullable(),
    quote: z.string().max(800),
    span: Span,
  })
  .strict();
const Prediction = z
  .object({
    roles: z.array(PredRole).max(100),
    facts: z.array(PredFact).max(1000),
  })
  .strict();
const Score = z
  .object({
    matched: z.number().int().nonnegative(),
    proposed: z.number().int().nonnegative(),
    expected: z.number().int().nonnegative(),
    trapLeaks: z.number().int().nonnegative(),
    reviewCost: z.number().nonnegative(),
  })
  .passthrough();
const Usage = z
  .object({ costUsd: z.number().finite().nonnegative().nullable() })
  .passthrough();
const Record = z
  .object({
    caseId: z.string().regex(/^case-[a-f0-9]{16,64}$/),
    strategy: Strategy,
    repeat: z.number().int().min(0).max(9),
    outcome: z.enum(["ok", "failed"]),
    ms: z.number().finite().nonnegative(),
    score: Score.optional(),
    unsupportedClaims: z.number().int().nonnegative().nullable().optional(),
    usage: z.array(Usage).max(1000),
    candidateKeys: z.array(Hex).max(1000),
    judgeVerdicts: z
      .array(z.enum(["supported", "unsupported"]))
      .max(1000)
      .optional(),
    prediction: Prediction.optional(),
  })
  .strict();
const Snapshot = z
  .object({
    version: z.literal(1),
    runId: z.uuid(),
    mode: z.literal("live"),
    split: z.literal("holdout"),
    environment: z.enum(["staging", "production"]),
    manifestHash: Hex,
    configurationHash: Hex,
    strategies: z.array(Strategy).min(1).max(20),
    repeats: z.number().int().min(1).max(10),
    records: z.array(Record).max(50000),
    candidates: z.array(Candidate).max(50000),
  })
  .strict();
const Audit = z
  .object({
    version: z.literal(1),
    snapshotSha256: Hex,
    manifestHash: Hex,
    configurationHash: Hex,
    allDisagreementsReviewed: z.boolean().default(false),
    records: z
      .array(
        z
          .object({
            candidateKey: Hex,
            verdict: z.enum(["supported", "unsupported"]),
            reviewerId: Opaque,
            adjudicatedBy: Opaque.nullable(),
          })
          .strict(),
      )
      .max(50000),
  })
  .strict();
const hash = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function candidateKey(candidate) {
  return hash([
    candidate.caseId,
    candidate.strategy,
    candidate.roleKey,
    candidate.kind,
    candidate.span,
    candidate.text,
    candidate.quote,
  ]);
}
const addReason = (out, reason) => {
  if (!out.includes(reason)) out.push(reason);
};
const percentile = (numbers, p) =>
  numbers.length
    ? [...numbers].sort((a, b) => a - b)[
        Math.max(0, Math.ceil(numbers.length * p) - 1)
      ]
    : null;

/** Read only owner-protected data. Public outputs contain aggregate metadata, never source text. */
export function assessPromotion(root, runId, auditPath) {
  try {
    if (!z.uuid().safeParse(runId).success) throw new Error();
    const dataset = loadPrivateDataset(root);
    const input = readPrivateJson(
      dataset.root,
      `evaluation-snapshots/${runId}.json`,
    );
    const snapshot = Snapshot.parse(input.value);
    if (
      snapshot.runId !== runId ||
      snapshot.manifestHash !== dataset.manifestHash ||
      new Set(snapshot.strategies).size !== snapshot.strategies.length
    )
      throw new Error();
    const evaluatedConfiguration = extractionConfiguration(
      snapshot.strategies,
      snapshot.environment,
    );
    const currentConfiguration = evaluatedConfiguration.hash;
    const audit = auditPath
      ? Audit.parse(readPrivateJson(dataset.root, auditPath).value)
      : {
          version: 1,
          snapshotSha256: input.sha256,
          manifestHash: dataset.manifestHash,
          configurationHash: snapshot.configurationHash,
          allDisagreementsReviewed: false,
          records: [],
        };
    if (
      audit.snapshotSha256 !== input.sha256 ||
      audit.manifestHash !== dataset.manifestHash ||
      audit.configurationHash !== snapshot.configurationHash
    )
      throw new Error();
    const cases = new Map(dataset.cases.map((c) => [c.id, c]));
    const holdout = dataset.cases.filter((c) => c.split === "holdout");
    const profile = dataset.manifest.profile;
    const candidateMap = new Map();
    const judgmentsByKey = new Map();
    for (const c of snapshot.candidates) {
      const source = cases.get(c.caseId);
      if (
        !source ||
        source.split !== "holdout" ||
        !snapshot.strategies.includes(c.strategy) ||
        c.span[0] >= c.span[1] ||
        source.markdown.slice(...c.span) !== c.quote ||
        c.key !== candidateKey(c)
      )
        throw new Error();
      const previous = candidateMap.get(c.key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(c)) {
        // The same exact candidate may get different judge verdicts on repeated runs.
        if (
          JSON.stringify({ ...previous, judge: null }) !==
          JSON.stringify({ ...c, judge: null })
        )
          throw new Error();
      }
      if (!previous) candidateMap.set(c.key, c);
      judgmentsByKey.set(c.key, [
        ...(judgmentsByKey.get(c.key) ?? []),
        c.judge,
      ]);
    }
    const audits = new Map();
    for (const item of audit.records) {
      if (
        !candidateMap.has(item.candidateKey) ||
        audits.has(item.candidateKey) ||
        item.reviewerId === item.adjudicatedBy
      )
        throw new Error();
      audits.set(item.candidateKey, item);
    }
    const result = [];
    for (const strategy of snapshot.strategies) {
      const pending = [],
        failed = [];
      const records = snapshot.records.filter((r) => r.strategy === strategy);
      const expected = new Set(
        holdout.flatMap((c) =>
          Array.from({ length: snapshot.repeats }, (_, i) => `${c.id}:${i}`),
        ),
      );
      const seen = new Set();
      for (const row of records) {
        const key = `${row.caseId}:${row.repeat}`;
        if (!expected.has(key) || seen.has(key)) throw new Error();
        seen.add(key);
        if (
          row.outcome === "ok" &&
          (!row.score ||
            row.unsupportedClaims === undefined ||
            row.candidateKeys.length !== row.score.proposed ||
            !row.prediction ||
            !row.judgeVerdicts ||
            row.judgeVerdicts.length !== row.candidateKeys.length ||
            row.prediction.facts.length !== row.candidateKeys.length ||
            new Set(row.candidateKeys).size !== row.candidateKeys.length ||
            row.score.matched > row.score.proposed ||
            row.score.matched > row.score.expected ||
            row.score.expected !== cases.get(row.caseId).gold.facts.length)
        )
          throw new Error();
        if (row.outcome === "ok") {
          const source = cases.get(row.caseId);
          if (currentConfiguration === snapshot.configurationHash &&
              !evaluatedConfiguration.behavior.roleUnknownEnd &&
              row.prediction.roles.some((role) => !!role.unknownEndStartDate))
            throw new Error();
          if (
            [...row.prediction.roles, ...row.prediction.facts].some(
              (item) =>
                item.span[0] >= item.span[1] ||
                source.markdown.slice(...item.span) !== item.quote,
            )
          )
            throw new Error();
          const recomputed = scoreVerified(row.prediction, source.gold, source.markdown);
          for (const key of [
            "matched",
            "proposed",
            "expected",
            "trapLeaks",
            "reviewCost",
          ])
            if (recomputed[key] !== row.score[key]) throw new Error();
          if (
            row.unsupportedClaims !==
            row.judgeVerdicts.filter((verdict) => verdict === "unsupported")
              .length
          )
            throw new Error();
          row.prediction.facts.forEach((fact, index) => {
            if (
              candidateKey({
                caseId: row.caseId,
                strategy,
                roleKey: fact.roleKey,
                kind: fact.kind,
                span: fact.span,
                text: fact.text,
                quote: fact.quote,
              }) !== row.candidateKeys[index]
            )
              throw new Error();
            if (
              !(judgmentsByKey.get(row.candidateKeys[index]) ?? []).includes(
                row.judgeVerdicts[index],
              )
            )
              throw new Error();
          });
          row.score = recomputed;
        }
        if (
          row.outcome === "failed" &&
          (row.candidateKeys.length ||
            row.prediction ||
            row.judgeVerdicts?.length)
        )
          throw new Error();
        for (const candidate of row.candidateKeys) {
          const found = candidateMap.get(candidate);
          if (
            !found ||
            found.strategy !== strategy ||
            found.caseId !== row.caseId
          )
            throw new Error();
        }
      }
      if (seen.size !== expected.size || !records.length)
        addReason(pending, "missing_holdout_runs");
      if (currentConfiguration !== snapshot.configurationHash)
        addReason(pending, "configuration_changed");
      if (!auditPath) addReason(pending, "human_audit_missing");
      if (!audit.allDisagreementsReviewed)
        addReason(pending, "disagreement_review_attestation_missing");
      const limits =
        profile === "round-1"
          ? { cases: 30, synthetic: 20, real: 10, dev: 20, holdout: 10 }
          : { cases: 40, synthetic: 20, real: 20, dev: 25, holdout: 15 };
      if (
        dataset.cases.length < limits.cases ||
        dataset.cases.filter((c) => c.meta.origin === "synthetic").length <
          limits.synthetic ||
        dataset.cases.filter((c) => c.meta.origin === "real").length <
          limits.real ||
        dataset.cases.filter((c) => c.split === "dev").length < limits.dev ||
        holdout.length < limits.holdout
      )
        addReason(pending, "insufficient_dataset");
      if (
        holdout.filter((c) => c.meta.origin === "real").length < 3 ||
        holdout.filter((c) => c.meta.origin === "synthetic").length < 3
      )
        addReason(pending, "holdout_origin_coverage_missing");
      if (
        !holdout.some((c) => c.meta.format === "pdf") ||
        !holdout.some((c) => c.meta.format === "docx")
      )
        addReason(pending, "holdout_format_coverage_missing");
      if (holdout.filter((c) => c.gold.traps.length > 0).length < 3)
        addReason(pending, "holdout_trap_coverage_missing");
      const successes = records.filter((r) => r.outcome === "ok" && r.score),
        failures = records.length - successes.length;
      const sum = (field) => successes.reduce((n, r) => n + r.score[field], 0);
      const matched = sum("matched"),
        proposed = sum("proposed"),
        expectedFacts = sum("expected");
      const precision = proposed ? matched / proposed : null,
        recall = expectedFacts ? matched / expectedFacts : null;
      if (precision === null || recall === null)
        addReason(pending, "insufficient_scored_facts");
      else {
        if (precision < 0.95) addReason(failed, "precision_below_95_percent");
        if (recall < 0.85) addReason(failed, "recall_below_85_percent");
      }
      if (records.length && failures / records.length >= 0.01)
        addReason(failed, "failure_rate_at_least_1_percent");
      if (sum("trapLeaks") > 0) addReason(failed, "instruction_leaks");
      if (successes.some((r) => r.unsupportedClaims == null))
        addReason(pending, "judge_missing");
      if (successes.some((r) => (r.unsupportedClaims ?? 0) > 0))
        addReason(failed, "judge_unsupported_claims");
      const eligibleKeys = new Set(successes.flatMap((r) => r.candidateKeys));
      // Bind the sample to the immutable snapshot. An auditor cannot choose
      // only easy examples after seeing the results.
      const sampleSeed = hash([
        dataset.manifestHash,
        snapshot.configurationHash,
        strategy,
      ]);
      const sampleKeys = [...eligibleKeys]
        .sort((a, b) =>
          hash([sampleSeed, a]).localeCompare(hash([sampleSeed, b])),
        )
        .slice(0, 50);
      const reviewed = [...eligibleKeys].filter((key) => audits.has(key));
      if (sampleKeys.length < 50 || sampleKeys.some((key) => !audits.has(key)))
        addReason(pending, "insufficient_human_audit");
      let disagreements = 0;
      for (const key of eligibleKeys) {
        const judgments = judgmentsByKey.get(key) ?? [];
        if (!judgments.length || judgments.some((j) => j === null))
          addReason(pending, "judge_missing");
        if (judgments.some((j) => j === "unsupported"))
          addReason(failed, "judge_unsupported_claims");
      }
      for (const key of reviewed) {
        const a = audits.get(key);
        const judgments = judgmentsByKey.get(key) ?? [];
        if (judgments.some((j) => j !== null && j !== a.verdict)) {
          disagreements++;
          if (!a.adjudicatedBy)
            addReason(pending, "unadjudicated_disagreement");
        }
        if (a.verdict === "unsupported")
          addReason(failed, "human_unsupported_claims");
      }
      const completeCost =
        successes.every(
          (r) => r.usage.length > 0 && r.usage.every((u) => u.costUsd !== null),
        ) && failures === 0;
      const cost =
        completeCost && successes.length
          ? successes.reduce(
              (n, r) => n + r.usage.reduce((m, u) => m + u.costUsd, 0),
              0,
            ) / successes.length
          : null;
      if (cost === null) addReason(pending, "unpriced_usage");
      result.push({
        strategy,
        status: failed.length
          ? "failed"
          : pending.length
            ? "pending"
            : "eligible",
        pending,
        failed,
        sampleKeys,
        sampleSeed,
        metrics: {
          cases: holdout.length,
          runs: records.length,
          failures,
          failureRate: records.length ? failures / records.length : null,
          precision,
          recall,
          roleRecall: sum("roleExpected") ? sum("roleMatched") / sum("roleExpected") : null,
          dateAccuracy: sum("dateCount") ? sum("dateCorrect") / sum("dateCount") : null,
          skillPrecision: sum("skillProposed") ? sum("skillMatched") / sum("skillProposed") : (sum("skillExpected") ? 0 : null),
          skillRecall: sum("skillExpected") ? sum("skillMatched") / sum("skillExpected") : null,
          skillsF1: sum("skillProposed") + sum("skillExpected")
            ? 2 * sum("skillMatched") / (sum("skillProposed") + sum("skillExpected"))
            : null,
          trapLeaks: sum("trapLeaks"),
          reviewCost: successes.length
            ? sum("reviewCost") / successes.length
            : null,
          reviewedFacts: reviewed.length,
          disagreements,
          meanCostUsd: cost,
          p50Ms: percentile(
            successes.map((r) => r.ms),
            0.5,
          ),
          p95Ms: percentile(
            successes.map((r) => r.ms),
            0.95,
          ),
        },
      });
    }
    const eligible = result.filter((r) => r.status === "eligible");
    eligible.sort((a, b) => a.metrics.reviewCost - b.metrics.reviewCost);
    let winner = eligible[0] ?? null,
      rankPending = false;
    if (winner) {
      const tied = eligible.filter(
        (r) => r.metrics.reviewCost === winner.metrics.reviewCost,
      );
      if (
        tied.length > 1 &&
        tied.some(
          (r) => r.metrics.meanCostUsd === null || r.metrics.p95Ms === null,
        )
      ) {
        winner = null;
        rankPending = true;
      } else if (tied.length > 1) {
        tied.sort(
          (a, b) =>
            a.metrics.meanCostUsd - b.metrics.meanCostUsd ||
            a.metrics.p95Ms - b.metrics.p95Ms,
        );
        winner = tied[0];
      }
    }
    return {
      version: 1,
      mode: "human-audited",
      profile,
      runId,
      environment: snapshot.environment,
      strategies: snapshot.strategies,
      manifestHash: dataset.manifestHash,
      snapshotSha256: input.sha256,
      configurationHash: snapshot.configurationHash,
      results: result,
      winner: winner?.strategy ?? null,
      rankingPending: rankPending,
    };
  } catch {
    throw new Error("promotion_evidence_invalid");
  }
}
