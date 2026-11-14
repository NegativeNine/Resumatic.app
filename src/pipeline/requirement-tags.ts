import type { Models } from "../ai/models";
import {
  tagUpload, type TagMade, type TagOptions, type TagReads, type TagReport, type TagMethod,
} from "./tag";
import type { ConceptKind } from "../taxonomy";

export const MAX_REQUIREMENT_ROWS = 25;
export const MAX_REQUIREMENT_TEXT_CHARS = 300;
export interface RequirementConcept {
  conceptId: string;
  conceptKind: ConceptKind;
  label: string;
  method: TagMethod;
}
export interface RequirementConceptSnapshot {
  id: string;
  text: string;
  concepts: RequirementConcept[];
  status: "tagged" | "unknown";
  unknownReason?: "no_candidate" | "declined" | "capped" | "failed";
}
export interface RequirementTagging {
  requirements: RequirementConceptSnapshot[];
  report: TagReport;
  model: string;
  taxonomyVersion: string;
}
/**
 * Ephemeral, versioned job-requirement hints. Never a statement about the applicant.
 * The selection/analysis caller captures this immutable result with its own inputs;
 * this helper writes no record tags and never changes a requirement's ID, text or order.
 */
export async function tagRequirements(
  models: Models, taxonomy: TagReads, requirements: readonly { id: string; text: string }[],
  made: TagMade, opts: TagOptions = {},
): Promise<RequirementTagging> {
  const concepts = new Map<string, RequirementConcept[]>();
  const looked = new Set<string>(); const considered = new Set<string>(); const asked = new Set<string>(); const capped = new Set<string>();
  const rows = requirements.slice(0, MAX_REQUIREMENT_ROWS).flatMap((row, index) => {
    const id = `requirement-${index}`;
    if (!row.text.trim() || row.text.length > MAX_REQUIREMENT_TEXT_CHARS) { capped.add(id); return []; }
    return [{ id, roleId: null, kind: "requirement", requirement: true, text: row.text, asWritten: false, held: [] }];
  });
  const report = await tagUpload(models, taxonomy, { roles: [], facts: rows, total: { roles: 0, facts: requirements.length } }, made,
    async (tags) => {
      let stored = 0;
      for (const tag of tags) {
        if (tag.subject.kind !== "requirement") continue;
        const held = concepts.get(tag.subject.id) ?? [];
        if (held.some((concept) => concept.conceptId === tag.conceptId)) continue;
        held.push({ conceptId: tag.conceptId, conceptKind: tag.conceptKind, label: tag.label, method: tag.method });
        concepts.set(tag.subject.id, held); stored++;
      }
      return { stored, refused: 0 };
    }, async () => [], { ...opts, observe: {
      candidates(id, count, cut) { looked.add(id); if (count) considered.add(id); if (cut) capped.add(id); opts.observe?.candidates?.(id, count, cut); },
      asked(id) { asked.add(id); opts.observe?.asked?.(id); },
      capped(id) { capped.add(id); opts.observe?.capped?.(id); },
    } });
  return { model: made.model, taxonomyVersion: made.taxonomyVersion, report,
    requirements: requirements.map((row, index): RequirementConceptSnapshot => {
      const id = `requirement-${index}`; const found = concepts.get(id) ?? [];
      if (found.length) return { id: row.id, text: row.text, concepts: found, status: "tagged" };
      const reason = index >= MAX_REQUIREMENT_ROWS || capped.has(id) ? "capped" : report.failed || report.vector.failed ? "failed" :
        asked.has(id) ? "declined" : considered.has(id) || !looked.has(id) ? "capped" : "no_candidate";
      return { id: row.id, text: row.text, concepts: [], status: "unknown", unknownReason: reason };
    }),
  };
}
