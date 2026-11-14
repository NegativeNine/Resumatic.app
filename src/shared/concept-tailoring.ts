import type { ConceptKind } from "../taxonomy/types";

/** Private, immutable retrieval hints captured beside a generation's existing whole-line facts. */
export interface FactConceptEvidence {
  tagId: string;
  factId: string;
  factRevision: number;
  factText: string;
  conceptId: string;
  conceptKind: ConceptKind;
  label: string;
  taxonomyVersion: string;
  decidedAt: number;
  part?: { id: string; splitId: string; splitDecidedAt: number; ranges: { start: number; end: number }[]; text: string };
}

/** Owner-only coverage metadata. Never placed in printable reports, coach copies or MCP results. */
export interface ConceptCoverage {
  requirement: string;
  status: "supported" | "not_evidenced" | "unknown";
  factIds: string[];
  concepts: { id: string; label: string; factIds: string[] }[];
  conceptStatus: "tagged" | "unknown";
}

export interface ConceptSelection {
  method: "concept-evidence/1";
  taxonomyVersion: string;
  model: string;
  requirements: { id: string; text: string; concepts: { conceptId: string; conceptKind: ConceptKind; label: string; method: string }[]; status: "tagged" | "unknown"; unknownReason?: string }[];
  coverage: ConceptCoverage[];
}
