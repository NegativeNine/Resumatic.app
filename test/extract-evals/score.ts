import type { Span } from "../../src/grounding/offsets";
import type { VerifiedExtraction } from "../../src/pipeline/extract/types";
import type { FactKind, Level, RoleKind } from "../../src/shared/api";
import { scoreVerified } from "./score-core.mjs";

export interface Gold {
  roles: {
    id: string;
    kind: RoleKind;
    org: string;
    title: string | null;
    start: string | null;
    end: string | null;
    /** True only when evidence explicitly states that the role is ongoing. */
    current?: true;
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
  skillPrecision: number;
  skillRecall: number;
  skillsF1: number;
  skillMatched: number;
  skillProposed: number;
  skillExpected: number;
  evidenceCoverageRecall: number;
  roleRecall: number;
  dateAccuracy: number;
  roleMatched: number;
  roleExpected: number;
  dateCorrect: number;
  dateCount: number;
  assignment: number;
  levelAccuracy: number;
  inflation: number;
  trapLeaks: number;
  reviewCost: number;
  matched: number;
  proposed: number;
  expected: number;
}
/** Precision/recall require correct role; assignment is measured separately. */
export function scoreCase(pred: VerifiedExtraction, gold: Gold, markdown: string): CaseScore {
  return scoreVerified(pred, gold, markdown);
}
