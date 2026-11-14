import type { FactView, RoleView } from "./api";
import type { ConceptTag, FactPart, FactSplit, JudgementState, RecordLink } from "./record";

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
export interface SemanticOfferReview {
  link: RecordLink;
  from: FactView;
  to: FactView;
  fromRole: RoleView | null;
  toRole: RoleView | null;
}
export interface SemanticOfferDecision {
  decision: "confirmed" | "rejected";
  expectedFromRevision: number;
  expectedToRevision: number;
  expectedFromRoleRevision: number | null;
  expectedToRoleRevision: number | null;
  expectedState: JudgementState;
  expectedDecidedAt: number | null;
}
export interface RecordProposals {
  offers: SemanticOfferReview[];
  facts: FactProposalReview[];
  roles: RoleProposalReview[];
}
export interface ProposalDecision {
  decision: "confirmed" | "rejected";
  expectedSubjectRevision: number;
  expectedState: JudgementState;
  expectedDecidedAt: number | null;
}
