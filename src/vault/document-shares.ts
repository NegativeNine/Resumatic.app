import { checkClaim } from "../grounding/claims";
import { authoritativeFact } from "../grounding/verdict";
import { isInstruction } from "../pipeline/extract/verify";
import { AppError } from "../shared/errors";
import type { SharedDocument } from "../shared/sharing";
import type { FactRecord } from "../shared/types";
import { isWithheld, type Withheld } from "./sensitive";
import { completeEvidence } from "./snapshots";

/** A saved document version, as far as sharing reads it. Everything in it is checked before use. */
export interface DocumentVersion {
  result?: { kind?: unknown; units?: unknown; questions?: unknown } | null;
  facts?: Record<string, { text: string; quote: string | null }>;
  /**
   * Full immutable evidence for the facts a letter or preparation was written from. Documents made
   * before it was kept have none, and cannot be shared: text alone cannot show what a sentence
   * was checked against.
   */
  evidence?: Record<string, FactRecord>;
}

export const SHAREABLE_DOCUMENT_KINDS = ["letter", "prep"] as const;
const MAX_UNITS = 400;
const MAX_QUESTIONS = 8;

/**
 * The words of a cover letter or interview preparation, for a copy. A document is shared only if
 * every sentence in it still passes the deterministic checks against the evidence captured when
 * it was written: the same gate a resume passes before it is exported or shared. Given the facts
 * withheld now, a sentence that cites one, or was checked against the line one was read from, is
 * refused in the same words.
 */
export function sharedDocument(id: string, version: number, kind: string, data: DocumentVersion | null | undefined, withheld?: Withheld): SharedDocument {
  const refuse = () => new AppError("conflict", "this document can't be shared as it is; write it again, then share the new one");
  if (typeof id !== "string" || !id || !Number.isSafeInteger(version) || version < 1) throw refuse();
  if (kind !== "letter" && kind !== "prep") throw refuse();
  const result = data?.result;
  const facts = data?.facts;
  const evidence = data?.evidence;
  if (!result || typeof result !== "object" || result.kind !== kind || !Array.isArray(result.units) || !Array.isArray(result.questions) ||
      !facts || typeof facts !== "object" || Array.isArray(facts) || !evidence || typeof evidence !== "object" || Array.isArray(evidence))
    throw refuse();
  const rawUnits = result.units as unknown[];
  const rawQuestions = result.questions as unknown[];
  if (rawUnits.length === 0 || rawUnits.length > MAX_UNITS || rawQuestions.length > MAX_QUESTIONS) throw refuse();

  const seen = new Set<string>();
  const units = rawUnits.map((value) => {
    const unit = value as { id?: unknown; roleId?: unknown; text?: unknown; factIds?: unknown; group?: unknown; status?: unknown } | null;
    if (!unit || typeof unit !== "object" || typeof unit.id !== "string" || !unit.id || seen.has(unit.id) ||
        typeof unit.text !== "string" || !unit.text.trim() || isInstruction(unit.text) ||
        !["kept", "repaired", "replaced"].includes(unit.status as string) ||
        !Number.isSafeInteger(unit.group) || (unit.group as number) < 0 ||
        (unit.roleId !== null && (typeof unit.roleId !== "string" || !unit.roleId)) ||
        !Array.isArray(unit.factIds) || unit.factIds.length === 0)
      throw refuse();
    seen.add(unit.id);
    const cited = (unit.factIds as unknown[]).map((factId) => {
      if (typeof factId !== "string" || !Object.hasOwn(facts, factId) || !Object.hasOwn(evidence, factId)) throw refuse();
      const stored = facts[factId];
      const full = evidence[factId];
      // The stored text and the full record must be the same fact, and a sentence under a role may
      // cite only that role's facts, or a fact could be moved under another employer.
      if (!stored || !completeEvidence(full) || full.id !== factId || full.text !== stored.text || full.quote !== stored.quote ||
          (unit.roleId !== null && full.roleId !== unit.roleId))
        throw refuse();
      // Calculated skill totals have an explicit resume-only owner selection path. No generic
      // letter/preparation projection may acquire that authority from a stored backing row.
      if (full.skillDuration || withheld?.invalidDerived?.has(factId)) throw refuse();
      // A fact its owner has marked since supports nothing that is sent to someone else.
      if (withheld && isWithheld(factId, stored, withheld)) throw refuse();
      const safe = authoritativeFact(full);
      return { text: safe.text, quote: safe.quote, level: safe.level };
    });
    // The numbers, names and scope a sentence states have to be in what it cites, checked now as
    // well as when it was written.
    if (!checkClaim(unit.text, cited).ok) throw refuse();
    return { text: unit.text, group: unit.group as number };
  });

  if (kind === "letter") {
    if (rawQuestions.length !== 0) throw refuse();
    const groups = [...new Set(units.map((unit) => unit.group))].sort((a, b) => a - b);
    return {
      id, version, kind,
      // As the Word export joins them: a paragraph is its sentences in order.
      paragraphs: groups.map((group) => units.filter((unit) => unit.group === group).map((unit) => unit.text).join(" ")),
      questions: [],
    };
  }
  if (rawQuestions.length === 0 || units.some((unit) => unit.group >= rawQuestions.length)) throw refuse();
  return {
    id, version, kind,
    paragraphs: [],
    questions: rawQuestions.map((value, index) => {
      const question = (value as { question?: unknown } | null)?.question;
      if (typeof question !== "string" || !question.trim() || question.length > 1000 || isInstruction(question)) throw refuse();
      return { question, points: units.filter((unit) => unit.group === index).map((unit) => unit.text) };
    }),
  };
}

/** Whether a document could go into a copy now. Says nothing about why not. */
export function canShareDocument(id: string, version: number, kind: string, data: DocumentVersion | null | undefined, withheld?: Withheld): boolean {
  try {
    sharedDocument(id, version, kind, data, withheld);
    return true;
  } catch {
    return false;
  }
}
