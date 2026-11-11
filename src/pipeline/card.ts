import { AppError } from "../shared/errors";
import {
  CARD_PREVIEW_OFF,
  EXPERIENCE_BANDS,
  MAX_CARD_OCCUPATION_CANDIDATES,
  MAX_CARD_SKILLS,
  MAX_CARD_SKILL_READS,
  MAX_CARD_TEXT_CHARS,
  MAX_CARD_WALK_DEPTH,
  MAX_CARD_WALK_IDS,
  type CardConcept,
  type CardMaterial,
  type CardPreview,
  type ExperienceBand,
} from "../shared/card";
import { D1Store, type Concept, type ConceptKind, type TaxonomyStore } from "../taxonomy";

// The owner's private card, built by code from the material their Vault gives (src/vault/card.ts)
// and the taxonomy. No model is asked, nothing is spent, nothing is stored and nothing is retried:
// the card is worked out again on every load, and shown to its owner alone.
//
// Every label on a card is the taxonomy's own `Concept.label`, never the label a tag stored, and
// every skill is shown at the group above it. Whatever can't be settled within the bounds below is
// left off: a card shows less, never something its owner's confirmed tags do not say.
//
// The reads are bounded by construction, and have not been measured: one `taxonomy_meta` read, one
// batch of at most 8 occupations, one of at most 24 skills, and a walk of at most 12 levels and
// 400 concepts, which is at most 17 `fromAny` and 17 `concepts` statements. 37 in all.

/** The taxonomy reads a card makes. The same `broader` relations `Taxonomy.broader` reads. */
export type CardReads = Pick<TaxonomyStore, "info" | "concepts" | "fromAny">;

/**
 * The owner's preview. Refused unless switched on; unavailable without a wholly loaded taxonomy,
 * and then the Vault is never asked. A D1 fault is not caught: it reaches the fixed 500.
 */
export async function cardPreviewFor(
  env: { CARD_PREVIEW_ENABLED?: string; TAXONOMY?: D1Database },
  readMaterial: () => Promise<CardMaterial>,
  now: number,
  reads: CardReads | null = env.TAXONOMY ? new D1Store(env.TAXONOMY) : null,
): Promise<CardPreview> {
  if (env.CARD_PREVIEW_ENABLED !== "true") throw new AppError("unavailable", CARD_PREVIEW_OFF);
  if (!reads) return { state: "unavailable" };
  // Null for a database with nothing in it and for one only part loaded.
  const info = await reads.info();
  if (!info) return { state: "unavailable" };
  return buildCard(await readMaterial(), reads, info.version, now);
}

// ---------------------------------------------------------------- experience

/** Month edges of the bands: 2, 5 and 10 years. scripts/reid/ladder.mjs uses the same edges and changes with these. */
const BAND_EDGES = [24, 60, 120] as const;
const MONTH = /^(\d{4})(?:-(\d{2}))?$/;

/** The earliest and latest month a date can mean, as year × 12 + month − 1. A year alone is January to December. */
function months(date: string): [earliest: number, latest: number] | null {
  const found = MONTH.exec(date);
  if (!found) return null;
  const year = Number(found[1]);
  if (found[2] === undefined) return [year * 12, year * 12 + 11];
  const month = Number(found[2]);
  if (month < 1 || month > 12) return null;
  return [year * 12 + month - 1, year * 12 + month - 1];
}

/** Months covered by a set of inclusive intervals, each month counted once. */
function covered(intervals: [number, number][]): number {
  const sorted = intervals.filter(([start, end]) => end >= start).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let at = -Infinity;
  for (const [start, end] of sorted) {
    const from = Math.max(start, at);
    if (end >= from) total += end - from + 1;
    at = Math.max(at, end + 1);
  }
  return total;
}

function band(count: number): ExperienceBand {
  const index = BAND_EDGES.findIndex((edge) => count < edge);
  return EXPERIENCE_BANDS[index === -1 ? EXPERIENCE_BANDS.length - 1 : index]!;
}

/**
 * Overall experience from the dates of confirmed jobs, with overlaps counted once. Null without a
 * job. Unknown when any job has no known start, an unknown end included, or when the shortest and
 * the longest reading of the dates fall in different bands: a year alone can mean any of its
 * months. A current job runs to the UTC month of `now`, and no end is later than that.
 */
