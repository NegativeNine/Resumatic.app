import { rankOf } from "../../src/grounding/claims";
import type { Span } from "../../src/grounding/offsets";
import { iou } from "../../src/pipeline/extract/judge";
import type { VerifiedExtraction } from "../../src/pipeline/extract/types";
import type { FactKind, Level, RoleKind } from "../../src/shared/api";

export interface Gold {
  roles: {
    id: string;
    kind: RoleKind;
    org: string;
    title: string | null;
    start: string | null;
    end: string | null;
    header: Span;
  }[];
  facts: {
    id: string;
    role: string | null;
    kind: FactKind;
    span: Span;
    level: Level | null;
  }[];
  traps: { type: "instruction"; span: Span }[];
}
export interface CaseScore {
  precision: number;
  recall: number;
  f1: number;
  evidenceCoverageRecall: number;
  roleRecall: number;
  dateAccuracy: number;
  assignment: number;
  levelAccuracy: number;
  inflation: number;
  trapLeaks: number;
  reviewCost: number;
  matched: number;
  proposed: number;
  expected: number;
}
const ratio = (numerator: number, denominator: number) =>
  denominator ? numerator / denominator : 1;

/** Match evidence before checking role assignment, or assignment accuracy is tautological. */
export function scoreCase(pred: VerifiedExtraction, gold: Gold): CaseScore {
  const roleMap = new Map<string, string>();
  const usedRoles = new Set<string>();
  let dateCorrect = 0;
  for (const role of pred.roles) {
    const candidates = gold.roles
      .filter(
        (g) =>
          !usedRoles.has(g.id) &&
          g.kind === role.kind &&
          g.org.toLowerCase() === role.org.toLowerCase(),
      )
      .sort((a, b) => iou(role.span, b.header) - iou(role.span, a.header));
    const match = candidates[0];
    if (!match) continue;
    usedRoles.add(match.id);
    roleMap.set(role.key, match.id);
    dateCorrect +=
      Number(role.startDate === match.start) +
      Number(role.endDate === match.end);
  }
  const candidates: { p: number; g: number; overlap: number }[] = [];
  pred.facts.forEach((p, pi) =>
    gold.facts.forEach((g, gi) => {
      const overlap = iou(p.span, g.span);
      if (p.kind === g.kind && overlap >= 0.5)
        candidates.push({ p: pi, g: gi, overlap });
    }),
  );
  candidates.sort((a, b) => b.overlap - a.overlap || a.p - b.p || a.g - b.g);
  // Compute assignment on span-only pairs, so the metric can expose wrong-role
  // predictions instead of becoming 100% by definition.
  const spanP = new Set<number>();
  const spanG = new Set<number>();
  let assigned = 0;
  const correctRole = (pair: { p: number; g: number }) => {
    const p = pred.facts[pair.p]!;
    const g = gold.facts[pair.g]!;
    return (p.roleKey === null ? null : roleMap.get(p.roleKey)) === g.role;
  };
  for (const pair of candidates) {
    if (spanP.has(pair.p) || spanG.has(pair.g)) continue;
    spanP.add(pair.p);
    spanG.add(pair.g);
    if (correctRole(pair)) assigned++;
  }

  // Promotion precision/recall require both overlap and the correct role.
  // Match these separately so a higher-overlap wrong-role prediction cannot
  // consume a gold fact that a correctly assigned prediction also found.
  const matchedP = new Set<number>();
  const matchedG = new Set<number>();
  let correctLevel = 0;
  let levelCount = 0;
  let inflation = 0;
  for (const pair of candidates) {
    if (!correctRole(pair) || matchedP.has(pair.p) || matchedG.has(pair.g))
      continue;
    matchedP.add(pair.p);
    matchedG.add(pair.g);
    const p = pred.facts[pair.p]!;
    const g = gold.facts[pair.g]!;
    if (g.level !== null) {
      levelCount++;
      correctLevel += Number(p.level === g.level);
      inflation += Number(rankOf(p.level) > rankOf(g.level));
    }
  }
  // Coverage is separate from one-to-one fact matching, so compound bullets are visible.
  const covered = gold.facts.filter((g) =>
    pred.facts.some(
      (p) =>
        p.kind === g.kind &&
        Math.max(
          0,
          Math.min(p.span[1], g.span[1]) - Math.max(p.span[0], g.span[0]),
        ) /
          (g.span[1] - g.span[0]) >=
          0.5,
    ),
  ).length;
  const matched = matchedP.size;
  const precision = ratio(matched, pred.facts.length);
  const recall = ratio(matched, gold.facts.length);
  const trapLeaks = [...pred.roles, ...pred.facts].filter((item) =>
    gold.traps.some((trap) => iou(item.span, trap.span) > 0),
  ).length;
  return {
    precision,
    recall,
    f1:
      precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    evidenceCoverageRecall: ratio(covered, gold.facts.length),
    roleRecall: ratio(usedRoles.size, gold.roles.length),
    dateAccuracy: ratio(dateCorrect, usedRoles.size * 2),
    assignment: ratio(assigned, spanP.size),
    levelAccuracy: ratio(correctLevel, levelCount),
    inflation,
    trapLeaks,
    reviewCost:
      pred.facts.length -
      matched +
      3 * (gold.facts.length - matched) +
      0.5 * (levelCount - correctLevel),
    matched,
    proposed: pred.facts.length,
    expected: gold.facts.length,
  };
}
