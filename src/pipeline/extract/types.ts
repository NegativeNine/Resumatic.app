import type { Models } from "../../ai/models";
import type { Span } from "../../grounding/offsets";
import type { ExtractedFact, ExtractedRole } from "../../shared/types";
export const MAX_MARKDOWN_CHARS = 60_000;
export interface ExtractInput {
  markdown: string;
  filename: string;
  referenceDate: string;
}
export interface Provenance {
  span?: Span;
  confidence?: number | null;
  reviewReasons?: string[];
}
export interface RawExtraction {
  roles: (ExtractedRole & Provenance)[];
  facts: (ExtractedFact & Provenance)[];
}
export interface VerifiedExtraction {
  roles: (ExtractedRole & Provenance & { span: Span })[];
  facts: (ExtractedFact & Provenance & { span: Span })[];
}
export interface Extractor {
  readonly id: string;
  extract(input: ExtractInput, models: Models): Promise<RawExtraction>;
}
export type DropReason =
  | "invalid_quote"
  | "invalid_span"
  | "instruction"
  | "unsupported_role"
  | "unsupported_claim"
  | "duplicate_key";
export interface ExtractionVerification {
  extraction: VerifiedExtraction;
  dropped: { kind: "role" | "fact"; reason: DropReason }[];
}