export function experienceOf(jobs: CardMaterial["jobs"], now: number): ExperienceBand | "unknown" | null {
  if (!jobs.length) return null;
  const today = new Date(now);
  const current = today.getUTCFullYear() * 12 + today.getUTCMonth();
  const shortest: [number, number][] = [];
  const longest: [number, number][] = [];
  for (const job of jobs) {
    if (job.startDate === null) return "unknown";
    const start = months(job.startDate);
    const end = job.endDate === null ? ([current, current] as [number, number]) : months(job.endDate);
    if (!start || !end) return "unknown";
    shortest.push([start[1], Math.min(end[0], current)]);
    longest.push([start[0], Math.min(end[1], current)]);
  }
  const low = band(covered(shortest));
  return low === band(covered(longest)) ? low : "unknown";
}

// ---------------------------------------------------------------- occupation

/** The latest month a date can mean, or -Infinity for none. */
const latest = (date: string | null) => (date === null ? -Infinity : (months(date)?.[1] ?? -Infinity));

/**
 * Which source's occupation comes first within a job: ESCO's, which alone has an ISCO group above
 * it, then O*NET's, then an ISCO group. Told from the ID, which names its source and kind.
 */
function occupationRank(id: string): number {
  if (id.startsWith("esco:occupation:")) return 0;
  if (id.startsWith("onet:occ:")) return 1;
  if (id.startsWith("esco:isco:")) return 2;
  return 3;
}

/**
 * The occupations of confirmed jobs in the order a card considers them, at most 8: current jobs
 * first, then the latest end, then the latest start; within a job, ESCO's occupation, O*NET's, an
 * ISCO group, then by ID.
 */
export function occupationOrder(jobs: CardMaterial["jobs"]): string[] {
  const keyed = jobs.map((job) => ({
    current: job.endDate === null && job.startDate !== null,
    end: latest(job.endDate),
    start: latest(job.startDate ?? job.unknownEndStartDate),
    occupations: [...job.occupations].sort((a, b) => occupationRank(a) - occupationRank(b) || (a < b ? -1 : a > b ? 1 : 0)),
  }));
  keyed.sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      (b.end === a.end ? 0 : b.end > a.end ? 1 : -1) ||
      (b.start === a.start ? 0 : b.start > a.start ? 1 : -1) ||
      // Jobs alike in every date are put in a fixed order, so the same record always gives the same card.
      (a.occupations.join() < b.occupations.join() ? -1 : a.occupations.join() > b.occupations.join() ? 1 : 0),
  );
  return [...new Set(keyed.flatMap((job) => job.occupations))].slice(0, MAX_CARD_OCCUPATION_CANDIDATES);
}

// ---------------------------------------------------------------- skills

/** The kind of group a concept is shown as, or null when a card can't show it. */
function groupKind(kind: ConceptKind): ConceptKind | null {
  if (kind === "skill" || kind === "knowledge") return "skill-group";
  if (kind === "tool") return "tool-category";
  return null;
}

const isGroup = (kind: ConceptKind) => kind === "skill-group" || kind === "tool-category";

/**
 * The group each concept is shown as: a skill or a piece of knowledge at its nearest skill group,
 * a tool at its nearest tool category, and a group as itself. Nearest is the fewest `broader`
 * steps, and a tie at one level goes to the lowest ID. Every concept is walked together, one level
 * at a time: at each level one `fromAny` for the nodes not yet read and one `concepts` for the
 * concepts not yet seen. A concept stops being followed once it has its group. One the taxonomy
 * doesn't hold, one of another kind, one with no group within 12 levels, and every one still
 * unresolved when the walk would read more than 400 concepts, is left out of the map.
 */
