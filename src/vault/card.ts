import type { CardMaterial } from "../shared/card";
import type { ConceptTag } from "../shared/record";
import type { FactRecord, RoleRecord } from "../shared/types";
import type { RecordStore } from "./record";

// What the owner's private card is built from, read from the record in one synchronous turn. The
// Vault gives the Worker concept IDs, how many facts show each, and the dates of confirmed jobs:
// never a name, an organisation, a title, a row ID or the words of a fact. The Worker turns them
// into taxonomy groups (src/pipeline/card.ts). docs/visibility-design.md says why each field is
// read the way it is.

/** A fact's kinds whose tags a card counts. A skills-list item is self-declared, and the card shows evidenced skills only. */
const EVIDENCED_KINDS: ReadonlySet<string> = new Set(["accomplishment", "credential"]);
/** What a fact shows or uses. What it does is an activity or a task, and a card lists skills. */
const SKILL_RELATIONS: ReadonlySet<string> = new Set(["shows", "uses"]);

/**
 * The material for a card. `usable` is `usableFacts()`, `withheld` the IDs of the facts marked
 * sensitive, and `jobs` the confirmed roles of kind job. Only confirmed tags that are not in
 * shadow count; a shadow tag is kept to be measured and read by nothing else.
 *
 * A concept that any tag on a withheld fact names, in any state, or on a part of that fact's
 * division, is left out altogether, even where an unmarked fact shows it too: a card that still
 * showed it would still say what the marked line says.
 */
export function readCardMaterial(
  record: Pick<RecordStore, "tags" | "split">,
  usable: readonly Pick<FactRecord, "id" | "kind">[],
  withheld: ReadonlySet<string>,
  jobs: readonly RoleRecord[],
): CardMaterial {
  const barred = new Set<string>();
  for (const id of withheld) {
    for (const tag of record.tags({ kind: "fact", id })) barred.add(tag.conceptId);
    for (const part of record.split(id)?.parts ?? []) for (const tag of record.tags({ kind: "part", id: part.id })) barred.add(tag.conceptId);
  }

  const shownBy = new Map<string, Set<string>>();
  for (const fact of usable) {
    if (!EVIDENCED_KINDS.has(fact.kind)) continue;
    const tags: ConceptTag[] = record.tags({ kind: "fact", id: fact.id }, { state: "confirmed" });
    // A part's tags count only once the owner has accepted the division they are on.
    const split = record.split(fact.id);
    if (split?.state === "confirmed")
      for (const part of split.parts) tags.push(...record.tags({ kind: "part", id: part.id }, { state: "confirmed" }));
    for (const tag of tags) {
      if (!SKILL_RELATIONS.has(tag.relation) || barred.has(tag.conceptId)) continue;
      const facts = shownBy.get(tag.conceptId) ?? new Set<string>();
      facts.add(fact.id);
      shownBy.set(tag.conceptId, facts);
    }
  }
  const skills = [...shownBy]
    .map(([conceptId, facts]) => ({ conceptId, facts: facts.size }))
    .sort((a, b) => b.facts - a.facts || (a.conceptId < b.conceptId ? -1 : a.conceptId > b.conceptId ? 1 : 0));

  return {
    jobs: jobs.map((job) => ({
      startDate: job.startDate,
      endDate: job.endDate,
      unknownEndStartDate: job.unknownEndStartDate ?? null,
      occupations: record
        .tags({ kind: "role", id: job.id }, { state: "confirmed" })
        .filter((tag) => tag.relation === "occupation")
        .map((tag) => tag.conceptId),
    })),
    skills,
  };
}
