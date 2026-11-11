import { AppError } from "../shared/errors";
import { validConceptId } from "./ids.mjs";
import { normalizeLabel, wordRuns, words } from "./normalize.mjs";
import type { TaxonomyStore } from "./store";
import {
  LABEL_TYPES,
  MATCH_TYPES,
  type Concept,
  type ConceptKind,
  type MatchType,
  type Mention,
  type OccupationProfile,
  type TaxonomyInfo,
  type Via,
} from "./types";

/** The longest text looked through in one call. A resume line or a job requirement is far shorter. */
export const MAX_MENTION_TEXT_CHARS = 20_000;
const MAX_COUNTERPARTS = 8;
const MAX_DEPTH = 12;

const typeRank = (type: string) => LABEL_TYPES.indexOf(type as (typeof LABEL_TYPES)[number]);
const matchRank = (type: MatchType | null) => (type === null ? -1 : MATCH_TYPES.indexOf(type));
const isMatch = (value: unknown): value is MatchType => (MATCH_TYPES as readonly unknown[]).includes(value);

/**
 * The combined taxonomy as the pipelines use it. It only ever answers from the stored records: it
 * finds labels that are in a text, and says what the sources relate a concept to. It never decides
 * that a text means a concept. A mention is a candidate for a later, checked step.
 */
export class Taxonomy {
  constructor(private readonly store: TaxonomyStore) {}

  /** The loaded taxonomy's version, to stamp on anything derived from it. */
  async info(): Promise<TaxonomyInfo> {
    const info = await this.store.info();
    if (!info) throw new AppError("unavailable", "the taxonomy is not loaded");
    return info;
  }

  /** The concepts with these IDs, by ID. Unknown and malformed IDs are absent. */
  async get(ids: readonly string[]): Promise<Map<string, Concept>> {
    const found = await this.store.concepts(ids.filter(validConceptId));
    return new Map(found.map((concept) => [concept.id, concept]));
  }