export async function groupsOf(concepts: Concept[], reads: Pick<CardReads, "concepts" | "fromAny">): Promise<Map<string, Concept>> {
  const groups = new Map<string, Concept>();
  /** Every concept read, or null for an ID the taxonomy doesn't hold. */
  const known = new Map<string, Concept | null>();
  /** Each concept still looking for its group, and every node it has reached. */
  const seen = new Map<string, Set<string>>();
  /** Each node to be followed at the next level, and the concepts that reach it. */
  let frontier = new Map<string, Set<string>>();
  const reach = (map: Map<string, Set<string>>, key: string, value: string) => {
    const set = map.get(key) ?? new Set<string>();
    set.add(value);
    map.set(key, set);
  };
  for (const concept of concepts) {
    known.set(concept.id, concept);
    if (isGroup(concept.kind)) groups.set(concept.id, concept);
    else if (groupKind(concept.kind)) {
      seen.set(concept.id, new Set([concept.id]));
      reach(frontier, concept.id, concept.id);
    }
  }

  /** The `broader` targets of each node already asked about. A node is asked about once. */
  const above = new Map<string, string[]>();
  let read = 0;
  for (let depth = 1; depth <= MAX_CARD_WALK_DEPTH && frontier.size; depth++) {
    const ask = [...frontier.keys()].filter((id) => !above.has(id)).sort();
    if (ask.length) {
      for (const id of ask) above.set(id, []);
      for (const edge of await reads.fromAny(ask, ["broader"])) if (edge.rel === "broader") above.get(edge.src)?.push(edge.dst);
    }
    /** For each concept, the nodes it reaches for the first time at this level. */
    const reached = new Map<string, Set<string>>();
    for (const [node, concepts] of frontier)
      for (const dst of above.get(node) ?? [])
        for (const concept of concepts) {
          const nodes = seen.get(concept)!;
          if (nodes.has(dst)) continue;
          nodes.add(dst);
          reach(reached, concept, dst);
        }
    const fresh = [...new Set([...reached.values()].flatMap((nodes) => [...nodes]))].filter((id) => !known.has(id)).sort();
    // Past the bound the walk stops, and whatever has no group yet is left off.
    if (read + fresh.length > MAX_CARD_WALK_IDS) break;
    read += fresh.length;
    if (fresh.length) {
      for (const id of fresh) known.set(id, null);
      for (const concept of await reads.concepts(fresh)) if (known.has(concept.id)) known.set(concept.id, concept);
    }
    const next = new Map<string, Set<string>>();
    for (const [concept, nodes] of reached) {
      const wanted = groupKind(known.get(concept)!.kind);
      const found = [...nodes].filter((id) => known.get(id)?.kind === wanted).sort();
      if (found.length) {
        groups.set(concept, known.get(found[0]!)!);
        continue;
      }
      // A node the taxonomy doesn't hold is not followed.
      for (const id of nodes) if (known.get(id)) reach(next, id, concept);
    }
    frontier = next;
  }
  return groups;
}

// ---------------------------------------------------------------- the card

/** A concept as the card shows it, or null for one whose ID or label a card can't carry. */
function shown(concept: Concept): CardConcept | null {
  const fits = (text: string) => text.length >= 1 && text.length <= MAX_CARD_TEXT_CHARS;
  return fits(concept.id) && fits(concept.label) ? { id: concept.id, label: concept.label } : null;
}

/**
 * The card for this material. The occupation is the first, in `occupationOrder`, that the taxonomy
 * holds as an occupation or an ISCO group. Skills are taken in rank order, the first 24 read, each
 * shown as its group once, up to 12. A concept the material bars is never shown: the Vault has
 * already left it out as a skill, and here it is left out as a group, so that a group a marked
 * fact names does not come back as the group of another fact's skill.
 */
export async function buildCard(material: CardMaterial, reads: CardReads, version: string, now: number): Promise<CardPreview> {
  let occupation: CardConcept | null = null;
  const order = occupationOrder(material.jobs);
  if (order.length) {
    const found = new Map((await reads.concepts(order)).map((concept) => [concept.id, concept]));
    for (const id of order) {
      const concept = found.get(id);
      if (!concept || (concept.kind !== "occupation" && concept.kind !== "occupation-group")) continue;
      occupation = shown(concept);
      if (occupation) break;
    }
  }

  const barred = new Set(material.barred);
  const ranked = material.skills
    .filter((skill) => !barred.has(skill.conceptId))
    .slice(0, MAX_CARD_SKILL_READS)
    .map((skill) => skill.conceptId);
  const groups = ranked.length ? await groupsOf(await reads.concepts(ranked), reads) : new Map<string, Concept>();
  const skills: CardConcept[] = [];
  const held = new Set<string>();
  for (const id of ranked) {
    if (skills.length >= MAX_CARD_SKILLS) break;
    const group = groups.get(id);
    const card = group && !held.has(group.id) && !barred.has(group.id) ? shown(group) : null;
    if (!card) continue;
    held.add(card.id);
    skills.push(card);
  }

  return { state: "ready", taxonomyVersion: version, card: { occupation, experience: experienceOf(material.jobs, now), skills } };
}
