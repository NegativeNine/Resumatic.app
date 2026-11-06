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
/** Precision/recall require correct role; assignment is measured separately. */
export function scoreCase(pred: VerifiedExtraction, gold: Gold): CaseScore {
  return scoreVerified(pred, gold);
}
