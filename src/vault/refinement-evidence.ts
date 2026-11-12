import { AppError } from "../shared/errors";
import type { ResumeBody, ResumeLine } from "../shared/api";
import type { FactRecord, RoleRecord } from "../shared/types";
import { evidenceForFacts, sameEvidence, type ResumeVersion } from "./snapshots";

/** Preserve old evidence for unchanged lines and bind changed lines to the exact
 * facts that were captured and verified for this run. The same fact ID may be
 * used by both only if its complete immutable metadata is identical. */
export function mergeRefinementEvidence(
  base: ResumeVersion,
  body: ResumeBody,
  captured: FactRecord[],
  roles: RoleRecord[],
): Pick<ResumeVersion, "facts" | "evidence"> {
  const conflict = () => new AppError("conflict", "The resume or the facts behind it changed. Tailor a new resume, or choose different facts.");
  const expected = structuredClone(base.render.body);
  if (!!expected.summary !== !!body.summary || expected.sections.length !== body.sections.length)
    throw conflict();
  const changed = new Set<string>();
  const unchanged = new Set<string>();
  const seen = new Set<string>();
  const compare = (before: ResumeLine, after: ResumeLine) => {
    if (!before || !after || before.id !== after.id || seen.has(before.id) || !Array.isArray(after.factIds)) throw conflict();
    seen.add(before.id);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      // A changed line never carries a finding: it was about the earlier wording.
      if (!after.factIds.length || !["kept", "repaired", "replaced"].includes(after.status) || after.finding !== undefined)
        throw conflict();
      for (const id of after.factIds) changed.add(id);
      before.text = after.text;
      before.factIds = [...after.factIds];
      before.status = after.status;
      delete before.finding;
    } else {
      for (const id of before.factIds) unchanged.add(id);
    }
  };
  if (expected.summary && body.summary) compare(expected.summary, body.summary);
  for (let i = 0; i < expected.sections.length; i++) {
    const oldSection = expected.sections[i]!, nextSection = body.sections[i];
    if (!nextSection || !Array.isArray(nextSection.lines) || oldSection.lines.length !== nextSection.lines.length) throw conflict();
    const isChanged = oldSection.lines.some((line, j) => JSON.stringify(line) !== JSON.stringify(nextSection.lines[j]));
    if (isChanged) {
      const role = roles.find((item) => item.id === oldSection.roleId);
      if (!role || role.kind !== oldSection.kind || role.org !== oldSection.org ||
          role.title !== oldSection.title || role.startDate !== oldSection.startDate ||
          role.endDate !== oldSection.endDate ||
          (role.unknownEndStartDate ?? null) !== (oldSection.unknownEndStartDate ?? null)) throw conflict();
    }
    for (let j = 0; j < oldSection.lines.length; j++) compare(oldSection.lines[j]!, nextSection.lines[j]!);
  }
  // Refinement must not alter headings, ordering, skills, or any other fields.
  if (JSON.stringify(expected) !== JSON.stringify(body)) throw conflict();
  // Skills are rendered from facts without storing fact IDs, so protect every
  // old evidence record whose text matches a printed skill.
  for (const [id, fact] of Object.entries(base.facts))
    if (base.render.body.skills.includes(fact.text)) unchanged.add(id);
  const current = evidenceForFacts(captured);
  const facts = { ...base.facts };
  const evidence = { ...base.evidence };
  for (const id of changed) {
    const next = current[id];
    // Legacy versions are never printable until fresh per-line receipts are
    // revalidated. Rebinding here invalidates any older receipt whose fact
    // changed; it must not block recovery of other still-unverified lines.
    if (!next || (base.provenance !== "legacy" && unchanged.has(id) && (!sameEvidence(base.evidence?.[id], next) ||
        base.facts[id]?.text !== base.evidence?.[id]?.text ||
        base.facts[id]?.quote !== base.evidence?.[id]?.quote))) throw conflict();
    facts[id] = { text: next.text, quote: next.quote };
    evidence[id] = next;
  }
  return { facts, evidence };
}
