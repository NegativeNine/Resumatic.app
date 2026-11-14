import type { FactRecord } from "../shared/types";
import type { FactConceptEvidence } from "../shared/concept-tailoring";
import { partText, rangesProblem, type Range } from "../shared/record";
import { validConceptId } from "../taxonomy/ids.mjs";
import type { ConceptKind } from "../taxonomy/types";

export const MAX_CAPTURED_CONCEPT_TAGS = 2048;
interface TagRow {
  id: string; subject_kind: string; subject_id: string; concept_id: string; concept_kind: string;
  label: string; taxonomy_version: string | null; state: string; shadow: number; decided_at: number | null;
}
function captured(sql: SqlStorage, row: TagRow, facts: ReadonlyMap<string, FactRecord>): FactConceptEvidence | null {
  if (row.state !== "confirmed" || row.shadow !== 0 || !row.taxonomy_version || !row.decided_at || !validConceptId(row.concept_id)) return null;
  let fact: FactRecord | undefined, part: FactConceptEvidence["part"];
  if (row.subject_kind === "fact") fact = facts.get(row.subject_id);
  else if (row.subject_kind === "part") {
    const p = sql.exec<{ id: string; split_id: string; fact_id: string; ranges: string; decided_at: number | null }>(
      `SELECT p.id,p.split_id,s.fact_id,p.ranges,s.decided_at FROM fact_parts p JOIN fact_splits s ON s.id=p.split_id
       WHERE p.id=? AND s.state='confirmed' AND s.shadow=0`, row.subject_id,
    ).toArray()[0];
    if (!p || !p.decided_at) return null;
    fact = facts.get(p.fact_id);
    if (!fact) return null;
    let ranges: Range[];
    try { ranges = JSON.parse(p.ranges); } catch { return null; }
    if (rangesProblem(fact.text, ranges)) return null;
    part = { id: p.id, splitId: p.split_id, splitDecidedAt: p.decided_at, ranges, text: partText(fact.text, ranges) };
  }
  if (!fact || !Number.isSafeInteger(fact.revision)) return null;
  return { tagId: row.id, factId: fact.id, factRevision: fact.revision!, factText: fact.text, conceptId: row.concept_id,
    conceptKind: row.concept_kind as ConceptKind, label: row.label, taxonomyVersion: row.taxonomy_version, decidedAt: row.decided_at,
    ...(part ? { part } : {}) };
}

/** Reads only confirmed, visible tags whose parent fact is already usable for generation. */
export function captureConceptEvidence(sql: SqlStorage, usableFacts: FactRecord[]): FactConceptEvidence[] {
  const facts = new Map(usableFacts.map((fact) => [fact.id, fact]));
  const found: FactConceptEvidence[] = [];
  for (const row of sql.exec<TagRow>(`SELECT * FROM record_tags WHERE state='confirmed' AND shadow=0 AND subject_kind IN ('fact','part') ORDER BY created_at,id LIMIT ?`, MAX_CAPTURED_CONCEPT_TAGS)) {
    const entry = captured(sql, row, facts);
    if (entry) found.push(entry);
  }
  return found;
}

/** Re-deciding, deleting or rewording any captured tag/split makes the old retrieval hints stale. */
export function conceptEvidenceCurrent(sql: SqlStorage, entries: FactConceptEvidence[], usableFacts: FactRecord[]): boolean {
  if (!Array.isArray(entries) || entries.length > MAX_CAPTURED_CONCEPT_TAGS) return false;
  const facts = new Map(usableFacts.map((fact) => [fact.id, fact]));
  return entries.every((entry) => {
    const row = sql.exec<TagRow>(`SELECT * FROM record_tags WHERE id=?`, entry.tagId).toArray()[0];
    const live = row ? captured(sql, row, facts) : null;
    return live !== null && JSON.stringify(live) === JSON.stringify(entry);
  });
}