  /** The concepts that carry exactly this label, strongest label type first. */
  async lookup(label: string, opts: { kinds?: readonly ConceptKind[] } = {}): Promise<Mention["concepts"]> {
    const norm = normalizeLabel(label);
    if (!norm) return [];
    return (await this.store.labels([norm], opts.kinds))
      .map((found) => ({ id: found.conceptId, kind: found.kind, type: found.type, matched: found.text }))
      .sort((a, b) => typeRank(a.type) - typeRank(b.type) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * The labels that appear, word for word, in a text: each with where it is and whose label it is.
   * A label inside a longer one that was also found is left out unless `keepContained` is set, so
   * "project management software" is one mention, not three.
   */
  async mentions(
    text: string,
    opts: { kinds?: readonly ConceptKind[]; maxWords?: number; keepContained?: boolean } = {},
  ): Promise<Mention[]> {
    if (text.length > MAX_MENTION_TEXT_CHARS) throw new AppError("invalid", "this text is too long to look through");
    const list = words(text);
    const runs = wordRuns(list, Math.min(Math.max(opts.maxWords ?? 6, 1), 8));
    if (runs.length === 0) return [];
    const labels = await this.store.labels([...new Set(runs.map(([, , norm]) => norm))], opts.kinds);
    if (labels.length === 0) return [];
    const byNorm = new Map<string, Mention["concepts"]>();
    for (const label of labels) {
      const entry = { id: label.conceptId, kind: label.kind, type: label.type, matched: label.text };
      const known = byNorm.get(label.norm);
      if (known) known.push(entry);
      else byNorm.set(label.norm, [entry]);
    }
    for (const concepts of byNorm.values())
      concepts.sort((a, b) => typeRank(a.type) - typeRank(b.type) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const found: (Mention & { count: number })[] = [];
    for (const [first, count, norm] of runs) {
      const concepts = byNorm.get(norm);
      if (!concepts) continue;
      const start = list[first]!.start;
      const end = list[first + count - 1]!.end;
      const written = text.slice(start, end);
      found.push({ start, end, text: written, norm, concepts, weak: count === 1 && weakWord(written, norm, concepts), count });
    }
    const kept = opts.keepContained
      ? found
      : found.filter((mention) => !found.some((other) => other !== mention && other.start <= mention.start && other.end >= mention.end && other.end - other.start > mention.end - mention.start));
    return kept
      .sort((a, b) => a.start - b.start || b.end - a.end)
      .map(({ count: _count, ...mention }) => mention);
  }

  /** The concepts above this one in its own hierarchy, nearest first. */
  async broader(id: string): Promise<Concept[]> {
    const order: string[] = [];
    const seen = new Set([id]);
    let level = [id];
    for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
      const next: string[] = [];
      for (const current of level)
        for (const edge of await this.store.from(current, ["broader"]))
          if (!seen.has(edge.dst)) {
            seen.add(edge.dst);
            order.push(edge.dst);
            next.push(edge.dst);
          }
      level = next;
    }
    const concepts = await this.get(order);
    return order.map((found) => concepts.get(found)).filter((concept): concept is Concept => concept !== undefined);
  }

  /**
   * One occupation seen through both sources. What ESCO or O*NET says of the occupation itself
   * comes first; what they say of the occupations the official crosswalk relates it to follows,
   * closest match first, and every item says which occupation's record it comes from.
   */
  async profile(occupationId: string): Promise<OccupationProfile | null> {
    const occupation = (await this.get([occupationId])).get(occupationId);
    if (!occupation || occupation.kind !== "occupation") return null;

    // The crosswalk runs from O*NET to ESCO, so it is read forwards for one and backwards for the other.
    const links =
      occupation.scheme === "onet"
        ? (await this.store.from(occupation.id, ["matches"])).map((edge) => ({ id: edge.dst, type: edge.meta?.type }))
        : (await this.store.to(occupation.id, ["matches"])).map((edge) => ({ id: edge.src, type: edge.meta?.type }));
    const linked = await this.get(links.map((link) => link.id));
    const counterparts = links
      .flatMap((link) => {
        const concept = linked.get(link.id);
        return concept?.kind === "occupation" && isMatch(link.type) ? [{ concept, match: link.type }] : [];
      })
      .sort((a, b) => matchRank(a.match) - matchRank(b.match) || (a.concept.id < b.concept.id ? -1 : 1))
      .slice(0, MAX_COUNTERPARTS);

    const sources: { concept: Concept; via: Via }[] = [
      { concept: occupation, via: { occupation: occupation.id, match: null } },
      ...counterparts.map(({ concept, match }) => ({ concept, via: { occupation: concept.id, match } })),
    ];
    const skills = new Map<string, { via: Via; need: "essential" | "optional" }>();
    const activities = new Map<string, { via: Via; tasks: number }>();
    const tools = new Map<string, { via: Via; inDemand: boolean; hot: boolean }>();
    // Sources are in order of closeness, so the first record to name a concept is the one kept.
    for (const { concept, via } of sources) {
      if (concept.scheme === "esco") {
        for (const edge of await this.store.from(concept.id, ["essential", "optional"]))
          if (!skills.has(edge.dst)) skills.set(edge.dst, { via, need: edge.rel === "essential" ? "essential" : "optional" });
      } else {
        for (const edge of await this.store.from(concept.id, ["performs", "uses"])) {
          if (edge.rel === "performs") {
            if (!activities.has(edge.dst)) activities.set(edge.dst, { via, tasks: typeof edge.meta?.tasks === "number" ? edge.meta.tasks : 0 });
          } else if (!tools.has(edge.dst)) tools.set(edge.dst, { via, inDemand: edge.meta?.inDemand === true, hot: edge.meta?.hot === true });
        }
      }
    }
    const named = await this.get([...skills.keys(), ...activities.keys(), ...tools.keys()]);
    const items = <T extends { via: Via }>(found: Map<string, T>) =>
      [...found].flatMap(([id, item]) => {
        const concept = named.get(id);
        return concept ? [{ concept, ...item }] : [];
      });
    const closeness = (via: Via) => matchRank(via.match);
    const byLabel = (a: { concept: Concept }, b: { concept: Concept }) =>
      a.concept.label < b.concept.label ? -1 : a.concept.label > b.concept.label ? 1 : a.concept.id < b.concept.id ? -1 : 1;
    return {
      occupation,
      counterparts,
      skills: items(skills).sort((a, b) => closeness(a.via) - closeness(b.via) || Number(b.need === "essential") - Number(a.need === "essential") || byLabel(a, b)),
      activities: items(activities).sort((a, b) => closeness(a.via) - closeness(b.via) || b.tasks - a.tasks || byLabel(a, b)),
      tools: items(tools).sort((a, b) => closeness(a.via) - closeness(b.via) || Number(b.inDemand) - Number(a.inDemand) || Number(b.hot) - Number(a.hot) || byLabel(a, b)),
    };
  }
}

/**
 * One word that is also a label is thin evidence when it is very short, when only labels the
 * builder made carry it ("Testing", from "Testing software"), or when every label a source wrote
 * for it has a capital and the text writes it as none of them does: "go" for Go, "excel" for
 * Excel, "Did" for DID. A capital alone shows nothing, because every line starts with one. A label
 * that is itself lower case is an everyday word, and is that word however the text writes it.
 */
function weakWord(written: string, norm: string, concepts: Mention["concepts"]): boolean {
  if (norm.length <= 2) return true;
  // How an accent is encoded is not a different way of writing a word.
  const asWritten = written.normalize("NFC");
  return concepts
    .filter((concept) => concept.type !== "derived")
    .every((concept) => concept.matched !== concept.matched.toLowerCase() && concept.matched.normalize("NFC") !== asWritten);
}
