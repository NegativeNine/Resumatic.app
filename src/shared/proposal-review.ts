import type { FactView, RoleView } from "./api";
import type { ConceptTag, FactPart, FactSplit, JudgementState } from "./record";

/** Owner-only proposal views. Shadow judgements are never included or promoted. */
export interface FactProposalReview {
  fact: FactView;
  split: FactSplit | null;
  tags: ConceptTag[];
  partTags: { part: FactPart; tags: ConceptTag[] }[];
}
export interface RoleProposalReview {
  role: RoleView;
  tags: ConceptTag[];
}
export interface RecordProposals {
  facts: FactProposalReview[];
  roles: RoleProposalReview[];
}
export interface ProposalDecision {
  decision: "confirmed" | "rejected";
  expectedSubjectRevision: number;
  expectedState: JudgementState;
  expectedDecidedAt: number | null;
}
