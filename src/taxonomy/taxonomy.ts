import { AppError } from "../shared/errors";
import { validConceptId } from "./ids.mjs";
import { asSeen, normalizeLabel, wordRuns, words } from "./normalize.mjs";
import type { TaxonomyStore } from "./store";
import {
  LABEL_TYPES,
  MATCH_TYPES,
  type Concept,
  type ConceptKind,
  type Edge,
  type MatchType,
  type Mention,
  type OccupationProfile,
  type TaxonomyInfo,
  type Via,
} from "./types";

/**
 * The longest text read in one call, for the labels in it or as a label itself. A resume line or a
 * job requirement is far shorter, and so is every label: the builder keeps none over 200 characters.
 */
export const MAX_MENTION_TEXT_CHARS = 20_000;
const MAX_DEPTH = 12;
/** The most concepts one page of `conceptPage` holds. */
export const MAX_CONCEPT_PAGE = 100;

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

  /**
   * Up to `limit` concepts of these kinds whose IDs come after `after`, in ID order: a page of the
   * concepts the vector index is built from (src/workflows/taxonomy-index.ts). "" starts at the first.
   */
  async conceptPage(after: string, kinds: readonly ConceptKind[], limit: number): Promise<Concept[]> {
    if (typeof after !== "string" || after.length > 200) throw new AppError("invalid", "a page starts after a concept ID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONCEPT_PAGE) throw new AppError("invalid", "a page holds one to a hundred concepts");
    if (kinds.length === 0) return [];
    return this.store.conceptPage(after, kinds, limit);
  }

  /** How many concepts of these kinds there are, or how many of them have IDs up to and including `upTo`. */
  async conceptCount(kinds: readonly ConceptKind[], upTo?: string): Promise<number> {
    if (upTo !== undefined && (typeof upTo !== "string" || upTo.length > 200)) throw new AppError("invalid", "a count runs up to a concept ID");
    if (kinds.length === 0) return 0;
    return this.store.conceptCount(kinds, upTo);
  }

  /**
   * The concepts that carry exactly this label, strongest label type first. A text longer than
   * any that is looked through for mentions is no label, and is not read: nothing carries it.
   */
  async lookup(label: string, opts: { kinds?: readonly ConceptKind[] } = {}): Promise<Mention["concepts"]> {
    if (label.length > MAX_MENTION_TEXT_CHARS) return [];
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

  /** Direct parents and children, used only to expand retrieval candidates, never as evidence. */
  async adjacent(id: string): Promise<Concept[]> {
    if (!validConceptId(id)) return [];
    const ids = [...new Set([
      ...(await this.store.from(id, ["broader"])).map((edge) => edge.dst),
      ...(await this.store.to(id, ["broader"])).map((edge) => edge.src),
    ])].filter((other) => other !== id).sort().slice(0, 32);
    const found = await this.get(ids);
    return ids.flatMap((other) => found.has(other) ? [found.get(other)!] : []);
  }

  /**
   * One occupation seen through both sources. What ESCO or O*NET says of the occupation itself
   * comes first; what they say of the occupations the official crosswalk relates it to follows,
   * closest match first, and every item says which occupation's record it comes from. Every
   * occupation the crosswalk relates is read. Those of one match type are in ID order, which says
   * nothing of them, so none is left out for coming later.
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
      .sort((a, b) => matchRank(a.match) - matchRank(b.match) || (a.concept.id < b.concept.id ? -1 : 1));

    const sources: { concept: Concept; via: Via }[] = [
      { concept: occupation, via: { occupation: occupation.id, match: null } },
      ...counterparts.map(({ concept, match }) => ({ concept, via: { occupation: concept.id, match } })),
    ];
    // Each source's occupations are read together, so the reads do not grow with the crosswalk,
    // which relates some O*NET occupations to dozens of ESCO's.
    const ids = (scheme: Concept["scheme"]) => sources.filter(({ concept }) => concept.scheme === scheme).map(({ concept }) => concept.id);
    const said = new Map<string, Edge[]>();
    for (const edge of [...(await this.store.fromAny(ids("esco"), ["essential", "optional"])), ...(await this.store.fromAny(ids("onet"), ["performs", "uses"]))]) {
      const known = said.get(edge.src);
      if (known) known.push(edge);
      else said.set(edge.src, [edge]);
    }
    const skills = new Map<string, { via: Via; need: "essential" | "optional" }>();
    const activities = new Map<string, { via: Via; tasks: number }>();
    const tools = new Map<string, { via: Via; inDemand: boolean; hot: boolean }>();
    // Sources are in order of closeness, so the first record to name a concept is the one kept.
    for (const { concept, via } of sources) {
      for (const edge of said.get(concept.id) ?? []) {
        if (edge.rel === "essential" || edge.rel === "optional") {
          if (!skills.has(edge.dst)) skills.set(edge.dst, { via, need: edge.rel });
        } else if (edge.rel === "performs") {
          if (!activities.has(edge.dst)) activities.set(edge.dst, { via, tasks: typeof edge.meta?.tasks === "number" ? edge.meta.tasks : 0 });
        } else if (edge.rel === "uses" && !tools.has(edge.dst)) tools.set(edge.dst, { via, inDemand: edge.meta?.inDemand === true, hot: edge.meta?.hot === true });
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
  // A word is written the way a person reads it. A character nobody sees is no part of that, in
  // the text or in a label, and neither is how an accent is encoded: the two are compared
  // decomposed.
  const word = asSeen(written);
  let decomposed: string | undefined;
  return concepts
    .filter((concept) => concept.type !== "derived")
    .every((concept) => {
      if (concept.matched === concept.matched.toLowerCase()) return false;
      const label = asSeen(concept.matched).normalize("NFD");
      // The word is someone else's text and can carry any number of marks, and decomposing puts
      // them in order in time that grows with the square of their number. So a word too long to
      // be the label is not decomposed to find that out. Decomposing never makes fewer characters
      // of a text, and a character is at most two units of length, so no way of writing the
      // label is more than twice as long as the label decomposed.
      if (word.length > 2 * label.length) return true;
      decomposed ??= word.normalize("NFD");
      return decomposed !== label;
    });
}
